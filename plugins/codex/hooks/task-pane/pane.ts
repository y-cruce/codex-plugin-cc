import type { Elements } from 'claude-code'
import { cellWidth, clip } from '../live-tool-row/format.ts'
import { isOver, liveTree } from '../live-tool-row/view.ts'
import type { Fold, LiveView } from '../live-tool-row/view.ts'

export type PaneView = LiveView & { queuedCount?: number }

export type PaneComposer = {
  Input: Elements['terminal']['Input']
  key: string
  value: string
  rows?: number
  focused: boolean
  sending?: 'steer' | 'queue' | 'interrupt'
  notice?: { text: string; error?: boolean }
  onInput: (value: string) => void
  onSubmit: (value: string) => void
  onQueue: () => void
  onInterrupt: () => void
}

const DOT: Record<string, string> = {
  queued: 'gray',
  running: 'cyan',
  'waiting-for-answer': 'magenta',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const DONE = ['completed', 'failed', 'cancelled']

// Keep individual messages readable without losing their line breaks.
function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

// A tab only has to be recognizable, so it may lose its end -- but a cut made
// mid-word ("interrupt semant") reads as noise rather than as a cut. Land it on
// a word boundary where there is one worth keeping, and say that it happened.
function tabLabel(text: string, columns: number): string {
  if (clip(text, columns) === text) return text
  const room = clip(text, Math.max(1, columns - 1))
  const cut = room.lastIndexOf(' ')
  return `${(cut > columns / 2 ? room.slice(0, cut) : room).trimEnd()}…`
}

// A row is a task's name and whatever else fits beside it: the model and the
// rung go first when the width runs out, then the executor, each dropped whole
// rather than cut in half -- a task is listed to be recognized by name, and a
// name followed by half a model name is noise.
function taskLabel(position: number, data: LiveView, executor: string, room: number): string {
  const name = `${position} ${data.label}`
  const config = [data.model, data.effort].filter(Boolean).join(' ')
  const rows = [name, `${name}${executor}`, `${name}${executor}${config ? ` · ${config}` : ''}`]
  return clip(rows.filter(row => clip(row, room) === row).at(-1) ?? name, room)
}

const PANE_PADDING_LEFT = 1
const PANE_PADDING_RIGHT = 2
const SUBMIT_LABEL = 'steer'
const FULL_HINT = '⏎ steer · ctrl+x ⏎ queue · ctrl+x ctrl+s interrupt'
const SHORT_HINT = '⏎ steer · ^x⏎ queue · ^x^s interrupt'
const HINT_SINGLE_WIDTH = cellWidth(' ⏎ steer')
const HINT_MULTI_WIDE = cellWidth(' ⏎ steer · shift+⏎ new line')
const HINT_MULTI_NARROW = cellWidth(' ⏎ steer · \\⏎ new line')
const INPUT_MIN_COLUMNS = 12

function inputWrapColumns(columns: number, multiline: boolean): number {
  let hintWidth = HINT_SINGLE_WIDTH
  if (multiline) {
    if (columns - HINT_MULTI_WIDE >= columns / 2) hintWidth = HINT_MULTI_WIDE
    else if (columns - HINT_MULTI_NARROW >= columns / 2) hintWidth = HINT_MULTI_NARROW
  }
  const visibleColumns = Math.max(1, columns - PANE_PADDING_LEFT - PANE_PADDING_RIGHT - 2)
  return Math.min(visibleColumns, Math.max(1, Math.max(INPUT_MIN_COLUMNS, columns - hintWidth) - 1))
}

function wrappedLineCount(text: string, wrapCols: number): number {
  const cols = Math.max(1, wrapCols)
  let total = 0
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line) {
      total += 1
      continue
    }
    let lines = 1
    let col = 0
    for (const token of line.match(/\s+|\S+/g) ?? []) {
      if (/^\s+$/.test(token)) {
        for (const ch of token) {
          const w = Math.max(1, cellWidth(ch))
          if (col > 0 && col + w > cols) {
            lines += 1
            col = 0
          }
          col += w
        }
        continue
      }
      const w = cellWidth(token)
      if (col + w <= cols) {
        col += w
      } else if (w <= cols) {
        if (col > 0) lines += 1
        col = w
      } else {
        for (const ch of token) {
          const cw = Math.max(1, cellWidth(ch))
          if (col > 0 && col + cw > cols) {
            lines += 1
            col = 0
          }
          col += cw
        }
      }
    }
    total += lines
  }
  return Math.max(1, total)
}

export function composerRows(text: string, columns: number, rows: number, listLength: number): number {
  const maxRows = Math.max(1, Math.min(Math.floor(rows / 2), rows - listLength - 7))
  if (wrappedLineCount(text, inputWrapColumns(columns, false)) <= 1) return 1
  return Math.min(maxRows, Math.max(2, wrappedLineCount(text, inputWrapColumns(columns, true))))
}

export function paneBody(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Markdown' | 'Button'>,
  threads: PaneView[],
  columns: number,
  rows: number,
  now: number,
  selected: string | null,
  onSelect: (recordId: string) => void,
  background?: string,
  fold?: Omit<Fold, 'Button'>,
  composer?: PaneComposer,
) {
  const { Box, Text, Button } = ui
  const width = Math.max(1, columns - PANE_PADDING_LEFT - PANE_PADDING_RIGHT)
  if (!threads.length) {
    return Box({ flexDirection: 'column', backgroundColor: background, width: columns, height: rows, paddingLeft: PANE_PADDING_LEFT, paddingRight: PANE_PADDING_RIGHT, children: [
      Text({ dimColor: true, children: 'No tasks dispatched from this session yet.' }),
      Box({ flexGrow: 1 }),
    ] })
  }
  const focused = threads.find(data => (data.recordId ?? data.jobId) === selected) ?? threads[0]!

  // The list sits at the foot, a thread to a row, because the pane follows the end
  // of a growing trace: whatever is last stays in view, and a row across the top
  // does not -- it scrolled away as soon as the task had anything to say. A row
  // each also gives a name room to be read rather than cut to a dozen cells.
  const list = threads.map((data, index) => {
    const recordId = data.recordId ?? data.jobId
    const isFocused = recordId === (focused.recordId ?? focused.jobId)
    const executor = ` · ${data.executor?.label ?? 'Codex'}`
    const status = data.status === 'waiting-for-answer' ? 'waiting' : data.status
    const queued = data.queuedCount ? `${data.queuedCount} queued` : ''
    const state = [status === 'queued' && queued ? queued : status, status !== 'queued' ? queued : '', data.foreign ? 'other' : ''].filter(Boolean).join(' · ')
    const label = taskLabel(index + 1, data, executor, Math.max(8, width - cellWidth(state) - 7))
    return Box({ flexDirection: 'row', children: [
      Text({ color: DOT[data.status] ?? 'gray', children: isFocused ? '▸ ' : '  ' }),
      Button({
        key: `codex_tab_${recordId}`,
        label,
        children: [label, Text({ dimColor: true, children: ` · ${state}` })],
        // No `autoFocus`: the ring is drawn inverse, so starting it on the task
        // in view leaves a highlighted row sitting there when nobody is walking
        // the list. The marker already says which task the trace belongs to.
        plain: true, dimColor: !isFocused, onPress: () => onSelect(recordId),
      }),
    ] })
  })

  // Bound each message and event so one long answer does not fill the trace.
  const trimmed: LiveView = {
    ...focused,
    // The card draws its running commands above the trace as a summary, which
    // earns its place in a row clipped to a few lines. The pane draws the whole
    // trace, where every one of them is already a row of its own, in the order
    // it was issued: drawn twice, the pair reads as events out of order.
    activeCommands: [],
    lastMessage: focused.lastMessage ? { ...focused.lastMessage, text: shorten(focused.lastMessage.text, 40000) } : null,
    tail: focused.tail.map(event => ({ ...event, text: shorten(event.text, 40000) })),
  }

  // The body is the same card the follow row draws: it already groups commands,
  // files, questions and messages, and drops the bookkeeping events.
  const inputRows = composer ? Math.max(1, composer.rows ?? 1) : 0
  const errorNotice = composer && !composer.sending && composer.notice?.error ? composer.notice.text : null
  const body = Math.max(4, rows - list.length - (composer ? inputRows + 5 + (errorNotice ? 1 : 0) : 4))
  // The whole trace is drawn and the pane scrolls it; the visible height only
  // sets how much of it shows at once.
  const TAIL = 200
  const composerBlock = (() => {
    if (!composer) return []
    const inputWidth = Math.max(1, width - 2)
    const hintText = composer.sending
      ? clip(`Sending (${composer.sending})…`, inputWidth)
      : cellWidth(FULL_HINT) <= inputWidth ? FULL_HINT : clip(SHORT_HINT, inputWidth)
    // Claude Code 2.1.327's Input always draws ` ⏎ <submitLabel>` beside the
    // field while focused. Padding the focused placeholder to the clipped
    // viewport pushes that suffix past overflow:hidden while empty; once
    // the user types, placeholder disappears and ` ⏎ steer` appears beside text.
    const placeholder = composer.focused
      ? `${hintText}${' '.repeat(Math.max(0, inputWidth - cellWidth(hintText)))}`
      : hintText
    const rule = '─'.repeat(width)
    // Match Claude Code's main prompt: top/bottom promptBorder rules and
    // leading ❯. Zero-width action buttons share the bottom rule row while
    // focused so they take no extra line; error text renders below only on error.
    return [
      Text({ color: 'promptBorder', children: rule }),
      Box({ flexDirection: 'row', width, overflow: 'hidden', children: [
        Box({ flexShrink: 0, alignSelf: 'flex-start', children: [
          Text({ dimColor: !composer.focused || Boolean(composer.sending), children: '❯ ' }),
        ] }),
        Box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: [
          Box({
            flexDirection: 'column',
            flexShrink: 0,
            ...(composer.focused ? { minWidth: Math.max(columns, inputWidth + HINT_SINGLE_WIDTH) } : { width: inputWidth }),
            children: [
              composer.Input({
                key: composer.key,
                value: composer.value,
                placeholder,
                submitLabel: SUBMIT_LABEL,
                rows: inputRows,
                onInput: composer.onInput,
                onSubmit: composer.onSubmit,
              }),
            ],
          }),
        ] }),
      ] }),
      Box({ flexDirection: 'row', width, overflow: 'hidden', children: [
        Text({ color: 'promptBorder', children: rule }),
        ...(composer.focused ? [
          Button({ key: 'codex_act_queue', plain: true, label: '', action: 'chat:queueSubmit', onPress: composer.onQueue }),
          Button({ key: 'codex_act_interrupt', plain: true, label: '', action: 'chat:sendNow', onPress: composer.onInterrupt }),
        ] : []),
      ] }),
      ...(errorNotice ? [Text({ color: 'red', wrap: 'truncate-end', children: clip(errorNotice, width) })] : []),
    ]
  })()
  // The pane's own ground is a mid grey the engine paints, which reads as a slab
  // in the middle of a dark session. There is no value meaning "the terminal's
  // own", so the colour is a plugin option; empty keeps the engine's.
  // The trace takes the height that is going: a shorter one leaves the ground
  // showing to the foot of the pane rather than the mid grey the engine paints
  // under an element that stops early.
  // Tab walks the pane's buttons in tree order and keeps its place as a count,
  // not as an element. With the trace first, a fold coming or going above the
  // list moved that count onto another button without a move being made:
  // switching to a task whose trace has more folds left the ring on a fold.
  // The list goes first in the tree and column-reverse draws it at the foot,
  // so its rows keep their places whatever the trace does.
  return Box({ flexDirection: 'column-reverse', backgroundColor: background, width: columns, minHeight: rows, paddingLeft: PANE_PADDING_LEFT, paddingRight: PANE_PADDING_RIGHT, children: [
    // Without the composer, the list would sit against the pane's bottom edge,
    // which the engine draws in its own grey.
    ...(composer ? [] : [Text({ children: ' ' })]),
    Box({ flexDirection: 'column', children: [...list, ...composerBlock] }),
    // A blank row, not a margin: a margin belongs to no element, so the mid grey
    // the engine paints under the pane is what shows through it.
    Text({ children: ' ' }),
    Box({ flexGrow: 1, children: [liveTree(ui, trimmed, width, now, body, undefined, TAIL, true, fold && { ...fold, Button })] }),
  ] })
}
