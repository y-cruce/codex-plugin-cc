import type { Elements } from 'claude-code'
import { clip } from '../live-tool-row/format.ts'
import { liveTree } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'

const DOT: Record<string, string> = {
  running: 'cyan',
  'waiting-for-answer': 'magenta',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const DONE = ['completed', 'failed', 'cancelled']

// Cutting to a length is not clip's job here: clip flattens every newline into
// a space, and a message that loses its line breaks loses its Markdown with
// them -- headings and tables arrive as one run of pipes.
function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\u2026`
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
    return Box({ backgroundColor: background, width: columns, minHeight: rows, children: [
      Text({ dimColor: true, children: 'No tasks dispatched from this session yet.' }),
    ] })
  }
  // One task is always in view: the height belongs to its trace, not to a list
  // of tasks each spending two rows on itself.
  const focused = jobs.find(data => data.jobId === selected) ?? jobs[0]!
  const running = jobs.filter(data => !DONE.includes(data.status)).length
  // Tabs share the width by how many there are, and the one in view gets more
  // of it: the others only have to be recognizable, it has to be readable.
  const share = Math.min(30, Math.max(8, Math.floor((width - jobs.length * 3) / jobs.length)))
  const focusedWidth = Math.min(44, share + 10)

  // Tabs across the top, numbered so `/codex:tasks 2` names one of them. Each is
  // a button too: Tab walks them while the pane has the keyboard.
  const tabs = jobs.map((data, index) => {
    const isFocused = data.jobId === focused.jobId
    const executor = data.executor && data.executor.kind !== 'codex' ? ` · ${data.executor.label}` : ''
    const label = tabLabel(`${index + 1} ${data.label}${executor}`, isFocused ? focusedWidth : share)
    return Box({ flexDirection: 'row', children: [
      Text({ color: DOT[data.status] ?? 'gray', children: isFocused ? '▸' : '·' }),
      Button({ key: `codex_tab_${data.jobId}`, label, plain: true, dimColor: !isFocused, onPress: () => onSelect(data.jobId) }),
    ] })
  })

  // The engine refuses a text child longer than 10000 characters and draws its
  // own body instead, so every string handed to liveTree is cut down first: a
  // pane shows what a task is doing, not a whole answer.
  const trimmed: LiveView = {
    ...focused,
    lastMessage: focused.lastMessage ? { ...focused.lastMessage, text: shorten(focused.lastMessage.text, 2000) } : null,
    tail: focused.tail.map(event => ({ ...event, text: shorten(event.text, 1000) })),
  }

  // The body is the same card the follow row draws: it already groups commands,
  // files, questions and messages, and drops the bookkeeping events.
  const tabRows = Math.max(1, Math.ceil((focusedWidth + (jobs.length - 1) * share + jobs.length * 5) / width))
  const body = Math.max(4, rows - tabRows - (jobs.length > 1 ? 2 : 1))
  // The whole trace is drawn and the pane scrolls it; the visible height only
  // sets how much of it shows at once.
  const TAIL = 200
  // The pane's own ground is a mid grey the engine paints, which reads as a slab
  // in the middle of a dark session. There is no value meaning "the terminal's
  // own", so the colour is a plugin option; empty keeps the engine's.
  return Box({ flexDirection: 'column', backgroundColor: background, width: columns, minHeight: rows, children: [
    Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: tabs }),
    Box({ marginTop: 1, children: [liveTree(ui, trimmed, width, now, body, undefined, TAIL)] }),
    ...(jobs.length > 1 ? [Text({ dimColor: true, children: `${running} running · /codex:tasks <n> to switch` })] : []),
  ] })
}
