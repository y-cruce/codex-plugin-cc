import type { On, PluginOptions } from 'claude-code'
import { register as registerLiveToolRow } from './live-tool-row/register.ts'
import { registerTaskPane } from './task-pane/register.ts'

export function register(on: On, options: PluginOptions = {}) {
  // A command hook may time out before Node starts. Keep ownership available
  // to every later child even when its session env file was never exported.
  on('classic.SessionStart', async ($, e, next) => {
    await $.env.set('CODEX_COMPANION_SESSION_ID', e.session_id)
    await $.env.set('CODEX_COMPANION_TRANSCRIPT_PATH', e.transcript_path)
    return next(e)
  })
  // A job with a visible follow row already reports to the director through the
  // agent that runs it; the pane shows it but must not report it twice.
  const followed = new Set<string>()
  registerLiveToolRow(on, followed)
  registerTaskPane(on, followed, typeof options.paneBackground === 'string' ? options.paneBackground : undefined)
}
