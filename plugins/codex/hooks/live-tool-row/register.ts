import type { EngineInterface, On, Timer, ToolGroupCall } from 'claude-code'
import { followOf } from './command.ts'
import type { Follow } from './command.ts'
import { liveTree, statusText, terminalTree } from './view.ts'
import { clip, terminalOf } from './format.ts'
import type { LiveView } from './view.ts'

type Job = { follow: Follow; path?: Promise<string>; retryPolls: number; mtime?: number; data?: LiveView; error: string; finalReads?: Map<string, Promise<boolean>>; eventSeqs?: Map<string, string>; sawLive?: boolean }
type State = {
  rows: Map<string, Job>
  jobs: Map<string, Job>
  terminalLabels: Map<string, string>
  followRows: Set<string>
  timer?: Timer
  polling: boolean
  now: number
  redrawnAt: number
  toasted: Set<string>
}

const LOOKUP_RETRY_POLLS = 4

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  return path.startsWith('~/') ? `${await $.env.get('HOME')}/${path.slice(2)}` : path
}

async function viewPath($: EngineInterface, follow: Follow): Promise<string> {
  const cwd = follow.cwd ? await expandHome($, follow.cwd) : await $.session.cwd()
  let script = await expandHome($, follow.script)
  if (follow.worker) {
    const result = await $.process.run(['bash', script, 'companion'], { cwd, timeoutMs: 3000 })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'companion lookup failed')
    script = result.stdout.trim()
  }
  const result = await $.process.run(['node', script, 'observe', 'view-path', follow.jobId, '--cwd', cwd], { cwd, timeoutMs: 3000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'view-path lookup failed')
  const path = result.stdout.trim()
  if (!path.startsWith('/') || /[\r\n]/.test(path)) throw new Error('view-path did not return one absolute path')
  return path
}

export async function refresh($: EngineInterface, job: Job): Promise<boolean> {
  const before = job.data
  const oldError = job.error
  try {
    if (!job.path && job.retryPolls > 0) {
      job.retryPolls -= 1
      return false
    }
    job.path ??= viewPath($, job.follow)
    const path = await job.path.catch(error => {
      // A lookup can fail before the job is registered; forget it and retry a
      // few polls later instead of caching the failure for the row's lifetime.
      job.path = undefined
      job.retryPolls = LOOKUP_RETRY_POLLS
      throw error
    })
    const stat = await $.fs.stat(path).catch(error => {
      job.mtime = undefined
      throw error
    })
    if (stat.mtimeMs !== job.mtime) {
      const text = await $.fs.read(path)
      job.mtime = stat.mtimeMs
      const data = JSON.parse(text) as LiveView
      if (data.schemaVersion !== 1 || data.jobId !== job.follow.jobId) throw new Error('live-view schema/job mismatch')
      job.data = data
      job.error = ''
      if (data.status === 'running' || data.status === 'waiting-for-answer') job.sawLive = true
    }
  } catch (error) {
    job.error = reason(error)
  }
  return before !== job.data || oldError !== job.error
}

function eventSeq(job: Job, type: string, identity: string): string {
  job.eventSeqs ??= new Map()
  const key = `${type}:${identity}`
  if (!job.eventSeqs.has(key)) job.eventSeqs.set(key, job.data!.tail.findLast(event => event.type === type)?.seq ?? identity)
  return job.eventSeqs.get(key)!
}

function notices($: EngineInterface, state: State, job: Job) {
  const data = job.data
  if (!data || job.error) return
  const events = data.tail.filter(event => event.type === 'director.notified').map(event => ({ type: event.type, seq: event.seq, text: `Codex · ${clip(data.label, 80)} → ${clip(event.text, 160)}`, timeoutMs: 4000 }))
  if (data.status === 'waiting-for-answer' && data.pendingQuestion) {
    const question = data.pendingQuestion
    events.push({ type: 'waiting-for-answer', seq: eventSeq(job, 'question.opened', question.requestId), text: `Codex · ${clip(data.label, 80)} ? ${clip(question.text, 80)}`, timeoutMs: 8000 })
  }
  // A job first seen already finished (a resumed transcript's result card) ends nothing now.
  if (job.sawLive && (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled')) {
    events.push({ type: data.status, seq: eventSeq(job, `job.${data.status}`, data.endedAt ?? data.history.committedSeq), text: `Codex · ${clip(data.label, 80)} · ${data.status}`, timeoutMs: 4000 })
  }
  for (const event of events) {
    const key = JSON.stringify([job.follow.cwd, job.follow.jobId, event.type, event.seq])
    if (state.toasted.has(key)) continue
    state.toasted.add(key)
    $.ui.toast(event.text, { timeoutMs: event.timeoutMs })
  }
}

async function poll($: EngineInterface, state: State) {
  if (state.polling || !state.rows.size) return
  state.polling = true
  try {
    const changed = await Promise.all([...new Set(state.rows.values())].map(job => refresh($, job)))
    state.now = await $.clock.now()
    for (const job of new Set(state.rows.values())) notices($, state, job)
    if (state.rows.size && (changed.some(Boolean) || state.now - state.redrawnAt >= 1000)) {
      state.redrawnAt = state.now
      // 2.1.271 only accepts the event name, not a requestId. One call per
      // shared tick coalesces all rows, below the ordinary 10/s limit.
      $.ui.invalidate('ui.render')
    }
  } finally {
    state.polling = false
  }
}

function release(state: State, id: string) {
  state.rows.delete(id)
  if (!state.rows.size) {
    state.timer?.cancel()
    state.timer = undefined
  }
}

function matchingFollow(call: Pick<ToolGroupCall, 'tool' | 'input' | 'isInterrupted' | 'isErrored'>) {
  const input = call.input as { command?: unknown } | null
  return call.tool === 'Bash' && !call.isInterrupted && !call.isErrored ? followOf(input?.command) : null
}

export function register(on: On) {
  const state: State = { rows: new Map(), jobs: new Map(), terminalLabels: new Map(), followRows: new Set(), polling: false, now: 0, redrawnAt: 0, toasted: new Set() }
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.props.isDraft) return next(e)
    const text = statusText([...new Set(state.rows.values())].flatMap(job => job.data ? [job.data] : []), state.now)
    if (!text) return next(e)
    const { Text } = $.ui.resolve(e)
    const columns = Math.max(1, e.viewport?.columns ?? 120)
    const hint = clip(e.props.hint, columns)
    const combined = `${text}  ${hint}`
    return Text({ wrap: 'truncate-end', children: [
      Text({ color: 'cyan', children: 'Codex' }),
      Text({ dimColor: true, children: text.slice(5) }),
      ...(hint === e.props.hint && clip(combined, columns) === combined ? [Text({ dimColor: true, children: `  ${hint}` })] : []),
    ] })
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    let expand = false
    for (const call of e.props.calls) {
      if (matchingFollow(call)) expand = true
      if ((!call.isRunning || !matchingFollow(call)) && call.tool_use_id) release(state, call.tool_use_id)
    }
    return expand ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
  })
  // The host draws a follow row's result on its own: the quiet heartbeat lines,
  // repository edits it attributes to the command (Codex made them meanwhile)
  // and a timeout note. The card above already says what happened, so draw nothing.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const ours = e.props.tool === 'Bash' && !e.props.isErrored && (state.followRows.has(e.props.tool_use_id) || terminalOf(e.props.output) !== undefined)
    return ours ? $.ui.resolve(e).Box({ children: [] }) : next(e)
  })
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const follow = matchingFollow(e.props)
    if (!follow) {
      release(state, e.props.tool_use_id)
      return next(e)
    }
    state.followRows.add(e.props.tool_use_id)
    const terminal = e.props.isRunning ? undefined : terminalOf(e.props.output)
    if (!e.props.isRunning) {
      release(state, e.props.tool_use_id)
      if (!terminal) return next(e)
    }
    const cwd = follow.cwd ?? await $.session.cwd()
    const key = JSON.stringify([cwd, follow.script, follow.jobId])
    let job = state.jobs.get(key)
    const ui = $.ui.resolve(e)
    const columns = Math.max(1, e.viewport?.columns ?? 120)
    if (terminal && terminal.kind !== 'DONE' && terminal.kind !== 'FAILED') {
      // Snapshot the label once; intermediate results never read the live-view.
      if (!state.terminalLabels.has(e.props.tool_use_id)) state.terminalLabels.set(e.props.tool_use_id, job?.data?.label ?? terminal.label ?? follow.jobId)
      return terminalTree(ui, terminal, state.terminalLabels.get(e.props.tool_use_id)!, columns)
    }
    if (!job) {
      job = { follow: { ...follow, cwd }, retryPolls: 0, error: 'loading' }
      state.jobs.set(key, job)
    }
    if (!e.props.isRunning) {
      job.finalReads ??= new Map()
      if (!job.finalReads.has(e.props.tool_use_id)) {
        job.mtime = undefined
        job.retryPolls = 0
        job.finalReads.set(e.props.tool_use_id, refresh($, job))
      }
      await job.finalReads.get(e.props.tool_use_id)
      state.now = await $.clock.now()
      notices($, state, job)
    } else {
      job.finalReads?.delete(e.props.tool_use_id)
      state.rows.set(e.props.tool_use_id, job)
    }
    if (e.props.isRunning && !state.timer) {
      state.timer = $.clock.every(500, () => { void poll($, state) })
      void poll($, state)
    }
    if (!job.error && job.data) return liveTree(ui, job.data, columns, state.now, e.viewport?.rows, terminal ? { kind: terminal.kind as 'DONE' | 'FAILED' } : undefined)
    return ui.Box({ flexDirection: 'column', children: [await next(e), ui.Box({ paddingLeft: 2, children: ui.Text({
      dimColor: true, wrap: 'truncate-end', children: clip(`codex live view unavailable: ${job.error}`, Math.max(1, columns - 2)),
    }) })] })
  })
}
