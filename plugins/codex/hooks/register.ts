import type { On, PluginOptions } from 'claude-code'
import { register as registerLiveToolRow } from './live-tool-row/register.ts'
import { registerDirectorChannel } from './director-channel/register.ts'
import { registerTaskPane } from './task-pane/register.ts'
import { directorTools, registerDirectorTools } from './director-tools/register.ts'

export function register(on: On, options: PluginOptions = {}) {
  registerDirectorChannel(on)
  // A job with a visible follow row already reports to the director through the
  // agent that runs it; the pane shows it but must not report it twice.
  const followed = new Set<string>()
  registerLiveToolRow(on, followed)
  // A job started through the director's dispatch tool reaches the pane at its
  // next poll, as one started from Bash does.
  const tools = directorTools()
  registerTaskPane(on, followed, typeof options.paneBackground === 'string' ? options.paneBackground : undefined, true, tools)
  registerDirectorTools(on, tools)
}
