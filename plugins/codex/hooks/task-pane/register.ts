import type { EngineInterface, On } from 'claude-code'
import { clip, elapsed } from '../live-tool-row/format.ts'
import { isOver } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'
import { paneBody } from './pane.ts'

type Job = { id: string; label: string | null; status: string; startedAt: string | null }
type Receipt = { cursor?: string; terminal?: string }
type Ledger = Record<string, Receipt>
type State = {
  cwd: string
  home: string
  script: string
  sessionId: string
  key: string
  push: boolean
  roots: Set<string>
  paths: Map<string, string>
  mtimes: Map<string, number>
  views: Map<string, LiveView>
  ledger: Ledger
  ticks: number
  since: number
  busy: boolean
  booting: boolean
  polling: boolean
  opened: boolean
  selected: string | null
  followed: Set<string>
  unreadable: Map<string, number>
  pending: { jobId: string; cwd: string; text: string }[]
  worker: string
  toEnd: boolean
  pinned: boolean
  clock: string
  monitors: Map<string, { armedAt: number; checkedAt?: number }>
}

const PANE = 'codex_tasks'
const DONE = ['completed', 'failed', 'cancelled']
// The events a director must act on: the same set `dispatch.sh follow`
// stops at. Everything else is progress the pane already shows.
const ACTIONABLE = ['director.notified', 'question.opened', 'job.completed', 'job.failed', 'job.cancelled']

// What wakes the director is the event, not its body: a question and an ending
// both arrive with no text of their own, and what they are about lives in the
// view the companion keeps. Dropping the ones that came in empty cost a whole
// class of push -- every structured question went unreported.
export function pushLine(
  label: string,
  event: { type: string; text?: string },
  view?: Pick<LiveView, 'pendingQuestion' | 'lastMessage'>,
): string | null {
  // A question replayed from before this session's cursor floor may have been
  // answered long ago; the view says whether one is still open.
  if (event.type === 'question.opened' && !view?.pendingQuestion) return null
  const detail = (event.text ?? '').trim()
    || (event.type === 'question.opened' ? view?.pendingQuestion?.text ?? '' : '')
    || (event.type.startsWith('job.') ? view?.lastMessage?.text ?? '' : '')
  return `${label} · ${event.type}${detail ? `: ${clip(detail, 300)}` : ''}`
}
const RESCAN_TICKS = 15
// Polls a job may fail in a row before the pane stops asking for it.
const GIVE_UP = 5
// A plugin's own prompt runs once the session is idle, so a job that finishes
// or asks a question during a long turn waits for the end of it. A background
// task's notification is the one channel that reaches a running turn, and
// `dispatch.sh events` already prints one line per event the director must
// act on: armed as a Monitor, those lines arrive while the turn is still going.
// A task that has ended stays in the pane long enough to be read, then goes.
const KEEP_MS = 900_000
const MONITOR_MS = 1_800_000
const SETTLE_MS = 15_000
const CHECK_MS = 15_000

// Armed once per repository and never awaited: the call resolves when the
// monitor ends, which is the whole point of it, so awaiting here would hold the
// poll for the length of the watch. When it does end -- the host's thirty
// minute cap, or `events` exiting once the repository has been quiet -- the
// entry goes and the next poll with a live job there arms a fresh one.
function recordMonitors($: EngineInterface, state: State) {
  return $.store.set(`${state.key}:monitors`,
    Object.fromEntries([...state.monitors].map(([root, monitor]) => [root, monitor.armedAt]))).catch(() => {})
}

// The watch is a process with a command line of its own, so whether it is still
// there is a question the system can answer. Neither of the other two sources
// can: the call settles as soon as the host has launched the monitor, and a
// reload leaves the promise with the instance that is gone. Trusting age alone
// meant a watch that ended early -- the `events` command exits once a
// repository has been quiet -- went unnoticed until the cap, and a job that
// finished in that half hour woke nobody.
async function watching($: EngineInterface, state: State, root: string): Promise<boolean> {
  const found = await $.process.run(['pgrep', '-f', `(codex-worker|dispatch)\.sh events --cwd ${root}`],
    { cwd: state.cwd, timeoutMs: 2000 }).catch(() => null)
  return Boolean(found && found.exitCode === 0 && found.stdout.trim())
}

async function ensureMonitors($: EngineInterface, state: State, live: Set<string>, now: number) {
  for (const root of live) {
    const monitor = state.monitors.get(root)
    // Just armed: the process has not necessarily appeared yet, and asking now
    // would arm a second one for the same repository.
    if (monitor && now - monitor.armedAt < SETTLE_MS) continue
    if (monitor && now - monitor.armedAt < MONITOR_MS) {
      if (now - (monitor.checkedAt ?? 0) < CHECK_MS) continue
      monitor.checkedAt = now
      if (await watching($, state, root)) continue
    }
    state.monitors.set(root, { armedAt: now })
    // Awaited, or a reload between the arm and the write reads the old set and
    // arms a second monitor for the same repository.
    await recordMonitors($, state)
    void $.tool.call({
      tool: 'Monitor',
      command: `bash ${state.worker} events --cwd ${root}`,
      description: `Codex job events in ${root.split('/').at(-1) ?? root}`,
      timeout_ms: MONITOR_MS,
    }).catch((error: unknown) => {
      $.ui.log(`Codex tasks monitor ${root}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

async function companion($: EngineInterface, state: State, cwd: string, args: string[]) {
  const result = await $.process.run(['node', state.script, 'observe', ...args, '--cwd', cwd], {
    cwd, env: { CODEX_COMPANION_SESSION_ID: state.sessionId }, timeoutMs: 20000,
  })
  // observe reports an error as JSON on stdout and leaves stderr empty, so a
  // message taken from stderr alone would name the command and nothing else.
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim().split('\n')[0] || ''
    throw new Error(reason ? `observe ${args[0]}: ${clip(reason, 200)}` : `observe ${args[0]} failed`)
  }
  return result.stdout
}

// A job lives under the state directory of the repository it was dispatched
// into, which is rarely the session's own cwd. Job files carry the Claude
// session and the repository, so a scan finds every repository this session
// dispatched to; stat keeps it cheap once hundreds of jobs have accumulated.
async function discoverRoots($: EngineInterface, state: State) {
  const roots = new Set<string>([...state.roots, state.cwd])
  const data = `${state.home}/.claude/plugins/data`
  for (const plugin of await $.fs.list(data).catch(() => [])) {
    if (plugin.kind !== 'dir') continue
    for (const workspace of await $.fs.list(`${data}/${plugin.name}/state`).catch(() => [])) {
      if (workspace.kind !== 'dir') continue
      const jobs = `${data}/${plugin.name}/state/${workspace.name}/jobs`
      for (const file of await $.fs.list(jobs).catch(() => [])) {
        if (!file.name.endsWith('.json')) continue
        const path = `${jobs}/${file.name}`
        try {
          const stat = await $.fs.stat(path)
          if (stat.mtimeMs < state.since) continue
          const job = JSON.parse(await $.fs.read(path)) as { sessionId?: string; workspaceRoot?: string }
          if (job.sessionId === state.sessionId && job.workspaceRoot) roots.add(job.workspaceRoot)
        } catch { /* a half-written or foreign job file is skipped */ }
      }
    }
  }
  state.roots = roots
}

// The live view is a file the companion rewrites. Once its path is known, a
// stat per tick keeps the pane current without starting a process.
async function refreshViews($: EngineInterface, state: State) {
  let changed = false
  for (const [id, path] of state.paths) {
    try {
      const stat = await $.fs.stat(path)
      if (stat.mtimeMs === state.mtimes.get(id)) continue
      const view = JSON.parse(await $.fs.read(path)) as LiveView
      if (view.schemaVersion !== 1 || view.jobId !== id) continue
      state.mtimes.set(id, stat.mtimeMs)
      state.views.set(id, view)
      changed = true
    } catch {
      // A view whose file is gone is a job that was pruned, and the comment
      // here used to say so while nothing acted on it: the task stayed in the
      // tabs for the rest of the session. A path that fails only this once is
      // found again by the next poll, which asks the companion for it.
      if (!state.views.has(id) && !state.paths.has(id)) continue
      state.views.delete(id)
      state.paths.delete(id)
      state.mtimes.delete(id)
      changed = true
    }
  }
  if (changed) $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface, state: State) {
  if (state.polling || !state.script) return
  state.polling = true
  try {
    if (state.ticks % RESCAN_TICKS === 0) await discoverRoots($, state)
    state.ticks += 1
    const found: { job: Job; cwd: string }[] = []
    for (const root of state.roots) {
      if ((state.unreadable.get(root) ?? 0) >= GIVE_UP) continue
      try {
        const listed = JSON.parse(await companion($, state, root, ['list', '--json'])) as { jobs: Job[] }
        state.unreadable.delete(root)
        for (const job of listed.jobs) found.push({ job, cwd: root })
      } catch (error) {
        // Said once, then the root is left alone. This runs every two seconds,
        // and a repository whose companion cannot start -- a missing dependency
        // in an installed copy, say -- otherwise writes the same line into the
        // transcript for the rest of the session. `$.ui.log` is the only channel
        // there is, and it always lands in the transcript as well as the log.
        const failures = (state.unreadable.get(root) ?? 0) + 1
        state.unreadable.set(root, failures)
        if (failures === GIVE_UP) {
          $.ui.log(`Codex tasks ${root}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Before the loop, not after: the reconciliation below reads these views for
    // the text it reports, and a round that refreshed them afterwards had none
    // to read on its first pass and sent an empty line.
    await refreshViews($, state)
    const ledger: Ledger = { ...state.ledger }
    const lines: { jobId: string; cwd: string; text: string }[] = []
    await ensureMonitors($, state, new Set(found.filter(entry => !DONE.includes(entry.job.status)).map(entry => entry.cwd)), await $.clock.now())
    for (const { job, cwd } of found) {
      // A job dispatched seconds ago is listed before its event history is
      // written, so one failure means "not yet", not "never". Keep trying, and
      // give up only once it has failed a few polls in a row.
      if ((state.unreadable.get(job.id) ?? 0) >= GIVE_UP) continue
      try {
        // A job already over the first time it is seen ended before this pane
        // existed, or before a reload rebuilt it: there is nothing to wake the
        // director for, so its terminal state is recorded without a line.
        const first = !state.ledger[job.id]
        ledger[job.id] = { ...ledger[job.id] }
        const receipt = ledger[job.id]!
        if (!state.paths.has(job.id)) {
          state.paths.set(job.id, (await companion($, state, cwd, ['view-path', job.id])).trim())
        }
        const view = state.views.get(job.id)
        // The owner process writes the ending, so a job whose owner died never
        // wrote one and its view says running for ever -- the pane kept a task
        // killed an hour ago in its tabs and counted it among the live ones.
        // The store knows better, and it is what the listing reports.
        if (view && DONE.includes(job.status) && !isOver(view)) {
          state.views.set(job.id, { ...view, status: job.status as LiveView['status'], endedAt: view.tail.at(-1)?.at ?? new Date(await $.clock.now()).toISOString() })
        }
        {
          // Read during a director turn as well. A turn can run for half an
          // hour, and a pane that stops reading for it shows a task frozen at
          // whatever it was doing when the turn began, then jumps.
          const args = ['replay', job.id, '--limit', '8']
          if (receipt.cursor) args.push('--after', receipt.cursor)
          const rows = (await companion($, state, cwd, args)).trim().split('\n')
            .flatMap(row => { try { return [JSON.parse(row) as { type: string; seq?: string; text?: string; nextCursor?: string }] } catch { return [] } })
          const events = rows.filter(row => row.seq)
          // A job that is over has nothing left to wake the director for: its
          // ending is reported by the reconciliation below and the rest is read
          // with `result`. Its events are still consumed so the cursor moves
          // past them -- which is the whole point, since a cursor catching up
          // on a job that finished hours ago would otherwise replay every note
          // and question it ever wrote as though they had just arrived.
          const announce = !DONE.includes(job.status)
          for (const event of events.filter(row => ACTIONABLE.includes(row.type))) {
            const line = pushLine(job.label ?? job.id, event, view)
            if (announce && line) lines.push({ jobId: job.id, cwd, text: line })
            // Claimed here as well, or the reconciliation below reports the same
            // ending a second time once this cursor has moved past it.
            if (event.type.startsWith('job.')) receipt.terminal = event.type.slice(4)
          }
          if (events.length) receipt.cursor = rows.at(-1)?.nextCursor ?? receipt.cursor
        }
        // A job that ends while the director is mid-turn still has to be
        // reported once, so the terminal state is reconciled on its own.
        const status = DONE.includes(view?.status ?? '') ? view!.status : DONE.includes(job.status) ? job.status : ''
        // Cleared only once a round has read the job: clearing it on the way in
        // reset the count every poll, so the failure was never the fifth and the
        // "said once" line was said every two seconds for as long as it failed.
        state.unreadable.delete(job.id)
        if (status && receipt.terminal !== status) {
          if (!first && !lines.some(line => line.jobId === job.id && line.text.includes(`job.${status}`))) {
            lines.push({ jobId: job.id, cwd, text: `${job.label ?? job.id} · job.${status}: ${clip(view?.lastMessage?.text ?? '', 300)}` })
          }
          receipt.terminal = status
        }
      } catch (error) {
        const failures = (state.unreadable.get(job.id) ?? 0) + 1
        state.unreadable.set(job.id, failures)
        // Said when the round gives up, not when it first fails: a job is listed
        // before its first event is written, so an early failure means "not yet"
        // and saying so is noise about something that fixes itself seconds later.
        if (failures === GIVE_UP) $.ui.log(`Codex tasks ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await refreshViews($, state)
    if (state.views.size && !state.opened) {
      state.opened = true
      await $.ui.open({ id: PANE, title: 'Codex tasks', closeOnEscape: true, rows: 24 })
        .catch(error => $.ui.log(`Codex tasks pane: ${error instanceof Error ? error.message : String(error)}`))
    }
    if (!lines.length && !state.pending.length) {
      // Written even with nothing to say: this round still moved cursors and
      // claimed endings, and losing them makes the next round report twice.
      state.ledger = ledger
      await $.store.set(state.key, ledger)
      return
    }
    for (const line of lines) $.ui.toast(clip(line.text, 140), { timeoutMs: 6000 })
    // A job whose follow row is on screen is reported by its own agent; pushing
    // it again would wake the director twice for one event.
    const mine = [...state.pending, ...lines.filter(line =>
      !state.followed.has(line.jobId) && !state.monitors.has(line.cwd))]
    // Held, not cleared: a round that cannot push (a turn is running) used to
    // empty the carry and drop with it every line an earlier refusal had kept.
    state.pending = mine.slice(-12)
    if (state.push && mine.length && !state.busy) {
      // A plugin's own submit skips this plugin's prompt.submit hooks, so the
      // text itself is what the director reads; keep it short and let it fetch
      // the detail with the companion.
      const result = await $.prompt.submit({ text: `Codex tasks\n${mine.slice(0, 6).map(line => clip(line.text, 200)).join('\n')}` })
      // The host refuses a submit made too soon after the plugin's last one.
      // Carry those lines to the next poll rather than failing the round: the
      // cursors this round advanced are committed either way, so a refusal must
      // not make every job re-read and re-report the events already seen.
      if (!result.drop) state.pending = []
    }
    state.ledger = ledger
    await $.store.set(state.key, ledger)
  } catch (error) {
    $.ui.log(`Codex tasks: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.polling = false
  }
}

// Run once per module environment. A saved edit reloads the module and drops
// the old environment's timers, and session.start never fires again in that
// session, so a turn re-arms the watcher when it is not running.
async function bootstrap($: EngineInterface, state: State, push: boolean) {
  if (state.script || state.booting) return
  state.booting = true
  try {
    if (!(await $.session.surfaces()).length) return
    state.push = push
    state.cwd = await $.session.cwd()
    state.sessionId = await $.session.id()
    state.key = `${$.plugin.name}:tasks:${state.sessionId}`
    state.ledger = (await $.store.get(state.key) as Ledger | undefined) ?? {}
    const home = await $.env.get('HOME')
    if (!home) return
    state.home = home
    // The skill is `code-director/scripts/dispatch.sh` now and was
    // `codex-director/scripts/codex-worker.sh`; either may be the one installed
    // while the skill and the plugin are released apart, so the pane takes
    // whichever answers rather than going blind between them.
    for (const worker of ['code-director/scripts/dispatch.sh', 'code-director/scripts/codex-worker.sh',
      'codex-director/scripts/codex-worker.sh'].map(path => `${home}/.claude/skills/${path}`)) {
      const found = await $.process.run(['bash', worker, 'companion'], { cwd: state.cwd, timeoutMs: 3000 }).catch(() => null)
      if (found?.exitCode !== 0 || !found.stdout.trim()) continue
      state.worker = worker
      state.script = found.stdout.trim()
      break
    }
    if (!state.script) return
    // A module reload re-runs this, so the scan floor must be when the session
    // began, not when the module last loaded: otherwise every job dispatched
    // before the reload drops out of the pane.
    const now = await $.clock.now()
    const sinceKey = `${state.key}:since`
    const stored = await $.store.get(sinceKey)
    state.since = typeof stored === 'number' ? stored : now - 60_000
    if (typeof stored !== 'number') await $.store.set(sinceKey, state.since)
    // A reload builds a fresh state while the monitors the last one armed are
    // still running: without this the module arms a second set and every event
    // wakes the director twice. An entry older than the host's cap is gone.
    const armed = await $.store.get(`${state.key}:monitors`)
    for (const [root, at] of Object.entries((armed ?? {}) as Record<string, number>)) {
      if (now - at < MONITOR_MS) state.monitors.set(root, { armedAt: at })
    }
    $.clock.every(500, () => { void refreshViews($, state) })
    $.clock.every(2000, () => { void poll($, state) })
    // The heading's clock moves on its own, and nothing else asks for the redraw
    // that shows it: a job that is thinking writes no view file, so the pane
    // would sit at the second of the last event and then jump over the silence.
    // Asking only when the figure it draws has actually changed keeps a task
    // that has been running for an hour from rebuilding the trace every second.
    $.clock.every(1000, async () => {
      if (!state.opened) return
      const now = await $.clock.now()
      const clock = [...state.views.values()].filter(view => !isOver(view))
        .map(view => elapsed(view.startedAt, now)).join(' ')
      if (!clock || clock === state.clock) return
      state.clock = clock
      $.ui.invalidate('ui.render')
    })
    void poll($, state)
  } finally {
    state.booting = false
  }
}

// Everything this session started, newest first, dropping what ended long ago.
function visibleJobs(state: State): LiveView[] {
  return [...state.views.values()]
    .filter(view => !isOver(view) || !view.endedAt || Date.parse(view.endedAt) > Date.now() - KEEP_MS)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function registerTaskPane(on: On, followed: Set<string> = new Set<string>(), background?: string, push = true) {
  const state: State = {
    cwd: '', home: '', script: '', sessionId: '', key: '', push,
    roots: new Set<string>(), paths: new Map<string, string>(), mtimes: new Map<string, number>(), worker: '',
    views: new Map<string, LiveView>(), ledger: {},
    ticks: 0, since: 0, busy: false, booting: false, polling: false, opened: false, selected: null,
    followed, unreadable: new Map<string, number>(), pending: [], toEnd: false, pinned: true, clock: '',
    monitors: new Map<string, { armedAt: number; checkedAt?: number }>(),
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.isInteractive) void bootstrap($, state, push)
    return result
  })
  on('turn.start', ($, e, next) => {
    state.busy = true
    if (!state.script) void bootstrap($, state, push)
    return next(e)
  })
  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      state.busy = false
      void poll($, state)
    }
    return next(e)
  })
  // A dispatch creates its job in whatever repository the brief names; waiting
  // for the next rescan would show it up to half a minute late.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const line = String(e.command ?? '')
    const result = await next(e)
    if (/(?:codex-worker|dispatch)\.sh|codex-companion\.mjs/.test(line)) {
      state.ticks = 0
      void poll($, state)
    }
    return result
  })
  // `/codex:tasks` opens the pane and switches it; answering without next()
  // keeps the command inside the session instead of sending it to the model.
  on('command.run', async ($, e, next) => {
    if (!/(^|:)tasks$/.test(e.command)) return next(e)
    let jobs = visibleJobs(state)
    if (!jobs.length) {
      await poll($, state)
      jobs = visibleJobs(state)
    }
    // The pane opens whether or not anything is running: it is where tasks are
    // watched, and asking for it before dispatching one is a fair thing to do.
    const wanted = e.args.trim()
    if (wanted && jobs.length) {
      const index = Number(wanted)
      const match = Number.isInteger(index) && index >= 1 && index <= jobs.length
        ? jobs[index - 1]
        : jobs.find(view => view.label.toLowerCase().includes(wanted.toLowerCase()))
      if (!match) return { text: `No task matches "${wanted}". Open tasks: ${jobs.map((view, at) => `${at + 1} ${view.label}`).join(', ')}` }
      state.selected = match.jobId
      state.toEnd = true
    }
    state.opened = true
    await $.ui.open({ id: PANE, title: 'Codex tasks', focus: true, closeOnEscape: true, rows: 24 })
    $.ui.invalidate('ui.render')
    if (!jobs.length) return { text: 'Codex tasks · nothing dispatched from this session yet' }
    const shown = jobs.find(view => view.jobId === state.selected) ?? jobs[0]!
    return { text: `Codex tasks · ${shown.label}` }
  })
  // Closing the pane is the person's call, so it is not reopened for them.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE) state.opened = false
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey || state.opened || !state.views.size) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const running = [...state.views.values()].filter(view => !isOver(view)).length
    return Box({ children: [Button({
      key: 'codex_tasks_open', plain: true,
      label: `Codex tasks${running ? ` · ${running} running` : ''}`,
      onPress: () => { state.opened = true; void $.ui.open({ id: PANE, title: 'Codex tasks', focus: true, closeOnEscape: true, rows: 24 }) },
    })] })
  })
  // Tab walks the list at the pane's foot and a task is chosen by landing on
  // its row, with no press to follow. The arrows are the engine's scroll keys
  // while the pane has rows to scroll, so they move the trace, not the ring.
  on('ui.focus', ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const jobId = /^codex_tab_(.+)$/.exec(String(e.element ?? ''))?.[1]
    if (jobId && jobId !== state.selected) {
      state.selected = jobId
      state.toEnd = true
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
  // Where the window sits is a render prop; how tall the tree is is not, so
  // whether the window is at the end can only be answered here, where the move
  // carries both. The pane rides the end until the reader scrolls off it, and
  // takes it up again where they scroll back down to it.
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') state.pinned = e.offset >= e.contentRows - e.bodyRows
    return next(e)
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    // A reload builds a fresh state while the pane it left behind is still on
    // screen, and the band would offer to open one that is already open. The
    // pane asking to be drawn is the proof that it is.
    state.opened = true
    const jobs = visibleJobs(state)
    // A task that leaves the pane takes the focus with it, and the trace drawn
    // in its place starts at its end: the window is where the departed task's
    // reader left it, and a shrinking tree raises no scroll event to say so.
    if (state.selected && !jobs.some(view => view.jobId === state.selected)) {
      state.selected = null
      state.toEnd = true
    }
    const select = (jobId: string) => {
      state.selected = state.selected === jobId ? null : jobId
      // A job is switched to in order to see what it is doing now, and its
      // trace is drawn whole, so the window starts at the end of it.
      state.toEnd = true
      $.ui.invalidate('ui.render')
    }
    const tree = paneBody($.ui.resolve(e), jobs, Math.max(20, e.props.bodyColumns),
      Math.max(6, e.props.scroll?.bodyRows ?? 12), await $.clock.now(), state.selected, select, background)
    // The status line is the tree's last row and the engine scrolls the whole
    // tree, so a trace that grows carries the status off the bottom of the
    // window. `end` keeps up with a tree that grows until something else moves
    // the window, and the reader moving it is what clears the pin.
    if (state.toEnd || state.pinned) {
      state.toEnd = false
      // Sent from here, not from the press: invalidate only asks for a redraw,
      // so a move made there would land on the trace being replaced.
      void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {})
    }
    return tree
  })
}
