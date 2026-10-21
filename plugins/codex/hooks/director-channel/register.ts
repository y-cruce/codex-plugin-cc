import type { EngineInterface, Hook, On } from 'claude-code'
import { deliveryRefs, stripDeliveryTags } from '../../scripts/lib/director-refs.mjs'

const SERVER = 'plugin:codex:director'
const PROBE = 'codex-director-channel-probe'

// A hooks module may import only its own files and 'claude-code', so the
// delivery record on disk is read and written by a script (see its header).
export async function directorIngress($: EngineInterface, command: string, input: unknown) {
  const result = await $.process.run(['node', `${$.plugin.root}/scripts/director-ingress.mjs`, command, JSON.stringify(input)], { timeoutMs: 10000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || `director-ingress ${command} failed`)
  return JSON.parse(result.stdout)
}

type Submit = Parameters<Hook<'prompt.submit'>>[1]
// What the ingress decided: drop the submit, or let `event` through and, once
// the rest of the chain has not dropped it either, run directorIngress('accept')
// with `accept`. Data, not a closure: the scan follows $ only into named functions.
export type Admission = { drop: string } | { event: Submit; accept?: { events: unknown[]; route: string } }
export type DirectorChannel = { pid: string; bound: string }

// Independent of pane bootstrap: /clear and /resume must bind before any job
// event can be consumed, even when the pane has never opened. Claude Code takes
// one hook per event without a matcher from the whole module, so the task pane's
// session.start, turn.start and prompt.submit hooks call bindDirector and
// admitDirector first. Made apart from its registration, as directorTools() is:
// the scan refuses a module that keeps what a function given `on` returns.
export function directorChannel(): DirectorChannel {
  return { pid: '', bound: '' }
}

async function controlDirector($: EngineInterface, director: DirectorChannel, sessionId: string, nonce?: string) {
  if (!director.pid) {
    const ran = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 2000 })
    if (ran.exitCode !== 0 || !/^\d+$/.test(ran.stdout.trim())) return
    director.pid = ran.stdout.trim()
  }
  const result = await $.process.run(['node', `${$.plugin.root}/scripts/director-channel.mjs`, nonce ? 'confirm' : 'bind', director.pid, sessionId, ...(nonce ? [nonce] : [])], { timeoutMs: 5000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Could not bind Codex director channel')
  director.bound = sessionId
}

// A given session id is bound even when it is the one already bound.
export async function bindDirector($: EngineInterface, director: DirectorChannel, given?: string) {
  const sessionId = given ?? await $.session.id()
  if (!given && sessionId === director.bound) return
  try { await controlDirector($, director, sessionId) }
  catch (error) { $.ui.log(String(error), { to: 'debug' }) }
}

export async function admitDirector($: EngineInterface, director: DirectorChannel, e: Submit): Promise<Admission> {
  const channel = e.origin.kind === 'channel' && e.origin.server === SERVER
  if (!channel && e.origin.kind !== 'task-notification') return { event: e }
  const sessionId = await $.session.id()
  const attributes = channel ? /^\s*<channel\b([^>]*)>/.exec(e.text)?.[1] ?? '' : ''
  const nonce = /\bevent="probe"/.test(attributes) && new RegExp(`${PROBE} ([^\\s:<]+)`).exec(e.text)?.[1]
  if (nonce) {
    try { await controlDirector($, director, sessionId, nonce) }
    catch (error) { $.ui.log(String(error), { to: 'debug' }) }
    return { drop: 'Codex director channel confirmed' }
  }
  const owner = /\bsession="([^"]+)"/.exec(attributes)?.[1]
  if (owner && owner !== sessionId) return { drop: 'Codex event belongs to another session' }
  const reference = /\bdelivery="([A-Za-z0-9_-]+)"/.exec(attributes)?.[1]
  const refs = channel ? reference ? [reference] : [] : deliveryRefs(e.text)
  if (!refs.length) return { event: e }
  const { known, pending } = await directorIngress($, 'check', { refs, sessionId }) as { known: number; pending: { ref: string; event: unknown }[] }
  if (!known) return { drop: 'Codex event is unavailable or belongs to another session' }
  if (!pending.length) return { drop: 'Codex event already accepted or question closed' }
  const kept = new Set(pending.map(item => item.ref))
  const filter = (body: string) => body.split('\n').filter(line => {
    const items = deliveryRefs(line)
    return !items.length || items.some(ref => kept.has(ref))
  }).join('\n')
  const text = channel ? e.text.replace(/ delivery="[^"]*"/, '') : e.text.includes('<event>')
    ? e.text.replace(/<event>([\s\S]*?)<\/event>/g, (_match, body) => `<event>${filter(body)}</event>`)
    : filter(e.text)
  // The pane's retired-Monitor filter runs after this. A dropped frame must
  // leave every item pending so channel replay or /resume can recover it.
  return { event: { ...e, text: stripDeliveryTags(text) },
    accept: { events: pending.map(item => item.event), route: channel ? 'channel' : 'monitor' } }
}

export function registerDirectorChannel(on: On, director: DirectorChannel) {
  on('classic.SessionStart', async ($, e, next) => {
    await $.env.set('CODEX_COMPANION_SESSION_ID', e.session_id)
    await $.env.set('CODEX_COMPANION_TRANSCRIPT_PATH', e.transcript_path)
    await bindDirector($, director, e.session_id)
    return next(e)
  })
}
