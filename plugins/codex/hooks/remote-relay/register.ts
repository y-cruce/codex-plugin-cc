import type { EngineInterface } from 'claude-code'

// A session on another machine than its Codex jobs (a remote pod driving this user's Mac
// through a forwarded port) has no events to watch locally and, where channels are not
// available, no channel either. With ~/.claude/codex-remote-relay.json naming the relay's
// URL, this arms one Monitor running `remote-relay.mjs watch`, whose lines are the events
// `remote-relay.mjs serve` hands out on the machine that runs the jobs. Without that file
// it does nothing, so a local installation is unchanged.
const CONFIG = '.claude/codex-remote-relay.json'
const CHECK_MS = 15_000
const SETTLE_MS = 15_000
// The host ends a Monitor after thirty minutes; the watch ends itself a minute earlier and
// the next check arms a fresh one.
const MONITOR_MS = 1_800_000
const WATCH_MS = MONITOR_MS - 60_000

// owned maps each armed Monitor's task id to the session it watches. A session change
// (/clear, /resume) retires the previous session's watch: stopped, and its ending dropped.
type Relay = { owned: Map<string, string>; retired: Set<string>; armedAt: number; sessionId: string; checking: boolean }

export function relayCommand(root: string, sessionId: string, url: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  return `node ${quote(`${root}/scripts/remote-relay.mjs`)} watch --session ${quote(sessionId)} --url ${quote(url)} --for-ms ${WATCH_MS}`
}

// The watch's own end, the host's expiry of it, and anything from a retired watch need nothing
// from the director: the next check re-arms. A failed or killed live watch is still reported.
export function shouldDropRelayEnd(text: string, owned: ReadonlySet<string> | ReadonlyMap<string, string>, retired: ReadonlySet<string> = new Set()): boolean {
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]
  if (!taskId) return false
  if (retired.has(taskId)) return true
  if (!owned.has(taskId)) return false
  if (/<status>(?:failed|killed)<\/status>/.test(text)) return false
  if (/<event>\[Monitor (?:expired after [^\n<]*|timed out — re-arm if needed\.)\]<\/event>/.test(text)) return true
  return /<summary>Monitor ".*" (?:stream ended|ended without producing output)/.test(text)
    && !/<event>[\s\S]*?\S[\s\S]*?<\/event>/.test(text)
}

async function relayUrl($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (!home || !await $.fs.exists(`${home}/${CONFIG}`)) return null
  try {
    const url = (JSON.parse(await $.fs.read(`${home}/${CONFIG}`)) as { url?: unknown }).url
    return typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url) ? url.replace(/\/$/, '') : null
  } catch {
    return null
  }
}

function retireOthers($: EngineInterface, relay: Relay, sessionId: string) {
  for (const [taskId, watched] of relay.owned) {
    if (watched === sessionId) continue
    relay.owned.delete(taskId)
    relay.retired.add(taskId)
    void $.tool.call({ tool: 'TaskStop', task_id: taskId }).catch((error: unknown) => {
      $.ui.log(`Codex remote relay stop ${taskId}: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    })
  }
}

async function check($: EngineInterface, relay: Relay) {
  if (relay.checking) return
  relay.checking = true
  try {
    const url = await relayUrl($)
    if (!url) return
    const sessionId = await $.session.id()
    retireOthers($, relay, sessionId)
    const now = await $.clock.now()
    if (sessionId === relay.sessionId && now - relay.armedAt < SETTLE_MS) return
    const found = await $.process.run(['pgrep', '-f', `remote-relay\\.mjs watch --session ${sessionId} `], { timeoutMs: 2000 })
      .catch(() => null)
    if (found && found.exitCode === 0 && found.stdout.trim()) return
    relay.sessionId = sessionId
    relay.armedAt = now
    void $.tool.call({
      tool: 'Monitor',
      command: relayCommand($.plugin.root, sessionId, url),
      description: `Codex job events relayed from ${url}`,
      timeout_ms: MONITOR_MS,
    }).then(result => {
      const taskId = (result.result as { taskId?: string } | undefined)?.taskId
      if (!taskId) return
      relay.owned.set(taskId, sessionId)
      // The session may have changed while the call was pending.
      void $.session.id().then(current => { if (current !== sessionId) retireOthers($, relay, current) })
    }).catch((error: unknown) => {
      $.ui.log(`Codex remote relay monitor: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    })
  } finally {
    relay.checking = false
  }
}

export type RemoteRelay = Relay & { started: boolean }

// The task pane owns this plugin's session.start and prompt.submit hooks and calls these.
export function remoteRelay(): RemoteRelay {
  return { owned: new Map(), retired: new Set(), armedAt: 0, sessionId: '', checking: false, started: false }
}

export function startRemoteRelay($: EngineInterface, relay: RemoteRelay) {
  if (relay.started) return
  relay.started = true
  $.clock.after(0, () => { void check($, relay) })
  $.clock.every(CHECK_MS, () => { void check($, relay) })
}
