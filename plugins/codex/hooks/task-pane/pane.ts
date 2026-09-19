import type { Elements } from 'claude-code'
import { cellWidth, clip, elapsed, tokens } from '../live-tool-row/format.ts'
import type { LiveView } from '../live-tool-row/view.ts'

const DOT: Record<string, string> = {
  running: 'cyan',
  'waiting-for-answer': 'magenta',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
}

const DONE = ['completed', 'failed', 'cancelled']
// Digits press from an empty composer, so a task is one keystroke away while
// the pane is open. Past nine, tasks are still listed but not switchable.
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

// The right-hand column: what the task costs, or what it produced once it ends.
function metric(data: LiveView): string {
  if (DONE.includes(data.status)) return data.files.length ? `${data.files.length} files` : 'no files'
  const usage = data.usage
  if (!usage.complete && !usage.inputTokens && !usage.outputTokens && !usage.cachedInputTokens) return 'tokens n/a'
  return `↑${tokens(usage.inputTokens)} ↓${tokens(usage.outputTokens)}`
}

// One line under a task, in the order the reader needs it: a question blocks the
// task, a command is what it is doing now, files are what it changed, and the
// last message is the fallback when nothing else is happening.
function detail(data: LiveView): { text: string; color?: string } {
  if (data.pendingQuestion) return { text: `? ${data.pendingQuestion.text}`, color: 'magenta' }
  const command = data.activeCommands.find(active => !active.agentThreadId)
  if (command) return { text: `$ ${command.command}` }
  if (data.files.length) return { text: `✎ ${data.files.slice(0, 2).map(file => file.path).join('  ')}` }
  return { text: data.lastMessage?.text ?? data.tail.at(-1)?.text ?? '' }
}

export function paneBody(
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>,
  jobs: LiveView[],
  columns: number,
  now: number,
  selected: string | null,
  onSelect: (jobId: string) => void,
) {
  const { Box, Text, Button } = ui
  const width = Math.max(24, columns)
  if (!jobs.length) {
    return Box({ children: [Text({ dimColor: true, children: 'No tasks dispatched from this session yet.' })] })
  }
  const running = jobs.filter(data => !DONE.includes(data.status)).length
  const focused = jobs.find(data => data.jobId === selected) ?? null
  // With one task there is nothing to switch between, so the row keeps its
  // detail line and the digit bar stays out of the way.
  const single = jobs.length === 1

  const rows = jobs.map((data, index) => {
    const isFocused = focused?.jobId === data.jobId
    const right = `${data.status} · ${elapsed(data.startedAt, data.endedAt ? Date.parse(data.endedAt) : now)} · ${metric(data)}`
    const executor = data.executor && data.executor.kind !== 'codex' ? data.executor.label : ''
    const index1 = index < HOTKEYS.length && !single ? `${index + 1} ` : ''
    const head = clip(`${index1}${data.label}${executor ? ` · ${executor}` : ''}`, Math.max(8, width - cellWidth(right) - 4))
    const line = detail(data)
    // Collapsed rows drop their detail line so several running tasks stay on
    // screen; the one in focus is the only one that spends the rows.
    const showDetail = single || isFocused || !focused
    const tail = isFocused && !single
      ? data.tail.slice(-6).map(event => clip(`${event.type.replace(/^(message|reasoning)\./, '')} ${event.text}`, width - 2))
      : []
    return Box({ flexDirection: 'column', children: [
      Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
        Box({ flexDirection: 'row', children: [
          Text({ color: DOT[data.status] ?? 'gray', children: isFocused && !single ? '▸ ' : '● ' }),
          Text({ bold: isFocused || !DONE.includes(data.status), children: head }),
        ] }),
        Text({ children: right }),
      ] }),
      ...(showDetail && line.text ? [Box({ paddingLeft: 2, children: [Text({
        color: line.color, wrap: 'wrap',
        children: clip(line.text, Math.max(8, (width - 2) * 2)),
      })] })] : []),
        ...tail.filter(Boolean).map(text => Box({ paddingLeft: 4, children: [Text({ wrap: 'truncate-end', children: text })] })),
    ] })
  })

  // The digit bar is the switch: one plain button per task, pressed by its
  // number from the prompt without focusing the pane first.
  const switcher = single ? [] : [Box({ flexDirection: 'row', gap: 1, children: [
    Text({ dimColor: true, children: 'switch' }),
    ...jobs.slice(0, HOTKEYS.length).map((data, index) => Button({
      key: `codex_task_${data.jobId}`,
      label: HOTKEYS[index]!,
      hotkey: HOTKEYS[index]!,
      plain: true,
      dimColor: focused?.jobId !== data.jobId,
      onPress: () => onSelect(data.jobId),
    })),
  ] })]

  return Box({ flexDirection: 'column', gap: 1, children: [
    Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
      Text({ children: `${running} running · ${jobs.length - running} finished` }),
      ...(switcher.length ? switcher : []),
    ] }),
    ...rows,
  ] })
}
