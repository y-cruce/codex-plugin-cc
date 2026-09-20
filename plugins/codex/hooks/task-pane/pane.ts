import type { Elements } from 'claude-code'
import { clip } from '../live-tool-row/format.ts'
import { isOver, liveTree } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'

const DOT: Record<string, string> = {
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

export function paneBody(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Button'>,
  jobs: LiveView[],
  columns: number,
  rows: number,
  now: number,
  selected: string | null,
  onSelect: (jobId: string) => void,
  background?: string,
) {
  const { Box, Text, Button } = ui
  const width = Math.max(24, columns)
  if (!jobs.length) {
    return Box({ flexDirection: 'column', backgroundColor: background, width: columns, height: rows, children: [
      Text({ dimColor: true, children: 'No tasks dispatched from this session yet.' }),
      Box({ flexGrow: 1 }),
    ] })
  }
  // One task is always in view: the height belongs to its trace, not to a list
  // of tasks each spending two rows on itself.
  const focused = jobs.find(data => data.jobId === selected) ?? jobs[0]!

  // The list sits at the foot, a task to a row, because the pane follows the end
  // of a growing trace: whatever is last stays in view, and a row across the top
  // does not -- it scrolled away as soon as the task had anything to say. A row
  // each also gives a name room to be read rather than cut to a dozen cells.
  const list = jobs.map((data, index) => {
    const isFocused = data.jobId === focused.jobId
    const executor = data.executor && data.executor.kind !== 'codex' ? ` · ${data.executor.label}` : ''
    const state = isOver(data) ? data.status : data.status === 'waiting-for-answer' ? 'waiting' : data.status
    return Box({ flexDirection: 'row', children: [
      Text({ color: DOT[data.status] ?? 'gray', children: isFocused ? '▸ ' : '  ' }),
      Button({
        key: `codex_tab_${data.jobId}`,
        label: clip(`${index + 1} ${data.label}${executor}`, Math.max(8, width - state.length - 7)),
        plain: true, dimColor: !isFocused, onPress: () => onSelect(data.jobId),
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
  const body = Math.max(4, rows - list.length - 3)
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
  ] })
}
