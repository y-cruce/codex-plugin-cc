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

export function paneBody(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Button'>,
  jobs: LiveView[],
  columns: number,
  rows: number,
  now: number,
  selected: string | null,
  onSelect: (jobId: string) => void,
) {
  const { Box, Text, Button } = ui
  const width = Math.max(24, columns)
  if (!jobs.length) {
    return Box({ children: [Text({ dimColor: true, children: 'No tasks dispatched from this session yet.' })] })
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
    const label = clip(`${index + 1} ${data.label}${executor}`, isFocused ? focusedWidth : share)
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
    lastMessage: focused.lastMessage ? { ...focused.lastMessage, text: clip(focused.lastMessage.text, 2000) } : null,
    tail: focused.tail.map(event => ({ ...event, text: clip(event.text, 1000) })),
  }

  // The body is the same card the follow row draws: it already groups commands,
  // files, questions and messages, and drops the bookkeeping events.
  const tabRows = Math.max(1, Math.ceil((focusedWidth + (jobs.length - 1) * share + jobs.length * 5) / width))
  const body = Math.max(4, rows - tabRows - (jobs.length > 1 ? 2 : 1))
  return Box({ flexDirection: 'column', children: [
    Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: tabs }),
    Box({ marginTop: 1, children: [liveTree(ui, trimmed, width, now, body)] }),
    ...(jobs.length > 1 ? [Text({ dimColor: true, dimColor: true, children: `${running} running · /codex:tasks <n> to switch` })] : []),
  ] })
}
