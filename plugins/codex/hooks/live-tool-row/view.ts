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
  executor?: { kind: 'codex' | 'acp'; label: string }
  activeCommands: { itemId: string; command: string; cwd: string; startedAt: string; agentThreadId?: string }[]
  lastMessage: { kind: 'assistant' | 'reasoning'; text: string; at: string } | null
  files: { path: string; kind: 'add' | 'update' | 'delete'; additions: number | null; deletions: number | null }[]
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean }
  pendingQuestion: { requestId: string; text: string; openedAt: string; expiresAt: string | null } | null
  history: { committedSeq: string; continuity: 'complete' | 'partial' | 'legacy' }
  subAgents?: { threadId: string; path: string; status: string; endedAt: string | null; lastActivity?: string; startedSeq?: string }[]
  tail: { seq: string; positionSeq?: string; at: string; type: string; text: string; from?: string; output?: string; exitCode?: number | null; durationMs?: number | null; agent?: string; agentThreadId?: string }[]
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
  const executor = running[0]?.executor?.label ?? 'Codex'
  return `${executor} · ${running.length} running · ${running.map(data => {
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

// `Tool started: Read /very/long/path` is the event's own wording; a row should
// read as the work itself, with the path cut to what fits.
function toolTitle(text: string, columns: number): string {
  const title = text.replace(/^\S+\s+(started|completed|failed|cancelled|updated|in_progress|pending):\s*/, '')
  return title.replace(/(^|\s)(\/\S+)/g, (_, space, path) => `${space}${shortPath(path, Math.max(12, Math.floor(columns / 2)))}`)
}

// `maxTail` lets a caller that scrolls (the tasks pane) draw the whole trace and
// let its surface window it; a tool row inline in the transcript must not grow
// that far, so it keeps the row-derived limit.
// `headingLast` puts the status line under the trace: a row in the transcript
// is read top down and announces itself first, while a pane already names the
// task in its tabs and wants its foot to say how the task is doing.
export function liveTree(ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'>, data: LiveView, columns: number, now: number, rows?: number, result?: { kind: 'DONE' | 'FAILED' }, maxTail?: number, headingLast = false) {
  const { Box, Text } = ui
  const executor = data.executor?.label ?? 'Codex'
  const status = result ? result.kind === 'DONE' ? 'completed' : 'failed' : data.status
  const stalled = data.status === 'running' && data.tail.length ? now - Date.parse(data.tail.at(-1)!.at) : 0
  // An ACP agent never reports usage, so its counts stay at zero for the whole
  // run: the header says nothing rather than saying the same nothing forever.
  const counted = data.usage.inputTokens > 0 || data.usage.outputTokens > 0 || data.usage.cachedInputTokens > 0
  // The pane names the task in its tabs, with the one in view marked; repeating
  // the name in the footer under it spends a third of the row saying it twice.
  const header = [
    { text: `● ${executor}${headingLast ? '' : ' · '}` },
    { text: headingLast ? '' : data.label, bold: true },
    { text: ` · ${status}`, color: colors[status] },
    { text: ` · ${data.endedAt ? duration(Date.parse(data.endedAt) - Date.parse(data.startedAt)) : elapsed(data.startedAt, now)}${result ? ` · ${data.files.length} files` : counted ? ` · ↑${tokens(data.usage.inputTokens)} ↓${tokens(data.usage.outputTokens)} tokens` : ''}` },
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
  const tree = () => {
    const body = Box({ flexDirection: 'column', paddingLeft: 2, children: Box({ flexDirection: 'column', width: columns, children: lines }) })
    // A heading under the trace is a footer: it needs the gap above it that a
    // heading above one gets for free from the row that precedes it.
    return Box({ flexDirection: 'column', children: headingLast
      ? [Box({ flexGrow: 1, children: [body] }), Box({ marginTop: 1, children: [heading] })]
      : [heading, body] })
  }
  let previousBlock = false
  let hasContent = false
  const separate = (block: boolean) => {
    if (hasContent && (block || previousBlock)) lines.push(Text({ children: ' ' }))
    previousBlock = block
    hasContent = true
  }
  const add = (text: string, props: TextProps = {}) => {
    separate(false)
    lines.push(Text({ ...props, wrap: 'truncate-end', children: clip(text, columns) }))
  }
  const prose = (text: string, props: TextProps = {}, block = true) => {
    separate(block)
    lines.push(Text({ ...props, wrap: 'wrap', children: clean(text) }))
  }
  const files = () => {
    for (const file of data.files.slice(0, 3)) {
      const counts = ` (+${file.additions ?? '?'} −${file.deletions ?? '?'})`
      add(`✎ ${shortPath(file.path, Math.max(1, columns - counts.length - 2))}${counts}`)
    }
    if (data.files.length > 3) add(`+${data.files.length - 3} more`, { dimColor: true })
  }
  if (result) {
    if (data.lastMessage?.kind === 'reasoning') prose(data.lastMessage.text, { dimColor: true })
    else if (data.lastMessage) {
      separate(true)
      lines.push(...markdown(ui, data.lastMessage.text, {}, '', columns))
    }
    files()
    for (const agent of agentSummaries(data)) add(agent.text, { dimColor: true })
    return tree()
  }
  if (data.pendingQuestion) {
    prose(`? ${data.pendingQuestion.text}`, { color: 'magenta', bold: true })
    lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: clip(waiting(data.pendingQuestion.openedAt, data.pendingQuestion.expiresAt, now), columns) }))
  }
  for (const command of data.activeCommands.filter(command => !command.agentThreadId).slice(0, 3)) {
    separate(false)
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
    // An agent's thinking is not what the reader is watching for, and one that
    // streams raw thought rather than a summary buries the trace under it: the
    // last job put seventy-five thousand characters of it in one row.
    if (String(event.type ?? '').startsWith('reasoning')) return false
    if ((event.type === 'tool.started' || event.type === 'tool.completed') && event.text.startsWith('dynamicToolCall')) return false
    if (event.type === 'tool.started') {
      const title = toolTitle(event.text, columns)
      if (data.tail.some(later => later.type === 'tool.completed' && toolTitle(later.text, columns) === title)) return false
    }
    if (event.type === 'source.warning') {
      if (warnings.has(event.text)) return false
      warnings.add(event.text)
    }
    return true
  }).slice(-(maxTail ?? tailLimit(rows)))
  const grouped: LiveView['tail'] = []
  for (const agent of agents.filter(agent => agent.index < 0)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
  data.tail.forEach((event, index) => {
    for (const agent of agents.filter(agent => agent.index === index)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
    if (tail.includes(event)) grouped.push(event)
  })
  for (const agent of agents.filter(agent => agent.index === data.tail.length)) grouped.push({ seq: '', at: '', type: 'agent.summary', text: agent.text })
  if (grouped.length && !hasContent) lines.push(Text({ children: ' ' }))
  const kind = data.lastMessage?.kind
  const typeOf = (event: LiveView['tail'][number]) => String(event.type ?? '')
  const isKind = (event: LiveView['tail'][number]) => !event.agent && typeOf(event).startsWith(kind === 'assistant' ? 'message' : 'reasoning')
  const newest = kind ? grouped.findLastIndex(isKind) : -1
  // lastMessage holds the whole message, and a row holds a 300-character
  // preview, so the last row is swapped for the full text -- from where its own
  // stretch begins, since writing that resumed after a tool has a row per
  // stretch and the whole text there would draw every earlier one again.
  const from = newest >= 0 ? Number(grouped[newest]!.from ?? 0) : 0
  grouped.forEach((event, index) => {
    const type = typeOf(event)
    if (type === 'agent.summary') return add(event.text, { dimColor: true })
    if (type === 'question.resolved') {
      add('→ answer delivered', { color: 'cyan' })
      return
    }
    if (type.startsWith('command')) {
      separate(false)
      const completed = type === 'command.completed'
      const color = completed ? event.exitCode == null ? 'gray' : event.exitCode === 0 ? 'green' : 'red' : undefined
      const suffix = completed && event.durationMs != null ? ` · ${duration(event.durationMs)}` : ''
      // A heredoc command carries its own newlines, so the command is one row
      // whatever it contains and the output comes from its own field. What
      // follows the first line is a patch body or a script: spelling its breaks
      // out fills the row with glyphs, so the row says it was cut and stops.
      const [first, ...rest] = clean(event.text).replace(/^\$\s*/, '').split(/\n| ⏎ /)
      const command = rest.some(part => part.trim()) ? `${first!.trimEnd()} …` : first!
      lines.push(Text({ wrap: 'truncate-middle', children: [
        Text({ color, children: completed ? '● $ ' : '$ ' }),
        Text({ children: command + suffix }),
      ] }))
      // Failing output is worth a row per line: run together it reads as one
      // stretch of noise, and the cut leaves a separator dangling at the end.
      if (completed && event.exitCode != null && event.exitCode !== 0) {
        for (const line of clean(event.output ?? '').split('\n').map(part => part.trim()).filter(Boolean).slice(0, 3)) {
          lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  ${line}` }))
        }
      }
      return
    }
    const prefix = type.startsWith('message') ? '›' : type.startsWith('reasoning') ? '…' : type.startsWith('question') ? '?' : (type.startsWith('director') || type.startsWith('control.message')) ? '→' : type.startsWith('file') ? '✎' : ''
    const color = /error|failed/.test(type) ? 'red' : type.startsWith('question') ? 'magenta' : (type.startsWith('director') || type.startsWith('control.message')) ? 'cyan' : undefined
    const text = index === newest ? data.lastMessage!.text.slice(Math.min(from, data.lastMessage!.text.length)) : event.text.replace(/^(assistant|reasoning|notify_director):\s*/, '')
    const props = { color, dimColor: type === 'source.warning' || type.startsWith('reasoning') || (!prefix && !color) }
    if (type.startsWith('message')) {
      separate(true)
      // The "still writing" marker only belongs on a row nothing has followed:
      // below a tool the message has visibly paused, and the ellipsis there
      // reads as the end of the trace rather than the end of that row.
      lines.push(...markdown(ui, text, props, `${prefix} `, columns, index === newest && index === grouped.length - 1 && type.endsWith('.delta')))
    } else if (type.startsWith('tool.')) add(`● ${toolTitle(text, columns)}`, props)
    else if (PROSE.test(type)) prose(`${prefix} ${text}`.trimStart(), props, /^(reasoning|question|director|control\.message)/.test(type))
    else add(`${prefix} ${text}`.trimStart(), props)
  })
  return tree()
}
