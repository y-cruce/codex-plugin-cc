import type { EngineInterface, On } from 'claude-code'
import { clip, elapsed } from '../live-tool-row/format.ts'
import { isOver, latestRound } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'
import { paneBody } from './pane.ts'

type Thread = { id: string; recordId: string; jobId: string; label: string | null; status: string; startedAt: string | null
  activeRoundId: string | null; latestRoundId: string; sessionIds: string[]; viewPath: string; historyAvailable?: boolean }
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
  // The element the pane's focus ring was last put on, to tell Tab off the
  // last task from Shift+Tab coming round from the pane's close mark.
  ring: string | undefined
  // Folds in the trace the reader opened, by thread and fold.
  expanded: Set<string>
  followed: Set<string>
  unreadable: Map<string, number>
  owners: Map<string, string[]>
  rootIds: Map<string, Set<string>>
  pending: { jobId: string; cwd: string; text: string }[]
  worker: string
  toEnd: boolean
  pinned: boolean
  clock: string
  monitors: Map<string, { armedAt: number; checkedAt?: number }>
  liveRoots: Set<string>
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

export function shouldDropMonitorExpiry(
  text: string,
  watchedRoots: Iterable<string>,
  liveRoots: ReadonlySet<string>,
  canRearm: boolean,
): boolean {
  if (!canRearm || !text.includes('<event>[Monitor expired after ')) return false
  for (const root of watchedRoots) {
    if (!liveRoots.has(root)) continue
    const name = root.split('/').at(-1) ?? root
    const escaped = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    if (text.includes(`<summary>Monitor event: "Codex job events in ${escaped}"</summary>`)) return true
  }
  return false
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
  const found = await $.process.run(['pgrep', '-f', `(codex-worker|dispatch)\.sh events --cwd ${root} --session ${state.sessionId}`],
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
    if (!monitor && await watching($, state, root)) {
      state.monitors.set(root, { armedAt: now })
      await recordMonitors($, state)
      continue
    }
    state.monitors.set(root, { armedAt: now })
    // Awaited, or a reload between the arm and the write reads the old set and
    // arms a second monitor for the same repository.
    await recordMonitors($, state)
    void $.tool.call({
      tool: 'Monitor',
      command: `bash ${state.worker} events --cwd ${root} --session ${state.sessionId}`,
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
          // A pane follows only work this session dispatched; sharing the
          // repository is not ownership, and another session arms its own watch.
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
  const sessionId = state.sessionId
  for (const [id, path] of state.paths) {
    try {
      const stat = await $.fs.stat(path)
      if (sessionId !== state.sessionId) return
      if (stat.mtimeMs === state.mtimes.get(id)) continue
      const view = JSON.parse(await $.fs.read(path)) as LiveView
      if (sessionId !== state.sessionId) return
      if (view.schemaVersion !== 1 || (view.recordId ?? view.jobId) !== id) continue
      const owners = state.owners.get(id) ?? (view.rounds ?? []).map(round => round.sessionId).filter((sessionId): sessionId is string => Boolean(sessionId))
      const foreign = owners.length > 0 && !owners.includes(state.sessionId)
      state.mtimes.set(id, stat.mtimeMs)
      state.views.set(id, { ...view, foreign })
      changed = true
    } catch {
      if (sessionId !== state.sessionId) return
      // A view whose file is gone is a job that was pruned, and the comment
      // here used to say so while nothing acted on it: the task stayed in the
      // tabs for the rest of the session. A path that fails only this once is
      // found again by the next poll, which asks the companion for it.
      if (!state.views.has(id) && !state.paths.has(id)) continue
      state.views.delete(id)
      state.paths.delete(id)
      state.mtimes.delete(id)
      state.owners.delete(id)
      changed = true
    }
  }
  if (changed) $.ui.invalidate('ui.render')
}

async function bindSession($: EngineInterface, state: State, sessionId: string) {
  state.sessionId = sessionId
  state.key = `${$.plugin.name}:tasks:${sessionId}`
  state.ledger = (await $.store.get(state.key) as Ledger | undefined) ?? {}
  state.roots = new Set([state.cwd])
  state.paths.clear()
  state.mtimes.clear()
  state.views.clear()
  state.owners.clear()
  state.rootIds.clear()
  state.pending = []
  state.unreadable.clear()
  state.liveRoots.clear()
  state.selected = null
  state.expanded.clear()
  state.clock = ''
  state.ticks = 0
  const now = await $.clock.now()
  const sinceKey = `${state.key}:since`
  const stored = await $.store.get(sinceKey)
  state.since = typeof stored === 'number' ? stored : now - 60_000
  if (typeof stored !== 'number') await $.store.set(sinceKey, state.since)
  // A reload or /clear may leave an earlier session's watches running.
  state.monitors.clear()
  const armed = await $.store.get(`${state.key}:monitors`)
  for (const [root, at] of Object.entries((armed ?? {}) as Record<string, number>)) {
    if (now - at < MONITOR_MS) state.monitors.set(root, { armedAt: at })
  }
  $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface, state: State) {
  if (state.polling || !state.script) return
  state.polling = true
  try {
    const sessionId = await $.session.id()
    if (sessionId !== state.sessionId) {
      state.cwd = await $.session.cwd()
      await bindSession($, state, sessionId)
    }
    if (state.ticks % RESCAN_TICKS === 0) await discoverRoots($, state)
    state.ticks += 1
    const now = await $.clock.now()
    const found: { thread: Thread; cwd: string }[] = []
    const returnedByRoot = new Map<string, Set<string>>()
    for (const root of state.roots) {
      if ((state.unreadable.get(root) ?? 0) >= GIVE_UP) continue
      try {
        const listed = JSON.parse(await companion($, state, root,
          ['threads', '--json', '--finished-after', String(now - KEEP_MS)])) as { threads: Thread[] }
        state.unreadable.delete(root)
        const threads = listed.threads.filter(thread => thread.sessionIds.includes(state.sessionId))
        returnedByRoot.set(root, new Set(threads.map(thread => thread.id)))
        for (const thread of threads) found.push({ thread, cwd: root })
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
    const returned = new Set(found.map(({ thread }) => thread.id))
    let dropped = false
    for (const [root, ids] of returnedByRoot) {
      const previous = state.rootIds.get(root) ?? new Set<string>()
      state.rootIds.set(root, ids)
      for (const id of previous) {
        if (ids.has(id) || returned.has(id) || [...state.rootIds].some(([other, owned]) => other !== root && owned.has(id))) continue
        const existed = state.paths.has(id) || state.owners.has(id) || state.mtimes.has(id) || state.views.has(id)
        state.paths.delete(id)
        state.owners.delete(id)
        state.mtimes.delete(id)
        state.views.delete(id)
        dropped ||= existed
      }
    }
    if (dropped) $.ui.invalidate('ui.render')
    for (const { thread } of found) {
      state.paths.set(thread.id, thread.viewPath)
      state.owners.set(thread.id, thread.sessionIds)
    }
    // Before the loop, not after: the reconciliation below reads these views for
    // the text it reports, and a round that refreshed them afterwards had none
    // to read on its first pass and sent an empty line.
    await refreshViews($, state)
    const ledger: Ledger = { ...state.ledger }
    const lines: { jobId: string; cwd: string; text: string }[] = []
    state.liveRoots = new Set(found.filter(entry => !DONE.includes(entry.thread.status)).map(entry => entry.cwd))
    await ensureMonitors($, state, state.liveRoots, now)
    for (const { thread, cwd } of found) {
      const job = { id: thread.jobId, label: thread.label, status: thread.status }
      // A job dispatched seconds ago is listed before its event history is
      // written, so one failure means "not yet", not "never". Keep trying, and
      // give up only once it has failed a few polls in a row.
      if ((state.unreadable.get(job.id) ?? 0) >= GIVE_UP) continue
      try {
        // A job already over the first time it is seen ended before this pane
        // existed, or before a reload rebuilt it: there is nothing to wake the
        // director for, so its terminal state is recorded without a line.
        const first = !state.ledger[job.id]
        // Keep the ownership marker defensive even though the root listing
        // above rejects every thread that this session did not dispatch.
        const foreign = thread.sessionIds.length > 0 && !thread.sessionIds.includes(state.sessionId)
        ledger[job.id] = { ...ledger[job.id] }
        const receipt = ledger[job.id]!
        const view = state.views.get(thread.id)
        if (view && Boolean(view.foreign) !== foreign) state.views.set(thread.id, { ...view, foreign })
        if (view && job.status === 'queued' && view.status !== 'queued') {
          state.views.set(thread.id, { ...view, status: 'queued', endedAt: null })
        }
        // The owner process writes the ending, so a job whose owner died never
        // wrote one and its view says running for ever -- the pane kept a task
        // killed an hour ago in its tabs and counted it among the live ones.
        // The store knows better, and it is what the listing reports.
        if (view && DONE.includes(job.status) && !isOver(view)) {
          state.views.set(thread.id, { ...view, status: job.status as LiveView['status'], activeRoundId: null,
            endedAt: view.tail.at(-1)?.at ?? new Date(await $.clock.now()).toISOString() })
        }
        // A legacy job predates the event store, and one that died before its
        // first event never opened one: no history is the answer, not a failure
        // worth retrying. Replaying it until the give-up count spends five
        // processes a poll and then reports a permanent fact as an error line.
        if (thread.historyAvailable !== false) {
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
          const announce = !DONE.includes(job.status) && !foreign
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
          if (!first && !foreign && !lines.some(line => line.jobId === job.id && line.text.includes(`job.${status}`))) {
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
    // What the pane would draw, not every view the scan loaded: a repository
    // keeps its finished jobs for weeks, so a fresh session found four threads
    // from a fortnight ago, opened the pane for them, and drew "nothing
    // dispatched yet" -- the list the body works from had dropped them all.
    if (visibleThreads(state).length && !state.opened) {
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
    await bindSession($, state, await $.session.id())
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
        .map(view => elapsed(latestRound(view)?.startedAt ?? view.startedAt, now)).join(' ')
      if (!clock || clock === state.clock) return
      state.clock = clock
      $.ui.invalidate('ui.render')
    })
    void poll($, state)
  } finally {
    state.booting = false
  }
}

// Every thread visible to this session, newest round first, dropping what ended
// long ago.
function visibleThreads(state: State): LiveView[] {
  return [...state.views.values()]
    .filter(view => !isOver(view) || !view.endedAt || Date.parse(view.endedAt) > Date.now() - KEEP_MS)
    .sort((a, b) => {
      const latest = (view: LiveView) => view.rounds?.find(round => round.jobId === view.latestRoundId)?.startedAt ?? view.startedAt
      return latest(b).localeCompare(latest(a))
    })
}

export function registerTaskPane(on: On, followed: Set<string> = new Set<string>(), background?: string, push = true) {
  const state: State = {
    cwd: '', home: '', script: '', sessionId: '', key: '', push,
    roots: new Set<string>(), paths: new Map<string, string>(), mtimes: new Map<string, number>(), worker: '',
    owners: new Map<string, string[]>(), rootIds: new Map<string, Set<string>>(),
    views: new Map<string, LiveView>(), ledger: {},
    ticks: 0, since: 0, busy: false, booting: false, polling: false, opened: false, selected: null, ring: undefined, expanded: new Set<string>(),
    followed, unreadable: new Map<string, number>(), pending: [], toEnd: false, pinned: true, clock: '',
    monitors: new Map<string, { armedAt: number; checkedAt?: number }>(),
    liveRoots: new Set<string>(),
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
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind !== 'task-notification'
      || !shouldDropMonitorExpiry(e.text, state.monitors.keys(), state.liveRoots, Boolean(state.script))) return next(e)
    return { drop: 'Codex tasks monitor expiry is re-armed by the pane' }
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
  // `/codex:tasks` opens and closes the pane and switches its task; answering without next()
  // keeps the command inside the session instead of sending it to the model.
  on('command.run', async ($, e, next) => {
    if (!/(^|:)tasks$/.test(e.command)) return next(e)
    let threads = visibleThreads(state)
    if (!threads.length) {
      await poll($, state)
      threads = visibleThreads(state)
    }
    // The pane opens whether or not anything is running: it is where tasks are
    // watched, and asking for it before dispatching one is a fair thing to do.
    const wanted = e.args.trim()
    // Bare, the command is the pane's switch: it closes a pane that is open.
    if (!wanted && state.opened) {
      state.opened = false
      await $.ui.close({ id: PANE })
      return { text: 'Codex tasks · closed' }
    }
    if (wanted && threads.length) {
      const index = Number(wanted)
      const match = Number.isInteger(index) && index >= 1 && index <= threads.length
        ? threads[index - 1]
        : threads.find(view => view.label.toLowerCase().includes(wanted.toLowerCase()))
      if (!match) return { text: `No task matches "${wanted}". Open tasks: ${threads.map((view, at) => `${at + 1} ${view.label}`).join(', ')}` }
      state.selected = match.recordId ?? match.jobId
      state.toEnd = true
    }
    state.opened = true
    await $.ui.open({ id: PANE, title: 'Codex tasks', focus: true, closeOnEscape: true, rows: 24 })
    $.ui.invalidate('ui.render')
    if (!threads.length) return { text: 'Codex tasks · nothing dispatched from this session yet' }
    const shown = threads.find(view => (view.recordId ?? view.jobId) === state.selected) ?? threads[0]!
    return { text: `Codex tasks · ${shown.label}` }
  })
  // Closing the pane is the person's call, so it is not reopened for them.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE) state.opened = false
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    // Same list as the pane's own body: a session with nothing to show had the
    // button sitting under its prompt for as long as it ran.
    const threads = visibleThreads(state)
    if (e.props.hasSurvey || state.opened || !threads.length) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const running = threads.filter(view => ['running', 'waiting-for-answer'].includes(view.status)).length
    const queued = threads.filter(view => view.status === 'queued').length
    const activity = [running ? `${running} running` : '', queued ? `${queued} queued` : ''].filter(Boolean).join(' · ')
    return Box({ children: [Button({
      key: 'codex_tasks_open', plain: true,
      label: `Codex tasks${activity ? ` · ${activity}` : ''}`,
      onPress: () => { state.opened = true; void $.ui.open({ id: PANE, title: 'Codex tasks', focus: true, closeOnEscape: true, rows: 24 }) },
    })] })
  })
  // Tab walks the list at the pane's foot and a task is chosen by landing on
  // its row, with no press to follow. The ring takes every button in the pane,
  // and each fold in the trace is one: a trace with a dozen folds put a dozen
  // stops between two tasks. The list is first in the ring (see paneBody), so a
  // move onto a fold goes on to a task instead -- the first when it came on
  // off the last, the last when it came back from the close mark. The
  // arrows are the engine's scroll keys while the pane has rows to scroll, so
  // they move the trace, not the ring.
  on('ui.focus', ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const tabs = visibleThreads(state).map(view => `codex_tab_${view.recordId ?? view.jobId}`)
    const element = e.element?.startsWith('codex_fold_') && tabs.length
      ? state.ring === tabs.at(-1) ? tabs[0]! : tabs.at(-1)!
      : e.element
    state.ring = element
    const recordId = /^codex_tab_(.+)$/.exec(element ?? '')?.[1]
    if (recordId && recordId !== state.selected) {
      state.selected = recordId
      state.toEnd = true
      $.ui.invalidate('ui.render')
    }
    return next({ ...e, element })
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
    const threads = visibleThreads(state)
    if (state.selected && !threads.some(view => (view.recordId ?? view.jobId) === state.selected)) {
      state.selected = null
      state.toEnd = true
    }
    const select = (recordId: string) => {
      state.selected = recordId
      // A click leaves the ring where Tab last put it, so the next Tab went on
      // from a task other than the one on screen, or landed on it and changed
      // nothing. The ring follows the click.
      state.ring = `codex_tab_${recordId}`
      void $.ui.focus({ requestId: PANE, key: state.ring }).catch(() => {})
      // A thread is switched to in order to see what it is doing now, and its
      // trace is drawn whole, so the window starts at the end of it.
      state.toEnd = true
      $.ui.invalidate('ui.render')
    }
    const shown = threads.find(view => (view.recordId ?? view.jobId) === state.selected) ?? threads[0]
    const foldId = (key: string) => `${shown?.recordId ?? shown?.jobId}:${key}`
    const fold = {
      isOpen: (key: string) => state.expanded.has(foldId(key)),
      toggle: (key: string) => {
        if (!state.expanded.delete(foldId(key))) state.expanded.add(foldId(key))
        $.ui.invalidate('ui.render')
      },
    }
    const tree = paneBody($.ui.resolve(e), threads, Math.max(20, e.props.bodyColumns),
      Math.max(6, e.props.scroll?.bodyRows ?? 12), await $.clock.now(), state.selected, select, background, fold)
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
