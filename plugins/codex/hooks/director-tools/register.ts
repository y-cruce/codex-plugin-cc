import type { EngineInterface, On } from 'claude-code'

// Native tools for the code-director skill. Each one runs the same dispatch.sh
// subcommand (or companion command) the skill used to run from Bash, so the
// dispatch logic stays in one place; the tool only takes structured input,
// writes what the script reads from a file, and hands back its output.

type Context = { worker: string; companion: string; tmp: string; data: string | null }
type ToolInput = Record<string, unknown>
type Answer = { result: string } | { deny: string }

// dispatch.sh header lines, in the order the skill documents them. A value with
// a line break would start a header of its own, so those are refused.
const HEADERS: [field: string, header: string][] = [
  ['mode', 'MODE'], ['name', 'NAME'], ['cwd', 'CWD'], ['thread', 'THREAD'], ['base', 'BASE'],
  ['write', 'WRITE'], ['effort', 'EFFORT'], ['model', 'MODEL'], ['siblings', 'SIBLINGS'], ['sandbox', 'SANDBOX'],
  ['executor', 'EXECUTOR'], ['executor_mode', 'EXECUTOR_MODE'], ['executor_effort', 'EXECUTOR_EFFORT'],
  ['executor_command', 'EXECUTOR_COMMAND'], ['executor_args', 'EXECUTOR_ARGS'], ['executor_permissions', 'EXECUTOR_PERMISSIONS'],
]

const CWD = { type: 'string', description: 'Absolute path of the repository (or worktree) the job runs in.' }
const JOB = { type: 'string', description: 'The job id, as dispatch or an event line returned it.' }

const TOOLS = [
  {
    name: 'dispatch',
    description: 'Start one Codex task from a brief and return at once with STATUS, JOB, NAME and THREAD lines '
      + '(or STATUS: failed with an ERROR line). This is dispatch.sh dispatch with the headers as fields: '
      + 'the brief goes in `brief`, never through a shell command. The tasks pane and its Monitor report the job.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['investigate', 'implement', 'continue', 'review', 'adversarial-review'] },
        name: { type: 'string', description: 'Three to eight words saying what the task does; never a job id or a mode name.' },
        cwd: CWD,
        brief: { type: 'string', description: 'The brief body Codex reads (for review modes, the focus text).' },
        thread: { type: 'string', description: 'THREAD: the thread to continue (required for mode continue).' },
        base: { type: 'string', description: 'BASE: the base ref for review modes.' },
        write: { type: 'boolean', description: 'WRITE: yes, letting a continue round write files.' },
        effort: { type: 'string', description: 'EFFORT: only when the skill says to escalate.' },
        model: { type: 'string', description: 'MODEL: only when the user asks, or luna for bulk mechanical work.' },
        siblings: { type: 'string', description: 'SIBLINGS: one line naming the other running tasks.' },
        sandbox: { type: 'string', enum: ['full', 'network', 'default'], description: 'SANDBOX: only when the user asks.' },
        executor: { type: 'string', enum: ['codex', 'qoder', 'dsh', 'acp'], description: 'EXECUTOR: only when the user asks.' },
        executor_command: { type: 'string', description: 'EXECUTOR_COMMAND: override the ACP executable.' },
        executor_args: { type: 'array', items: { type: 'string' }, description: 'EXECUTOR_ARGS: arguments for the ACP executable; dsh defaults to --profile acp.' },
        executor_permissions: { type: 'string', enum: ['ask', 'allow-once'], description: 'ACP permission policy. dsh defaults to allow-once; ask forwards offered choices to the director.' },
        executor_mode: { type: 'string', description: 'EXECUTOR_MODE for a non-Codex executor.' },
        executor_effort: { type: 'string', description: 'EXECUTOR_EFFORT for a non-Codex executor.' },
      },
      required: ['mode', 'name', 'cwd', 'brief'],
    },
  },
  {
    name: 'message',
    description: 'Send a correction to a running job: dispatch.sh message. `delivery` is queue (the next turn, '
      + 'once this one ends; reach for it first), steer (read at Codex\'s next model request; Codex only) or '
      + 'interrupt (cancel the turn and run this now). Returns MESSAGED or MESSAGE_FAILED.',
    inputSchema: {
      type: 'object',
      properties: {
        job: JOB, cwd: CWD,
        text: { type: 'string', description: 'The correction, as Codex will read it.' },
        delivery: { type: 'string', enum: ['queue', 'steer', 'interrupt'] },
      },
      required: ['job', 'cwd', 'text', 'delivery'],
    },
  },
  {
    name: 'answer',
    description: 'Answer a structured question from a job: dispatch.sh answer. `answers` is keyed by the question ids, '
      + 'each { "answers": ["..."] }: the `ids=` list on the question event line, or job.live.questions in status. '
      + 'Never guess a key to find out the ids. '
      + 'Returns ANSWERED or ANSWER_FAILED; on "still pending after answer" check status before answering again.',
    inputSchema: {
      type: 'object',
      properties: {
        job: JOB, cwd: CWD,
        request: { type: 'string', description: 'The requestId of the pending request.' },
        answers: { type: 'object', additionalProperties: { type: 'object' } },
      },
      required: ['job', 'cwd', 'request', 'answers'],
    },
  },
  {
    name: 'result',
    description: 'Read a finished job\'s output, unchanged: the companion\'s result command.',
    inputSchema: { type: 'object', properties: { job: JOB, cwd: CWD }, required: ['job', 'cwd'] },
  },
  {
    name: 'status',
    description: 'Short text state of the jobs: one line per active job and the last few finished ones, or with `job` '
      + 'that job\'s line, its pending questions (request, ids, full text and options), undelivered notes and its last '
      + 'progress lines. Events already wake you, so call it only to check one job you have a reason to doubt. '
      + '`detail: true` returns the companion\'s full JSON (config, every thread, live controls): large, for debugging only.',
    inputSchema: { type: 'object', properties: { job: JOB, cwd: CWD, detail: { type: 'boolean' } }, required: ['cwd'] },
  },
  {
    name: 'tasks',
    description: 'List threads dispatched by this Claude session across repositories, newest first (20 by default). '
      + 'Use it to find a thread to continue or check what this session has running without reading results. '
      + 'Each line has the name, thread id (pending until known), executor, status, latest job and repository. '
      + '`all: true` includes other sessions and marks their lines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring of the task name.' },
        cwd: CWD,
        all: { type: 'boolean', description: 'Include tasks from other Claude sessions.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum threads to show; default 20.' },
      },
    },
  },
  {
    name: 'cancel',
    description: 'End a running or queued job now: the companion\'s cancel command. It interrupts the Codex turn and '
      + 'stops the job\'s process; files it already changed stay. To change a job\'s direction, use message with '
      + 'interrupt instead. TaskStop cannot stop a Codex job.',
    inputSchema: { type: 'object', properties: { job: JOB, cwd: CWD }, required: ['job', 'cwd'] },
  },
] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// The header text dispatch.sh reads: `KEY: value` lines, a blank line, the brief.
export function dispatchInput(input: ToolInput): string {
  const lines: string[] = []
  for (const [field, header] of HEADERS) {
    const value = input[field]
    if (value === undefined || value === null || value === '' || value === false) continue
    if (field === 'executor_args' && (!Array.isArray(value) || value.some(arg => typeof arg !== 'string'))) {
      throw new Error('executor_args must be an array of strings')
    }
    const line = field === 'executor_args' ? JSON.stringify(value) : value === true ? 'yes' : String(value)
    if (/[\r\n]/.test(line)) throw new Error(`${field} must be one line`)
    lines.push(`${header}: ${line}`)
  }
  const brief = text(input.brief)
  if (!brief.trim()) throw new Error('brief is empty')
  return `${lines.join('\n')}\n\n${brief.endsWith('\n') ? brief : `${brief}\n`}`
}

const DELIVERY: Record<string, string[]> = { queue: ['--queue'], steer: [], interrupt: ['--interrupt'] }

let written = 0

async function scratch($: EngineInterface, context: Context, suffix: string, body: string): Promise<string> {
  written += 1
  const path = `${context.tmp}/codex-director-${await $.session.id()}-${await $.clock.now()}-${written}${suffix}`
  await $.fs.write(path, body)
  return path
}

// dispatch.sh has read the file by the time it exits; there is no `$.fs` call
// that removes one.
async function discard($: EngineInterface, path: string) {
  await $.process.run(['rm', '-f', path], { timeoutMs: 5000 }).catch(() => {})
}

async function run($: EngineInterface, context: Context, argv: string[], cwd: string, timeoutMs: number, stdin?: string): Promise<Answer> {
  if (!cwd.startsWith('/')) return { deny: 'cwd must be an absolute path' }
  if (!(await $.fs.exists(cwd))) return { deny: `cwd does not exist: ${cwd}` }
  const ran = await $.process.run(argv, {
    cwd, stdin, timeoutMs,
    // The plugin running this tool is the one whose pane watches the job, so its
    // own companion is the one to use rather than whichever version is newest
    // in the plugin cache.
    env: {
      CODEX_COMPANION: context.companion, CODEX_COMPANION_SESSION_ID: await $.session.id(),
      ...(context.data ? { CLAUDE_PLUGIN_DATA: context.data } : {}),
    },
  })
  const out = [ran.stdout.trim(), ran.isStdoutTruncated ? '[output cut at 4 MiB]' : ''].filter(Boolean).join('\n')
  if (ran.exitCode === 0) return { result: out || '(no output)' }
  const err = ran.stderr.trim()
  return { deny: [out, err].filter(Boolean).join('\n') || `exited with code ${ran.exitCode}` }
}

async function serve($: EngineInterface, context: Context, name: string, input: ToolInput): Promise<Answer> {
  const cwd = text(input.cwd)
  const job = text(input.job)
  switch (name) {
    case 'dispatch': {
      let body: string
      try { body = dispatchInput(input) } catch (error) { return { deny: (error as Error).message } }
      return run($, context, ['bash', context.worker, 'dispatch'], cwd, 120_000, body)
    }
    case 'message': {
      const flags = DELIVERY[text(input.delivery)]
      if (!flags) return { deny: 'delivery must be queue, steer or interrupt' }
      if (!text(input.text).trim()) return { deny: 'text is empty' }
      const file = await scratch($, context, '.md', text(input.text))
      return run($, context, ['bash', context.worker, 'message', job, file, '--cwd', cwd, ...flags], cwd, 300_000)
        .finally(() => discard($, file))
    }
    case 'answer': {
      const answers = input.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { deny: 'answers must be an object keyed by question id' }
      const file = await scratch($, context, '.json', JSON.stringify(answers))
      return run($, context, ['bash', context.worker, 'answer', job, text(input.request), file, '--cwd', cwd], cwd, 120_000)
        .finally(() => discard($, file))
    }
    case 'result':
      return run($, context, ['node', context.companion, 'result', job, '--cwd', cwd], cwd, 60_000)
    case 'status':
      return run($, context, ['node', context.companion, 'status', ...(job ? [job] : []), '--cwd', cwd,
        input.detail === true ? '--json' : '--brief'], cwd, 30_000)
    case 'tasks':
      return run($, context, ['node', context.companion, 'tasks',
        ...(text(input.query) ? ['--query', text(input.query)] : []), ...(cwd ? ['--cwd', cwd] : []),
        ...(input.all === true ? ['--all'] : []), ...(input.limit === undefined ? [] : ['--limit', String(input.limit)])],
      cwd || await $.session.cwd(), 30_000)
    case 'cancel':
      // Without a job the companion picks one itself; a tool call names it.
      if (!job) return { deny: 'job is required' }
      return run($, context, ['node', context.companion, 'cancel', job, '--cwd', cwd], cwd, 60_000)
  }
  return { deny: `unknown tool ${name}` }
}

// Shared with the tasks pane, which owns the plugin's one `session.start` hook:
// it starts the tools there, and reads `pending` to rescan for a job a dispatch
// just started, as its Bash hook does for a shell dispatch.
export type DirectorTools = { pending: boolean; context: Context | null }

export function directorTools(): DirectorTools {
  return { pending: false, context: null }
}

// The plugin's data folder, which Claude Code hands its hooks and, through the
// session-start hook's env file, the Bash tool as CLAUDE_PLUGIN_DATA; the
// companion keeps its job state under it. `$.process.run` does not get it, and
// without it the companion falls back to $TMPDIR/codex-companion, where the
// jobs a Bash dispatch started are not. An installed plugin lives at
// <plugins>/cache/<marketplace>/<name>/<version>, its data at
// <plugins>/data/<name>-<marketplace>; a --plugin-dir checkout has no such
// folder and keeps the fallback, as its Bash dispatches do.
export function pluginDataDir(root: string): string | null {
  const match = /^(.*)\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(root)
  if (!match) return null
  const [, plugins, marketplace, name] = match
  return `${plugins}/data/${`${name}@${marketplace}`.replace(/[^a-zA-Z0-9\-_]/g, '-')}`
}

// Registers the tools when the code-director skill is installed; without its
// dispatch.sh there is nothing for them to run.
export async function startDirectorTools($: EngineInterface, tools: DirectorTools) {
  try {
    const home = await $.env.get('HOME')
    const worker = `${home}/.claude/skills/code-director/scripts/dispatch.sh`
    const companion = `${$.plugin.root}/scripts/codex-companion.mjs`
    if (!home || !(await $.fs.exists(worker)) || !(await $.fs.exists(companion))) return
    const tmp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '') || '/tmp'
    const found = pluginDataDir($.plugin.root)
    const data = found && (await $.fs.exists(found)) ? found : null
    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    tools.context = { worker, companion, tmp, data }
  } catch (error) {
    $.ui.log(`Codex director tools: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

async function answerCall($: EngineInterface, tools: DirectorTools, name: string, input: ToolInput): Promise<Answer> {
  if (!tools.context) return { deny: 'the code-director skill is not installed, so there is no dispatch.sh to run' }
  const answer = await serve($, tools.context, name, input)
  if (name === 'dispatch' && 'result' in answer) tools.pending = true
  return answer
}

// One hook per tool, each with its name spelled out: the engine routes a call
// by the matcher it reads off the source.
export function registerDirectorTools(on: On, tools: DirectorTools) {
  on('tool.call', { tool: 'mcp__codex__dispatch' }, ($, e) => answerCall($, tools, 'dispatch', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__message' }, ($, e) => answerCall($, tools, 'message', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__answer' }, ($, e) => answerCall($, tools, 'answer', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__result' }, ($, e) => answerCall($, tools, 'result', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__status' }, ($, e) => answerCall($, tools, 'status', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__tasks' }, ($, e) => answerCall($, tools, 'tasks', e as unknown as ToolInput))
  on('tool.call', { tool: 'mcp__codex__cancel' }, ($, e) => answerCall($, tools, 'cancel', e as unknown as ToolInput))
}
