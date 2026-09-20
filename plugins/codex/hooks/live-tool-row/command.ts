export type Follow = { jobId: string; script: string; worker: boolean; cwd?: string }

// Shell words sufficient for literal paths, quoted paths and escaped spaces.
// Never execute the transcript command to discover its arguments.
export function followOf(command: unknown): Follow | null {
  if (typeof command !== 'string') return null
  const words = command.match(/(?:\\.|[^\s'"\\;&|<>]+|'[^']*'|"(?:\\.|[^"\\])*")+|[;&|<>]/g) ?? []
  const tokens = words.map(word => word.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (_, a, b, c) => a ?? b?.replace(/\\(["\\$`])/g, '$1') ?? c))
  for (let i = 0; i < tokens.length; i++) {
    const script = tokens[i]!
    const worker = /(?:^|\/)(?:codex-worker|dispatch)\.sh$/.test(script)
    const companion = /(?:^|\/)codex-companion\.mjs$/.test(script)
    const offset = worker ? 1 : 2
    if (!worker && !companion) continue
    if (companion && tokens[i + 1] !== 'observe') continue
    if (tokens[i + offset] !== 'follow') continue
    const jobId = tokens[i + offset + 1] ?? ''
    if (!/^task-[a-z0-9]+-[a-z0-9]+$/.test(jobId)) continue
    const rest = tokens.slice(i + offset + 2)
    const end = rest.findIndex(arg => /^[;&|<>]$/.test(arg))
    const args = end < 0 ? rest : rest.slice(0, end)
    const cwdIndex = args.indexOf('--cwd')
    const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : args.find(arg => arg.startsWith('--cwd='))?.slice(6)
    return { jobId, script, worker, cwd }
  }
  return null
}
