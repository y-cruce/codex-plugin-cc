import { isOver, latestRound } from '../live-tool-row/view.ts'
import type { LiveView } from '../live-tool-row/view.ts'

const INTERVAL_MS = 120_000
export type ActivityEntry = { jobId: string; nextAt: number; signature?: string; text?: string }
export type ActivityState = { entries: Map<string, ActivityEntry>; pending: Set<string> }
export type ActivityRequest = { threadId: string; entry: ActivityEntry; task: string; notes: string; previousSummary?: string }

export function activityState(saved: Record<string, ActivityEntry> = {}): ActivityState {
  return { entries: new Map(Object.entries(saved)), pending: new Set() }
}

export function activityKey(view: LiveView) {
  return view.recordId ?? view.jobId
}

function running(view: LiveView) {
  return view.status === 'running' && !view.foreign && !view.pendingQuestion && !isOver(view)
}

function budget(text: string, tokens: number) {
  let used = 0
  let out = ''
  for (const char of text) {
    used += char.codePointAt(0)! > 127 ? 1 : 1 / 3
    if (used > tokens) break
    out += char
  }
  return out
}

function commandName(text: string) {
  // Command arguments and output can contain much more than activity details.
  const words = text.replace(/^\$\s*/, '').trim().split(/\s+/)
  const command = words.find(word => !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) ?? ''
  return command.split('/').at(-1) ?? command
}

export function activityNotes(view: LiveView): string {
  const lines: string[] = []
  const current = view.rounds?.find(round => round.jobId === (view.activeRoundId ?? view.jobId)) ?? latestRound(view)
  for (const event of view.tail.slice(-60)) {
    if (current?.firstSeq && BigInt(event.seq) < BigInt(current.firstSeq)) continue
    if (event.type.startsWith('command.') && ['command.started', 'command.completed'].includes(event.type)) {
      lines.push(`${event.type}: ${commandName(event.text)}${event.exitCode == null ? '' : ` (exit ${event.exitCode})`}`)
    } else if (/^message\.(?:delta|completed)$/.test(event.type)) {
      lines.push(budget(event.text, 150))
    } else if (/^tool\.(?:started|updated|completed)$/.test(event.type)) {
      lines.push(`${event.type}: ${budget(event.text, 100)}`)
    } else if (event.type.startsWith('fileChange.') && event.files?.length) {
      lines.push(`${event.type}: ${event.files.map(file => file.path.split('/').slice(-2).join('/')).join(', ')}`)
    }
  }
  const messageAt = Date.parse(view.lastMessage?.at ?? '')
  const started = Date.parse(current?.startedAt ?? view.startedAt)
  if (view.lastMessage?.kind === 'assistant' && (!Number.isFinite(messageAt) || messageAt >= started)) {
    lines.push(budget(view.lastMessage.text, 200))
  }
  for (const step of view.plan?.entries ?? []) {
    if (step.status === 'in_progress') lines.push(`Current plan: ${step.content}`)
  }
  for (const command of view.activeCommands) lines.push(`Running command: ${commandName(command.command)}`)
  // Keep the newest useful observations; output, raw thinking and token ticks
  // do not change the notes or trigger another paid request.
  const recent = [...new Set(lines)].filter(line => line.trim()).reverse()
  return recent.length ? budget(`Newest observations first:\n${recent.join('\n')}`, 1250) : ''
}

function signature(text: string) {
  let value = 2166136261
  for (const char of text) value = Math.imul(value ^ char.codePointAt(0)!, 16777619)
  return (value >>> 0).toString(16)
}

export function activityRequests(state: ActivityState, views: LiveView[], now: number, liveThreads?: ReadonlySet<string>): ActivityRequest[] {
  const live = new Set(views.map(activityKey))
  for (const id of state.entries.keys()) if (!live.has(id)) state.entries.delete(id)
  const requests: ActivityRequest[] = []
  for (const view of views) {
    if (!running(view)) continue
    const threadId = activityKey(view)
    if (liveThreads && !liveThreads.has(threadId)) continue
    const jobId = view.activeRoundId ?? view.jobId
    let entry = state.entries.get(threadId)
    if (!entry || entry.jobId !== jobId) {
      const started = Date.parse(latestRound(view)?.startedAt ?? view.startedAt)
      entry = { jobId, nextAt: (Number.isFinite(started) ? started : now) + INTERVAL_MS }
      state.entries.set(threadId, entry)
    }
    if (now < entry.nextAt || state.pending.has(threadId)) continue
    entry.nextAt = now + INTERVAL_MS
    const notes = activityNotes(view)
    if (!notes) continue
    const task = budget(view.prompt ?? view.label, 250)
    const fingerprint = signature(`${task}\n${notes}`)
    if (entry.signature === fingerprint) continue
    entry.signature = fingerprint
    state.pending.add(threadId)
    requests.push({ threadId, entry, task, notes, previousSummary: entry.text })
  }
  return requests
}

export function activityText(state: ActivityState, view: LiveView): string | undefined {
  const entry = state.entries.get(activityKey(view))
  return running(view) && entry?.jobId === (view.activeRoundId ?? view.jobId) ? entry?.text : undefined
}

export function finishActivity(state: ActivityState, request: ActivityRequest, now: number) {
  state.pending.delete(request.threadId)
  if (state.entries.get(request.threadId) === request.entry) request.entry.nextAt = now + INTERVAL_MS
}
