// Conservative cell charging, following the built-in diff mod. Invisible
// controls/joiners/selectors are removed and combining marks cost one cell.
const wide = [[0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f000, 0x1faff], [0x20000, 0x3fffd]]

export function cellWidth(text: string): number {
  return Array.from(text).reduce((used, char) => {
    const point = char.codePointAt(0)!
    return used + (wide.some(([low, high]) => point >= low! && point <= high!) || /\p{Extended_Pictographic}/u.test(char) ? 2 : 1)
  }, 0)
}

export function clip(text: string, columns: number): string {
  let result = ''
  let used = 0
  const clean = text.replace(/\s/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
  for (const char of clean) {
    const charge = cellWidth(char)
    if (used + charge > columns) break
    used += charge
    result += char
  }
  return result
}

// Prose rows keep their line breaks and wrap; only invisible controls go.
export function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[^\S\n]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, char => (char === '\n' ? char : ''))
}

export function duration(ms: number): string {
  const seconds = Math.max(0, ms / 1000)
  return seconds < 60 ? `${Number(seconds.toFixed(1))}s` : `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`
}

// A live clock only moves when something asks for a redraw, and nothing can
// repaint while the main thread is inside a turn. At second resolution every
// repaint that did not happen shows up as a jump, so past a minute the figure
// drops to minutes: by then it answers "how long has this been going", which
// the seconds were never part of.
export function elapsed(start: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(start)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

export function tokens(count: number): string {
  return count < 1000 ? String(count) : `${Number((count / 1000).toFixed(1))}k`
}

export function shortPath(path: string, columns: number): string {
  if (clip(path, columns) === path) return path
  return `…${Array.from(clip(Array.from(path).reverse().join(''), Math.max(0, columns - 1))).reverse().join('')}`
}

export function waiting(openedAt: string, expiresAt: string | null, now: number): string {
  const age = (ms: number) => ms < 60000 ? `${Math.floor(Math.max(0, ms) / 1000)}s` : `${Math.floor(ms / 60000)}m`
  return `waiting ${age(now - Date.parse(openedAt))}${expiresAt === null ? '' : ` · expires in ${age(Date.parse(expiresAt) - now)}`}`
}

export function tailLimit(rows?: number): number {
  return rows === undefined ? 8 : Math.max(4, Math.min(12, Math.floor(rows / 4)))
}

export type Terminal = { kind: 'DONE' | 'FAILED' | 'QUESTION' | 'NOTIFIED' | 'STALLED' | 'TIMEOUT'; text: string; label?: string }

export function terminalOf(output: unknown): Terminal | undefined {
  const text = typeof output === 'string' ? output : (output as { stdout?: unknown } | null)?.stdout
  if (typeof text !== 'string') return undefined
  const match = [...text.matchAll(/^(DONE|FAILED|QUESTION|NOTIFIED|STALLED|TIMEOUT) job=([^\s]+)(?:[ \t]+\[([^\]\r\n]*)\])?(?:[ \t]+(?:thread|request)=\S+)*(?:[ \t]+([^\r\n]*))?\r?$/gm)].at(-1)
  return match ? { kind: match[1] as Terminal['kind'], text: match[4] ?? '', label: match[3] } : undefined
}
