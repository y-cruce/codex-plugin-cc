import type { On, PluginOptions } from 'claude-code'
import { register as registerLiveToolRow } from './live-tool-row/register.ts'
import { registerTaskPane } from './task-pane/register.ts'

export function register(on: On, options: PluginOptions = {}) {
  // A job with a visible follow row already reports to the director through the
  // agent that runs it; the pane shows it but must not report it twice.
  const followed = new Set<string>()
  registerLiveToolRow(on, followed)
  registerTaskPane(on, followed, typeof options.paneBackground === 'string' ? options.paneBackground : undefined)
}
