import type { Elements, TextProps } from 'claude-code'
import { clean, clip, duration, elapsed, shortPath, tailLimit, tokens, waiting } from './format.ts'
import type { Terminal } from './format.ts'
import { markdown } from './markdown.ts'
export { clip } from './format.ts'

export type LiveView = {
  // Kept as a defensive ownership marker; session-filtered polls leave it false.
  foreign?: boolean
  schemaVersion: 1
  recordId?: string
  jobId: string
  label: string
  status: 'queued' | 'running' | 'waiting-for-answer' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  endedAt: string | null
  threadId: string | null
  turnId: string | null
  executor?: { kind: 'codex' | 'acp'; label: string }
  // Absent on views written before the pane showed them, and null while the
  // record does not know one.
  model?: string | null
  effort?: string | null
  activeCommands: { itemId: string; command: string; cwd: string; startedAt: string; agentThreadId?: string }[]
  lastMessage: { kind: 'assistant' | 'reasoning'; text: string; at: string } | null
  files: { path: string; kind: 'add' | 'update' | 'delete'; additions: number | null; deletions: number | null }[]
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean }
  pendingQuestion: { requestId: string; text: string; openedAt: string; expiresAt: string | null } | null
  plan?: { entries: { content: string; status: string; priority?: string }[]; markdown: string | null } | null
  prompt?: string | null
  activeRoundId?: string | null
  latestRoundId?: string | null
  rounds?: {
    jobId: string
    sessionId: string | null
    // The name its own dispatch was given. Absent on rounds recorded before the
    // pane needed one, and on a round whose dispatch named nothing.
    label?: string | null
    prompt: string | null
    executorTurnIds: string[]
    firstSeq: string
    lastSeq: string
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean }
    result: unknown
    status: 'running' | 'waiting-for-answer' | 'completed' | 'failed' | 'cancelled'
    startedAt: string | null
    endedAt: string | null
  }[]
  history: { committedSeq: string; continuity: 'complete' | 'partial' | 'legacy' }
  subAgents?: { threadId: string; path: string; status: string; endedAt: string | null; lastActivity?: string; task?: string; startedSeq?: string }[]
  tail: { seq: string; positionSeq?: string; at: string; type: string; text: string; from?: string; output?: string; exitCode?: number | null; durationMs?: number | null; agent?: string; agentThreadId?: string
    files?: { path: string; kind: string; additions: number | null; deletions: number | null }[]; status?: string; failed?: boolean
    items?: LiveView['tail']; foldKey?: string }[]
}
type TailRow = LiveView['tail'][number]
// What a caller that takes presses lends the trace so a fold can open.
export type Fold = { Button: Elements['terminal']['Button']; isOpen: (key: string) => boolean; toggle: (key: string) => void }

const colors = { queued: 'gray', running: 'cyan', 'waiting-for-answer': 'magenta', completed: 'green', failed: 'red', cancelled: 'gray' }
// Well clear of the pane's own ground (rgb(42,42,42) by default), so the brief
// reads as a slab laid on it rather than as another run of text.
const BRIEF = 'rgb(80,80,80)'
// A trace read hours later needs the time a round finished, not only how long
// it took; the date is what the row above it already places.
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5)

// A thread is over when it has no active round. Legacy views have no round
// fields, so their terminal state keeps the prior endedAt/status definition.
export function isOver(view: Pick<LiveView, 'status' | 'endedAt' | 'activeRoundId'>): boolean {
  if (view.status === 'queued') return false
  if (Object.hasOwn(view, 'activeRoundId')) return view.activeRoundId === null
  return Boolean(view.endedAt) || ['completed', 'failed', 'cancelled'].includes(view.status)
}
const PROSE = /^(message|reasoning|question|director|control|source|plan|tool\.progress)/
// A command that failed keeps a row of its own with its output: the reason it
// failed is what the reader needs, and a fold would hide it.
const isQuietCommand = (event: LiveView['tail'][number]) => (event.type === 'command.started'
  || (event.type === 'command.completed' && (event.exitCode == null || event.exitCode === 0)))
const isFileRow = (event: LiveView['tail'][number]) => String(event.type ?? '').startsWith('fileChange') && Boolean(event.files?.length)
const isToolRow = (event: TailRow) => event.type === 'tool.started' || event.type === 'tool.completed'
const failedTool = (event: TailRow) => event.status === 'failed' || /^\S+ failed:/.test(event.text)
const workKind = (event: TailRow) => {
  if (isQuietCommand(event)) return 'command'
  if (isFileRow(event)) return 'edit'
  const name = event.text.split(/\s/, 1)[0]!.toLowerCase()
  return name.startsWith('read') ? 'read' : /^(grep|glob|search|find)/.test(name) ? 'search' : /^(list|ls)$/.test(name) ? 'list' : 'tool'
}
const FILE_VERBS: Record<string, string> = { add: 'Write', update: 'Update', delete: 'Delete', move: 'Move' }

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
    // The first line is the agent: who it is, how it is doing, what it was
    // sent to do. What it is doing now goes under it, indented, where a long
    // command cannot crowd the name off the row.
    return { index, text: `⇢ ${agent.path} · ${status}${agent.task ? ` · ${agent.task}` : ''}`, detail: activity || null }
  })
}

// A thread spans every round it has had, and the reader is watching the newest
// one: its clock and its tokens are the figures worth drawing. A lone job has
// no rounds.
export function latestRound(data: Pick<LiveView, 'rounds' | 'latestRoundId'>) {
  return data.rounds?.find(round => round.jobId === data.latestRoundId)
}

export function statusText(jobs: LiveView[], now: number): string | undefined {
  const running = jobs.filter(data => data.status === 'running' || data.status === 'waiting-for-answer')
  if (!running.length) return undefined
  const executor = running[0]?.executor?.label ?? 'Codex'
  return `${executor} · ${running.length} running · ${running.map(data => {
    const command = data.activeCommands.find(command => !command.agentThreadId)
    const detail = command ? `$ ${clip(command.command, 30)}`
      : data.files.length ? `✎ ${data.files.length} files` : clip(data.tail.at(-1)?.text ?? '', 30)
    return `${clip(data.label, 80)} ${elapsed(latestRound(data)?.startedAt ?? data.startedAt, now)}${detail ? ` ${detail}` : ''}`
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

// `maxTail` lets a caller that scrolls (the tasks pane) draw the whole trace,
// including the brief and complete newest message, and let its surface window
// it; a tool row inline in the transcript keeps the short event previews.
// `headingLast` puts the status line under the trace: a row in the transcript
// is read top down and announces itself first, while a pane already names the
// task in its tabs and wants its foot to say how the task is doing.
// The plan is where the work is going, so it sits at the foot of the pane
// rather than scrolling away in the trace: one line per step, marked with
// where it stands. A plan whose steps are all done has nothing left to say,
// and neither has one on a job that is over, so both draw nothing.
function planLines(ui: Pick<Elements['terminal'], 'Box' | 'Text'>, data: LiveView, columns: number) {
  const { Box, Text } = ui
  const entries = data.plan?.entries ?? []
  const done = entries.filter(step => step.status === 'completed').length
  if (!entries.length || done === entries.length || isOver(data)) return []
  const mark: Record<string, string> = { completed: '☑', in_progress: '▸' }
  return [Text({ children: ' ' }), Box({ flexDirection: 'column', width: columns, children: [
    Text({ dimColor: true, wrap: 'truncate-end', children: clip(`Plan · ${done}/${entries.length}${data.plan?.markdown ? `: ${data.plan.markdown}` : ''}`, columns) }),
    ...entries.map(step => Text({ dimColor: step.status !== 'in_progress', wrap: 'truncate-end',
      children: clip(`  ${mark[step.status] ?? '☐'} ${step.content}`, columns) })),
  ] })]
}

export function liveTree(ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'>, data: LiveView, columns: number, now: number, rows?: number, result?: { kind: 'DONE' | 'FAILED' }, maxTail?: number, headingLast = false, fold?: Fold) {
  const { Box, Text } = ui
  const fullTrace = maxTail !== undefined
  const executor = data.executor?.label ?? 'Codex'
  const status = result ? result.kind === 'DONE' ? 'completed' : 'failed' : data.status
  const stalled = data.status === 'running' && data.tail.length ? now - Date.parse(data.tail.at(-1)!.at) : 0
  // A thread's own clock and counts run across every round it has had, which
  // says nothing about the question in hand: the header measures the newest round.
  const current = latestRound(data)
  const usage = current?.usage ?? data.usage
  const startedAt = current?.startedAt ?? data.startedAt
  // An ACP agent never reports usage, so its counts stay at zero for the whole
  // run: the header says nothing rather than saying the same nothing forever.
  const counted = usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cachedInputTokens > 0
  const header = [
    { text: `● ${executor} · ` },
    { text: data.label, bold: true },
    { text: ` · ${status}`, color: colors[status] },
    { text: ` · ${data.endedAt ? duration(Date.parse(data.endedAt) - Date.parse(startedAt)) : elapsed(startedAt, now)}${result ? ` · ${data.files.length} files` : counted ? ` · ↑${tokens(usage.inputTokens)} ↓${tokens(usage.outputTokens)} tokens` : ''}` },
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
    // heading above one gets for free from the row that precedes it. The gap is
    // a blank row rather than a margin, because a margin belongs to no element
    // and the pane's own ground -- a mid grey -- is what shows through it.
    const plan = planLines(ui, data, columns)
    return Box({ flexDirection: 'column', children: headingLast
      ? [Box({ flexGrow: 1, children: [body] }), ...plan, Text({ children: ' ' }), heading]
      : [heading, body, ...plan] })
  }
  let previousBlock = false
  let hasContent = false
  // Set as each entry of the trace begins: entries stand a blank row apart the
  // way Claude Code's own tool rows do, while the rows an entry carries -- a
  // fold's items, a failed command's output -- stay against it.
  let entry = false
  const separate = (block: boolean) => {
    if (hasContent && (entry || block || previousBlock)) lines.push(Text({ children: ' ' }))
    entry = false
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
  // In a thread the brief sits between rounds, where the agent's own messages
  // carry the same '›' and dim text made it the quietest thing on screen. A
  // slab a shade off the pane's ground separates what was asked from what came
  // back, and the text on it reads at full strength. A transcript row has no
  // ground of its own to sit on, so there it keeps the dim run of text.
  const prompt = (text: string) => {
    separate(true)
    const body = markdown(ui, text.length > 1200 ? `${text.slice(0, 1199)}…` : text,
      fullTrace ? {} : { dimColor: true }, '› ', columns)
    if (fullTrace) lines.push(Box({ flexDirection: 'column', width: columns, backgroundColor: BRIEF, children: body }))
    else lines.push(...body)
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
    for (const agent of agentSummaries(data)) {
      add(agent.text, { dimColor: true })
      if (agent.detail) add(`    ${agent.detail}`, { dimColor: true })
    }
    return tree()
  }
  // A full trace starts with what the agent was asked, so a reader who scrolls
  // to the top finds the brief rather than the first thing the agent did. It is
  // Markdown, like the answer that comes back, and long enough to need a cut.
  // A thread runs across rounds and data.prompt is the newest round's, which at
  // the head would open the trace with the question asked last: the first
  // round's brief opens it, and every round after it is drawn further down,
  // where that round begins.
  const rounds = fullTrace ? (data.rounds ?? []).filter(round => round.prompt) : []
  const opening = rounds.length ? rounds[0]!.prompt : data.prompt
  if (fullTrace && opening) prompt(opening)
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
    // The heading already says the thread completed, and across rounds the row
    // only breaks the trace where one question ends and the next begins. A
    // failure or a cancellation still carries its reason, so those stay.
    if (event.type === 'job.completed') return false
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
  const summary = (agent: { text: string; detail: string | null }) =>
    ({ seq: '', at: '', type: 'agent.summary', text: agent.text, ...(agent.detail ? { output: agent.detail } : {}) })
  // What the director asked for a round belongs where that round begins, and
  // how the round ended where it stops: without them the rounds run together
  // as one unbroken answer. The first brief already opens the trace above, and
  // a round still going has no foot to draw. The ending sorts one past the
  // round's last event so it lands before the next round's brief.
  const marks: LiveView['tail'] = []
  rounds.forEach((round, index) => {
    if (index) marks.push({ seq: round.firstSeq, at: round.startedAt ?? '', type: 'prompt', text: round.prompt! })
    if (!round.endedAt) return
    const counted = round.usage.inputTokens > 0 || round.usage.outputTokens > 0 || round.usage.cachedInputTokens > 0
    const spent = Date.parse(round.endedAt) - Date.parse(round.startedAt ?? round.endedAt)
    const counts = counted ? ` · ↑${tokens(round.usage.inputTokens)} ↓${tokens(round.usage.outputTokens)} tokens` : ''
    marks.push({ seq: `${BigInt(round.lastSeq) + 1n}`, at: round.endedAt, type: 'round.ended',
      text: `✻ ${round.status} · ${duration(spent)}${counts} · ${clock(round.endedAt)}` })
  })
  for (const agent of agents.filter(agent => agent.index < 0)) grouped.push(summary(agent))
  data.tail.forEach((event, index) => {
    while (marks.length && event.seq && BigInt(event.seq) >= BigInt(marks[0]!.seq)) grouped.push(marks.shift()!)
    for (const agent of agents.filter(agent => agent.index === index)) grouped.push(summary(agent))
    if (!tail.includes(event)) return
    const work = isQuietCommand(event) || isFileRow(event) || (isToolRow(event) && !failedTool(event))
    const last = grouped.at(-1)
    if (work) {
      if (last?.type === 'work.group') grouped[grouped.length - 1] = { ...event, type: 'work.group', text: '', foldKey: last.foldKey,
        items: [...last.items!, event] }
      else grouped.push({ ...event, type: 'work.group', text: '', foldKey: event.positionSeq ?? event.seq, items: [event] })
    } else grouped.push(event)
  })
  for (const agent of agents.filter(agent => agent.index === data.tail.length)) grouped.push(summary(agent))
  grouped.push(...marks)
  if (grouped.length && !hasContent) lines.push(Text({ children: ' ' }))
  const kind = data.lastMessage?.kind
  const typeOf = (event: LiveView['tail'][number]) => String(event.type ?? '')
  const isKind = (event: LiveView['tail'][number]) => !event.agent && typeOf(event).startsWith(kind === 'assistant' ? 'message' : 'reasoning')
  const newest = kind ? grouped.findLastIndex(isKind) : -1
  // In a full trace, lastMessage replaces the newest 300-character preview from
  // where its own stretch begins. An inline row keeps that short event preview.
  const from = newest >= 0 ? Number(grouped[newest]!.from ?? 0) : 0
  // A heredoc command carries its own newlines, so the command is one row
  // whatever it contains and the output comes from its own field. What
  // follows the first line is a patch body or a script: spelling its breaks
  // out fills the row with glyphs, so the row says it was cut and stops.
  const commandText = (text: string) => {
    const [first, ...rest] = clean(text).replace(/^\$\s*/, '').split(/\n| ⏎ /)
    return rest.some(part => part.trim()) ? `${first!.trimEnd()} …` : first!
  }
  const commandRow = (event: TailRow, indent = '') => {
    const completed = event.type === 'command.completed'
    const color = completed ? event.exitCode == null ? 'gray' : event.exitCode === 0 ? 'green' : 'red' : undefined
    const suffix = completed && event.durationMs != null ? ` · ${duration(event.durationMs)}` : ''
    lines.push(Text({ wrap: 'truncate-middle', children: [
      Text({ color, children: `${indent}${completed ? '● ' : ''}` }),
      Text({ dimColor: true, children: '$ ' }),
      Text({ children: commandText(event.text) }),
      Text({ dimColor: true, children: suffix }),
    ] }))
    // Failing output is worth a row per line: run together it reads as one
    // stretch of noise, and the cut leaves a separator dangling at the end.
    if (completed && event.exitCode != null && event.exitCode !== 0) {
      for (const line of clean(event.output ?? '').split('\n').map(part => part.trim()).filter(Boolean).slice(0, 3)) {
        lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `${indent}  ${line}` }))
      }
    }
  }
  const fileRow = (file: NonNullable<TailRow['files']>[number], color: string, failed: boolean, indent = '') => {
    const verb = FILE_VERBS[file.kind] ?? 'Edit'
    const counts = file.additions == null ? [] : [` +${file.additions}`, ` −${file.deletions ?? 0}`]
    const room = columns - indent.length - 4 - verb.length - counts.join('').length - (failed ? 9 : 0)
    lines.push(Text({ wrap: 'truncate-end', children: [
      Text({ color, children: `${indent}● ` }),
      Text({ bold: true, children: verb }),
      Text({ children: `(${shortPath(file.path, Math.max(12, room))})` }),
      ...(counts.length ? [Text({ color: 'green', children: counts[0] }), Text({ color: 'red', children: counts[1] })] : []),
      ...(failed ? [Text({ color: 'red', children: ' · failed' })] : []),
    ] }))
  }
  const toolRow = (event: TailRow, indent = '') => {
    const failed = failedTool(event)
    add(`${indent}● ${toolTitle(event.text, columns)}`, { color: failed ? 'red' : undefined, dimColor: !failed })
    if (failed && event.output) for (const line of clean(event.output).split('\n').map(part => part.trim()).filter(Boolean).slice(0, 3)) {
      lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `${indent}  ${line}` }))
    }
  }
  // A fold's first row. Where the caller can take a press (the tasks pane),
  // the words are a button that opens the fold into its rows and closes it
  // again; elsewhere the row is plain text. Answers whether it is open.
  const foldHead = (key: string, color: string, label: string, rest: ReturnType<typeof Text>[], dim = false, styled?: ReturnType<typeof Text>[]) => {
    const dot = Text({ color: dim ? undefined : color, dimColor: dim, children: '● ' })
    if (!fold) {
      lines.push(Text({ dimColor: dim, wrap: 'truncate-end', children: [dot, ...(styled ?? [Text({ children: label })]), ...rest] }))
      return false
    }
    const open = fold.isOpen(key)
    lines.push(Box({ flexDirection: 'row', children: [
      dot,
      fold.Button({ key: `codex_fold_${key}`, plain: true, label, dimColor: dim, onPress: () => fold.toggle(key) }),
      Text({ wrap: 'truncate-end', children: [...rest, Text({ dimColor: true, children: open ? ' ▾' : ' ▸' })] }),
    ] }))
    return open
  }
  grouped.forEach((event, index) => {
    const type = typeOf(event)
    entry = true
    if (type === 'agent.summary') {
      add(event.text, { dimColor: true })
      if (event.output) add(`    ${event.output}`, { dimColor: true })
      return
    }
    if (type === 'question.resolved') {
      add('→ answer delivered', { color: 'cyan' })
      return
    }
    if (fullTrace && type === 'prompt') {
      prompt(event.text)
      return
    }
    if (type === 'round.ended') {
      add(event.text, { dimColor: true })
      return
    }
    if (type === 'work.group') {
      const items = event.items!
      separate(false)
      const commands = items.filter(isQuietCommand)
      const edits = items.filter(isFileRow)
      const files = edits.flatMap(item => item.files!).reduce<NonNullable<TailRow['files']>>((seen, file) =>
        [...seen.filter(previous => previous.path !== file.path), file], [])
      const failed = edits.some(item => item.status === 'failed')
      const active = index === grouped.length - 1 && !isOver(data)
      const known = files.filter(file => file.additions != null)
      const added = known.reduce((sum, file) => sum + file.additions!, 0)
      const removed = known.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
      const counts = `${added ? ` +${added}` : ''}${removed ? ` -${removed}` : ''}`
      const clauses = (['edit', 'search', 'read', 'list', 'tool', 'command'] as const).flatMap(kind => {
        const count = kind === 'command' ? commands.length : kind === 'edit' ? files.length : items.filter(item => workKind(item) === kind).length
        if (!count) return []
        const verbs = { edit: ['editing', 'edited'], search: ['searching for', 'searched for'], read: ['reading', 'read'],
          list: ['listing', 'listed'], tool: ['calling', 'called'], command: ['running', 'ran'] }
        const noun = kind === 'command' ? 'shell command' : kind === 'edit' || kind === 'read' ? 'file' : kind === 'search' ? 'pattern' : kind === 'list' ? 'directory' : 'tool'
        const plural = kind === 'list' ? 'directories' : `${noun}s`
        return [`${verbs[kind][active ? 0 : 1]} ${count} ${count === 1 ? noun : plural}${kind === 'edit' ? counts : ''}`]
      })
      const label = clauses.map((clause, i) => i ? clause : clause[0]!.toUpperCase() + clause.slice(1)).join(', ')
      const elapsedMs = now - Date.parse(items[0]!.at)
      const countAt = counts ? label.indexOf(counts) : -1
      const styled = countAt < 0 ? undefined : [
        Text({ children: label.slice(0, countAt) }),
        ...(added ? [Text({ color: 'green', children: ` +${added}` })] : []),
        ...(removed ? [Text({ color: 'red', children: ` -${removed}` })] : []),
        Text({ children: label.slice(countAt + counts.length) }),
      ]
      const open = foldHead(event.foldKey!, active ? 'gray' : 'green', label,
        [Text({ dimColor: true, children: `${failed ? ' · failed' : ''}${active ? `${Number.isFinite(elapsedMs) && elapsedMs >= 2000 ? ` · ${duration(elapsedMs)}` : ''}…` : ''}` })], !active, styled)
      if (open) for (const item of items) {
        if (isQuietCommand(item)) commandRow(item, '    ')
        else if (isFileRow(item)) for (const file of item.files!) fileRow(file, item.status === 'failed' ? 'red' : item.status === 'completed' ? 'green' : 'gray', item.status === 'failed', '    ')
        else toolRow(item, '    ')
      }
      else if (active) {
        const newest = items.at(-1)!
        const detail = isQuietCommand(newest) ? `$ ${commandText(newest.text)}` : isFileRow(newest)
          ? newest.files!.map(file => file.path.split('/').at(-1)).reverse().join(', ') : toolTitle(newest.text, columns)
        lines.push(Text({ dimColor: true, wrap: 'truncate-middle', children: clip(`  ⎿  ${detail}`, columns) }))
      }
      return
    }
    if (type.startsWith('command')) {
      separate(false)
      commandRow(event)
      return
    }
    const prefix = type.startsWith('message') ? '›' : type.startsWith('reasoning') ? '…' : type.startsWith('question') ? '?' : (type.startsWith('director') || type.startsWith('control.message')) ? '→' : type.startsWith('file') ? '✎' : ''
    const color = /error|failed/.test(type) ? 'red' : type.startsWith('question') ? 'magenta' : (type.startsWith('director') || type.startsWith('control.message')) ? 'cyan' : undefined
    const text = fullTrace && index === newest ? data.lastMessage!.text.slice(Math.min(from, data.lastMessage!.text.length)) : event.text.replace(/^(assistant|reasoning|notify_director):\s*/, '')
    const props = { color, dimColor: type === 'source.warning' || type.startsWith('reasoning') || (!prefix && !color) }
    if (type.startsWith('message')) {
      separate(true)
      // The "still writing" marker only belongs on a row nothing has followed:
      // below a tool the message has visibly paused, and the ellipsis there
      // reads as the end of the trace rather than the end of that row. A
      // thread with no active round is not writing anything, whatever its last
      // row is -- dropping the terminal event left the marker on a finished
      // trace, because the message had become the row nothing followed.
      lines.push(...markdown(ui, text, props, `${prefix} `, columns,
        index === newest && index === grouped.length - 1 && type.endsWith('.delta') && !isOver(data)))
    } else if (type.startsWith('tool.')) toolRow(event)
    else if (PROSE.test(type)) prose(`${prefix} ${text}`.trimStart(), props, /^(reasoning|question|director|control\.message)/.test(type))
    else add(`${prefix} ${text}`.trimStart(), props)
  })
  return tree()
}
