import type { EngineInterface, On } from 'claude-code'
import { clip, elapsed } from '../live-tool-row/format.ts'
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
  pending: { jobId: string; text: string }[]
  toEnd: boolean
  clock: string
}

const PANE = 'codex_tasks'
const DONE = ['completed', 'failed', 'cancelled']
// The events a director must act on: the same set `codex-worker.sh follow`
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
    } catch { /* the view goes away when a job is pruned */ }
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
      try {
        const listed = JSON.parse(await companion($, state, root, ['list', '--json'])) as { jobs: Job[] }
        for (const job of listed.jobs) found.push({ job, cwd: root })
      } catch (error) {
        $.ui.log(`Codex tasks ${root}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Before the loop, not after: the reconciliation below reads these views for
    // the text it reports, and a round that refreshed them afterwards had none
    // to read on its first pass and sent an empty line.
    await refreshViews($, state)
    const ledger: Ledger = { ...state.ledger }
    const lines: { jobId: string; text: string }[] = []
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
        state.unreadable.delete(job.id)
        if (!state.paths.has(job.id)) {
          state.paths.set(job.id, (await companion($, state, cwd, ['view-path', job.id])).trim())
        }
        const view = state.views.get(job.id)
        {
          // Read during a director turn as well. A turn can run for half an
          // hour, and a pane that stops reading for it shows a task frozen at
          // whatever it was doing when the turn began, then jumps.
          const args = ['replay', job.id, '--limit', '8']
          if (receipt.cursor) args.push('--after', receipt.cursor)
          const rows = (await companion($, state, cwd, args)).trim().split('\n')
            .flatMap(row => { try { return [JSON.parse(row) as { type: string; seq?: string; text?: string; nextCursor?: string }] } catch { return [] } })
          const events = rows.filter(row => row.seq)
          // A job already over the first time it is seen is history, not news:
          // its events are consumed so the cursor moves past them, and none of
          // them wakes the director.
          const announce = !(first && DONE.includes(job.status))
          for (const event of events.filter(row => ACTIONABLE.includes(row.type))) {
            const line = pushLine(job.label ?? job.id, event, view)
            if (announce && line) lines.push({ jobId: job.id, text: line })
            // Claimed here as well, or the reconciliation below reports the same
            // ending a second time once this cursor has moved past it.
            if (event.type.startsWith('job.')) receipt.terminal = event.type.slice(4)
          }
          if (events.length) receipt.cursor = rows.at(-1)?.nextCursor ?? receipt.cursor
        }
        // A job that ends while the director is mid-turn still has to be
        // reported once, so the terminal state is reconciled on its own.
        const status = DONE.includes(view?.status ?? '') ? view!.status : DONE.includes(job.status) ? job.status : ''
        if (status && receipt.terminal !== status) {
          if (!first && !lines.some(line => line.jobId === job.id && line.text.includes(`job.${status}`))) {
            lines.push({ jobId: job.id, text: `${job.label ?? job.id} · job.${status}: ${clip(view?.lastMessage?.text ?? '', 300)}` })
          }
          receipt.terminal = status
        }
      } catch (error) {
        const failures = (state.unreadable.get(job.id) ?? 0) + 1
        state.unreadable.set(job.id, failures)
        // Said once: the poll runs every two seconds and would otherwise repeat
        // the same line for as long as the job is listed.
        if (failures === 1) $.ui.log(`Codex tasks ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
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
    const mine = [...state.pending, ...lines.filter(line => !state.followed.has(line.jobId))]
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
    const found = await $.process.run(['bash', `${home}/.claude/skills/codex-director/scripts/codex-worker.sh`, 'companion'],
      { cwd: state.cwd, timeoutMs: 3000 })
    if (found.exitCode !== 0) return
    state.script = found.stdout.trim()
    // A module reload re-runs this, so the scan floor must be when the session
    // began, not when the module last loaded: otherwise every job dispatched
    // before the reload drops out of the pane.
    const now = await $.clock.now()
    const sinceKey = `${state.key}:since`
    const stored = await $.store.get(sinceKey)
    state.since = typeof stored === 'number' ? stored : now - 60_000
    if (typeof stored !== 'number') await $.store.set(sinceKey, state.since)
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
      const clock = [...state.views.values()].filter(view => !DONE.includes(view.status))
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
    .filter(view => !DONE.includes(view.status) || !view.endedAt || Date.parse(view.endedAt) > Date.now() - 15 * 60_000)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function registerTaskPane(on: On, followed: Set<string> = new Set<string>(), background?: string, push = true) {
  const state: State = {
    cwd: '', home: '', script: '', sessionId: '', key: '', push,
    roots: new Set<string>(), paths: new Map<string, string>(), mtimes: new Map<string, number>(),
    views: new Map<string, LiveView>(), ledger: {},
    ticks: 0, since: 0, busy: false, booting: false, polling: false, opened: false, selected: null,
    followed, unreadable: new Map<string, number>(), pending: [], toEnd: false, clock: '',
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
    if (line.includes('codex-worker.sh') || line.includes('codex-companion.mjs')) {
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
    const running = [...state.views.values()].filter(view => !DONE.includes(view.status)).length
    return Box({ children: [Button({
      key: 'codex_tasks_open', plain: true,
      label: `Codex tasks${running ? ` · ${running} running` : ''}`,
      onPress: () => { state.opened = true; void $.ui.open({ id: PANE, title: 'Codex tasks', focus: true, closeOnEscape: true, rows: 24 }) },
    })] })
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const jobs = visibleJobs(state)
    // A task that leaves the pane takes the focus with it.
    if (state.selected && !jobs.some(view => view.jobId === state.selected)) state.selected = null
    const select = (jobId: string) => {
      state.selected = state.selected === jobId ? null : jobId
      // A job is switched to in order to see what it is doing now, and its
      // trace is drawn whole, so the window starts at the end of it.
      state.toEnd = true
      $.ui.invalidate('ui.render')
    }
    const tree = paneBody($.ui.resolve(e), jobs, Math.max(20, e.props.bodyColumns),
      Math.max(6, e.props.scroll?.bodyRows ?? 12), await $.clock.now(), state.selected, select, background)
    if (state.toEnd) {
      state.toEnd = false
      // Sent from here, not from the press: invalidate only asks for a redraw,
      // so a move made there would land on the trace being replaced.
      void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {})
    }
    return tree
  })
}
