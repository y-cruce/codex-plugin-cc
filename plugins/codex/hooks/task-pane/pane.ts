import type { Elements } from 'claude-code'
import { clip } from '../live-tool-row/format.ts'
import { isOver, liveTree } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'

const DOT: Record<string, string> = {
  queued: 'gray',
  running: 'cyan',
  'waiting-for-answer': 'magenta',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const DONE = ['completed', 'failed', 'cancelled']

// The engine refuses a text child longer than 10000 characters and draws its own
// body instead, so what reaches it is bounded -- per line, since Markdown lands
// a line per child and a whole answer is worth reading. Cutting is not clip's
// job here either: clip folds every newline into a space, and a message that
// loses its line breaks loses its Markdown with them.
const LINE = 8000
function shorten(text: string, limit: number): string {
  const bounded = text.length <= limit ? text : `${text.slice(0, limit)}\u2026`
  return bounded.split('\n').map(line => line.length <= LINE ? line : `${line.slice(0, LINE)}\u2026`).join('\n')
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
// A thread is named by the round that opened it. `label` follows the newest
// round, which says what the thread is doing rather than what it is for: after
// three rounds a row read "probe round three" and nothing on screen still said
// what had been asked first. Neither executor offers a thread name of its own
// -- Codex's is set by whichever client bothers to generate one, and Qoder
// sends none -- so the opening brief's name is what there is.
function taskLabel(position: number, data: LiveView, executor: string, room: number): string {
  const name = `${position} ${data.rounds?.[0]?.label ?? data.label}`
  const config = [data.model, data.effort].filter(Boolean).join(' ')
  const rows = [name, `${name}${executor}`, `${name}${executor}${config ? ` · ${config}` : ''}`]
  return clip(rows.filter(row => clip(row, room) === row).at(-1) ?? name, room)
}

export function paneBody(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Button'>,
  threads: LiveView[],
  columns: number,
  rows: number,
  now: number,
  selected: string | null,
  onSelect: (recordId: string) => void,
  background?: string,
) {
  const { Box, Text, Button } = ui
  const width = Math.max(24, columns)
  if (!threads.length) {
    return Box({ flexDirection: 'column', backgroundColor: background, width: columns, height: rows, children: [
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
    const executor = data.executor && data.executor.kind !== 'codex' ? ` · ${data.executor.label}` : ''
    const state = `${isOver(data) ? data.status : data.status === 'waiting-for-answer' ? 'waiting' : data.status}${data.foreign ? ' · other' : ''}`
    return Box({ flexDirection: 'row', children: [
      Text({ color: DOT[data.status] ?? 'gray', children: isFocused ? '▸ ' : '  ' }),
      Button({
        key: `codex_tab_${recordId}`,
        label: taskLabel(index + 1, data, executor, Math.max(8, width - state.length - 7)),
        // No `autoFocus`: the ring is drawn inverse, so starting it on the task
        // in view leaves a highlighted row sitting there when nobody is walking
        // the list. The marker already says which task the trace belongs to.
        plain: true, dimColor: !isFocused, onPress: () => onSelect(recordId),
      }),
      Text({ dimColor: true, children: ` · ${state}` }),
    ] })
  })

  // The engine refuses a text child longer than 10000 characters and draws its
  // own body instead, so every string handed to liveTree is cut down first: a
  // pane shows what a task is doing, not a whole answer.
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
  const body = Math.max(4, rows - list.length - 4)
  // The whole trace is drawn and the pane scrolls it; the visible height only
  // sets how much of it shows at once.
  const TAIL = 200
  // The pane's own ground is a mid grey the engine paints, which reads as a slab
  // in the middle of a dark session. There is no value meaning "the terminal's
  // own", so the colour is a plugin option; empty keeps the engine's.
  // The trace takes the height that is going: a shorter one leaves the ground
  // showing to the foot of the pane rather than the mid grey the engine paints
  // under an element that stops early.
  return Box({ flexDirection: 'column', backgroundColor: background, width: columns, minHeight: rows, children: [
    Box({ flexGrow: 1, children: [liveTree(ui, trimmed, width, now, body, undefined, TAIL, true)] }),
    // A blank row, not a margin: a margin belongs to no element, so the mid grey
    // the engine paints under the pane is what shows through it.
    Text({ children: ' ' }),
    ...list,
    // The list would otherwise sit against the pane's bottom edge, which the
    // engine draws in its own grey.
    Text({ children: ' ' }),
  ] })
}
