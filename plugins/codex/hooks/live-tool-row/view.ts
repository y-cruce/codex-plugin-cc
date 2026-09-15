import type { Elements, TextProps } from 'claude-code'
import { clean, clip, duration, elapsed, shortPath, tailLimit, tokens, waiting } from './format.ts'
import type { Terminal } from './format.ts'
import { markdown } from './markdown.ts'
export { clip } from './format.ts'

export type LiveView = {
  schemaVersion: 1
  jobId: string
  label: string
  status: 'running' | 'waiting-for-answer' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  endedAt: string | null
  threadId: string | null
  turnId: string | null
  activeCommands: { itemId: string; command: string; cwd: string; startedAt: string; agentThreadId?: string }[]
  lastMessage: { kind: 'assistant' | 'reasoning'; text: string; at: string } | null
  files: { path: string; kind: 'add' | 'update' | 'delete'; additions: number | null; deletions: number | null }[]
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean }
  pendingQuestion: { requestId: string; text: string; openedAt: string; expiresAt: string | null } | null
  history: { committedSeq: string; continuity: 'complete' | 'partial' | 'legacy' }
  subAgents?: { threadId: string; path: string; status: string; endedAt: string | null; lastActivity?: string; startedSeq?: string }[]
  tail: { seq: string; positionSeq?: string; at: string; type: string; text: string; exitCode?: number | null; durationMs?: number | null; agent?: string; agentThreadId?: string }[]
}

const colors = { running: 'cyan', 'waiting-for-answer': 'magenta', completed: 'green', failed: 'red', cancelled: 'gray' }
const PROSE = /^(message|reasoning|question|director|control|source|plan|tool\.progress)/

// Group before applying the display limit; persisted positions survive tail
// replacement and summaries remain visible after their source rows expire.
export function agentSummaries(data: LiveView) {
  return (data.subAgents ?? []).map(agent => {
    const belongs = (event: LiveView['tail'][number]) => event.agentThreadId
      ? event.agentThreadId === agent.threadId
      : event.agent === agent.path || event.text.startsWith(`⇢ sub-agent ${agent.path} `)
    const events = data.tail.filter(belongs)
    const latest = events.filter(event => event.agent && (!agent.endedAt || event.at <= agent.endedAt))
      .reduce<LiveView['tail'][number] | undefined>((last, event) => !last || BigInt(event.seq) > BigInt(last.seq) ? event : last, undefined)
    const activity = (agent.lastActivity ?? latest?.text.replace(`[${agent.path}] `, '') ?? '').replace(/^(assistant|reasoning):\s*/, '')
    const status = agent.status === 'completed' ? 'done' : ['failed', 'interrupted'].includes(agent.status) ? 'failed' : 'running'
    const index = agent.startedSeq ? data.tail.findLastIndex(event => BigInt(event.positionSeq ?? event.seq) < BigInt(agent.startedSeq!)) + 1 : data.tail.findIndex(belongs)
    return { index, text: `⇢ ${agent.path} · ${status}${activity ? ` · ${activity}` : ''}` }
  })
}

export function statusText(jobs: LiveView[], now: number): string | undefined {
  const running = jobs.filter(data => data.status === 'running' || data.status === 'waiting-for-answer')
  if (!running.length) return undefined
  return `Codex · ${running.length} running · ${running.map(data => {
    const command = data.activeCommands.find(command => !command.agentThreadId)
    const detail = command ? `$ ${clip(command.command, 30)}`
      : data.files.length ? `✎ ${data.files.length} files` : clip(data.tail.at(-1)?.text ?? '', 30)
    return `${clip(data.label, 80)} ${elapsed(data.startedAt, now)}${detail ? ` ${detail}` : ''}`
  }).join(' · ')}`
}

export function terminalTree(ui: Pick<Elements['terminal'], 'Box' | 'Text'>, terminal: Terminal, label: string, columns: number, agents: string[] = []) {
  const { Box, Text } = ui
  const status = { DONE: 'completed', FAILED: 'failed', QUESTION: 'question', NOTIFIED: 'notified', TIMEOUT: 'paused', STALLED: 'stalled' }[terminal.kind]
  const color = terminal.kind === 'QUESTION' ? 'magenta' : terminal.kind === 'NOTIFIED' ? 'cyan' : undefined
  const dimColor = terminal.kind === 'TIMEOUT' || terminal.kind === 'STALLED'
  return Box({ flexDirection: 'column', children: [
    Text({ color, dimColor, wrap: 'truncate-end', children: clip(`● Codex · ${label} · ${status}`, columns) }),
    ...agents.map(text => Box({ paddingLeft: 2, children: Text({ dimColor: true, wrap: 'truncate-end', children: clip(text, Math.max(1, columns - 2)) }) })),
    ...(terminal.kind !== 'TIMEOUT' && terminal.text ? [Box({ paddingLeft: 2, width: columns, children: Text({
      dimColor, wrap: 'wrap', children: clean(terminal.text),
    }) })] : []),
  ] })
}

export function liveTree(ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'>, data: LiveView, columns: number, now: number, rows?: number, result?: { kind: 'DONE' | 'FAILED' }) {
  const { Box, Text } = ui
  const status = result ? result.kind === 'DONE' ? 'completed' : 'failed' : data.status
  const stalled = data.status === 'running' && data.tail.length ? now - Date.parse(data.tail.at(-1)!.at) : 0
  const header = [
    { text: '● Codex · ' },
    { text: data.label, bold: true },
    { text: ` · ${status}`, color: colors[status] },
    { text: ` · ${elapsed(data.startedAt, data.endedAt ? Date.parse(data.endedAt) : now)} · ${result ? `${data.files.length} files` : `↑${tokens(data.usage.inputTokens)} ↓${tokens(data.usage.outputTokens)} tokens`}` },
    { text: !result && stalled > 120000 ? ` · no progress ${Math.floor(stalled / 60000)}m` : '', dimColor: true },
  ]
  // Clip once across styled segments, preserving the terminal cell budget.
  let remaining = Array.from(clip(header.map(part => part.text).join(''), columns)).length
  const lines = [Text({ color: status === 'waiting-for-answer' ? 'magenta' : undefined, children: header.map(({ text, ...style }) => {
    const chars = Array.from(clip(text, columns))
    const shown = chars.slice(0, remaining).join('')
    remaining = Math.max(0, remaining - chars.length)
    return Text({ ...style, children: shown })
  }) })]
  const heading = lines.pop()!
  columns = Math.max(1, columns - 2)
  const tree = () => Box({ flexDirection: 'column', children: [heading, Box({ flexDirection: 'column', paddingLeft: 2, children: Box({ flexDirection: 'column', width: columns, children: lines }) })] })
  const add = (text: string, props: TextProps = {}) => lines.push(Text({ ...props, wrap: 'truncate-end', children: clip(text, columns) }))
  const prose = (text: string, props: TextProps = {}) => lines.push(Text({ ...props, wrap: 'wrap', children: clean(text) }))
  const files = () => {
    for (const file of data.files.slice(0, 3)) {
      const counts = ` (+${file.additions ?? '?'} −${file.deletions ?? '?'})`
      add(`✎ ${shortPath(file.path, Math.max(1, columns - counts.length - 2))}${counts}`)
    }
    if (data.files.length > 3) add(`+${data.files.length - 3} more`, { dimColor: true })
  }
  if (result) {
    if (data.lastMessage?.kind === 'reasoning') prose(data.lastMessage.text, { dimColor: true })
    else if (data.lastMessage) lines.push(...markdown(ui, data.lastMessage.text, {}, '', columns))
    files()
    for (const agent of agentSummaries(data)) add(agent.text, { dimColor: true })
    return tree()
  }
  if (data.pendingQuestion) {
    prose(`? ${data.pendingQuestion.text}`, { color: 'magenta', bold: true })
    add(waiting(data.pendingQuestion.openedAt, data.pendingQuestion.expiresAt, now), { dimColor: true })
  }
  for (const command of data.activeCommands.filter(command => !command.agentThreadId).slice(0, 3)) {
    lines.push(Text({ wrap: 'truncate-middle', children: `$ ${clean(command.command).replaceAll('\n', ' ')} · ${elapsed(command.startedAt, now)}` }))
  }
  files()
  const warnings = new Set<string>()
  const agents = agentSummaries(data)
  const tail = data.tail.filter(event => {
    if (event.agent || event.agentThreadId || event.type === 'agent.activity') return false
    if (event.text.startsWith('⇢ sub-agent ')) return false
    if (event.type === 'job.started') return false
    if (event.type === 'question.closed') return false
    if ((event.type === 'tool.started' || event.type === 'tool.completed') && event.text.startsWith('dynamicToolCall')) return false
    if (event.type === 'source.warning') {
      if (warnings.has(event.text)) return false
      warnings.add(event.text)
    }
    return true
  }).slice(-tailLimit(rows))
  const grouped: LiveView['tail'] = []
  for (const agent of agents.filter(agent => agent.index < 0)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
  data.tail.forEach((event, index) => {
    for (const agent of agents.filter(agent => agent.index === index)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
    if (tail.includes(event)) grouped.push(event)
  })
  for (const agent of agents.filter(agent => agent.index === data.tail.length)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
  if (grouped.length) lines.push(Text({ children: ' ' }))
  const kind = data.lastMessage?.kind
  const typeOf = (event: LiveView['tail'][number]) => String(event.type ?? '')
  const newest = kind ? grouped.findLastIndex(event => !event.agent && typeOf(event).startsWith(kind === 'assistant' ? 'message' : 'reasoning')) : -1
  grouped.forEach((event, index) => {
    const type = typeOf(event)
    if (type === 'agent.summary') return add(event.text, { dimColor: true })
    if (type === 'question.resolved') {
      prose('→ answer delivered', { color: 'cyan' })
      return
    }
    if (type.startsWith('command')) {
      const completed = type === 'command.completed'
      const color = completed ? event.exitCode == null ? 'gray' : event.exitCode === 0 ? 'green' : 'red' : undefined
      const suffix = completed && event.durationMs != null ? ` · ${duration(event.durationMs)}` : ''
      const [command, ...output] = clean(event.text).split(' ⏎ ')
      lines.push(Text({ wrap: 'truncate-middle', children: [
        Text({ color, children: completed ? '● $ ' : '$ ' }),
        Text({ children: command!.replace(/^\$\s*/, '').replaceAll('\n', ' ') + suffix }),
      ] }))
      if (completed && event.exitCode != null && event.exitCode !== 0 && output.length) {
        lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  ${output.join(' ⏎ ').replaceAll('\n', ' ')}` }))
      }
      return
    }
    const prefix = type.startsWith('message') ? '›' : type.startsWith('reasoning') ? '…' : type.startsWith('question') ? '?' : (type.startsWith('director') || type.startsWith('control.message')) ? '→' : type.startsWith('file') ? '✎' : ''
    const color = /error|failed/.test(type) ? 'red' : type.startsWith('question') ? 'magenta' : (type.startsWith('director') || type.startsWith('control.message')) ? 'cyan' : undefined
    const text = index === newest ? data.lastMessage!.text : event.text.replace(/^(assistant|reasoning|notify_director):\s*/, '')
    const props = { color, dimColor: type === 'source.warning' || type.startsWith('reasoning') || (!prefix && !color) }
    if (type.startsWith('message')) lines.push(...markdown(ui, text, props, `${prefix} `, columns, index === newest && type.endsWith('.delta')))
    else if (PROSE.test(type)) prose(`${prefix} ${text}`.trimStart(), props)
    else add(`${prefix} ${text}`.trimStart(), props)
  })
  return tree()
}
