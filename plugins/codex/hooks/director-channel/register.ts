import type { EngineInterface, On } from 'claude-code'
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

// Independent of pane bootstrap: /clear and /resume must bind before any job
// event can be consumed, even when the pane has never opened.
export function registerDirectorChannel(on: On) {
  let pid = ''
  let bound = ''
  const control = async ($: EngineInterface, sessionId: string, nonce?: string) => {
    if (!pid) {
      const ran = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 2000 })
      if (ran.exitCode !== 0 || !/^\d+$/.test(ran.stdout.trim())) return
      pid = ran.stdout.trim()
    }
    const result = await $.process.run(['node', `${$.plugin.root}/scripts/director-channel.mjs`, nonce ? 'confirm' : 'bind', pid, sessionId, ...(nonce ? [nonce] : [])], { timeoutMs: 5000 })
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Could not bind Codex director channel')
    bound = sessionId
  }
  const bind = async ($: EngineInterface) => {
    const sessionId = await $.session.id()
    if (sessionId !== bound) await control($, sessionId).catch(error => $.ui?.log(String(error), { to: 'debug' }))
  }
  on('classic.SessionStart', async ($, e, next) => {
    await $.env.set('CODEX_COMPANION_SESSION_ID', e.session_id)
    await $.env.set('CODEX_COMPANION_TRANSCRIPT_PATH', e.transcript_path)
    await control($, e.session_id).catch(error => $.ui?.log(String(error), { to: 'debug' }))
    return next(e)
  })
  on('session.start', async ($, e, next) => {
    await bind($)
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await bind($)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    const channel = e.origin.kind === 'channel' && e.origin.server === SERVER
    if (!channel && e.origin.kind !== 'task-notification') return next(e)
    const sessionId = await $.session.id()
    const attributes = channel ? /^\s*<channel\b([^>]*)>/.exec(e.text)?.[1] ?? '' : ''
    const nonce = /\bevent="probe"/.test(attributes) && new RegExp(`${PROBE} ([^\\s:<]+)`).exec(e.text)?.[1]
    if (nonce) {
      await control($, sessionId, nonce).catch(error => $.ui?.log(String(error), { to: 'debug' }))
      return { drop: 'Codex director channel confirmed' }
    }
    const owner = /\bsession="([^"]+)"/.exec(attributes)?.[1]
    if (owner && owner !== sessionId) return { drop: 'Codex event belongs to another session' }
    const reference = /\bdelivery="([A-Za-z0-9_-]+)"/.exec(attributes)?.[1]
    const refs = channel ? reference ? [reference] : [] : deliveryRefs(e.text)
    if (!refs.length) return next(e)
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
    // next() includes the pane's retired-Monitor filter. A dropped frame must
    // leave every item pending so channel replay or /resume can recover it.
    const result = await next({ ...e, text: stripDeliveryTags(text) })
    if (!result?.drop) await directorIngress($, 'accept', { events: pending.map(item => item.event), route: channel ? 'channel' : 'monitor' })
    return result
  })
}
