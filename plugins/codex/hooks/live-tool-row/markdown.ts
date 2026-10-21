import type { Elements, TextProps } from 'claude-code'
import { clean } from './format.ts'

type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown'>

function cells(line: string): string[] {
  const parts: string[] = []
  let start = 0
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && !escaped) {
      parts.push(line.slice(start, i).trim())
      start = i + 1
    }
    escaped = line[i] === '\\' ? !escaped : false
  }
  parts.push(line.slice(start).trim())
  if (parts[0] === '' && line.trimStart().startsWith('|')) parts.shift()
  if (parts.at(-1) === '' && line.trimEnd().endsWith('|')) parts.pop()
  return parts
}

function table(ui: UI, rows: string[][], columns: number, props: TextProps) {
  const headers = rows[0]!
  const available = columns - 2 - headers.length * 2
  const draw = (text: string) => ui.Markdown({ text, dimColor: props.dimColor })
  if (available < headers.length * 8) {
    return ui.Box({ flexDirection: 'column', children: rows.length === 1 ? [draw(headers.join(' / '))]
      : rows.slice(1).flatMap((row, index) => [
        ...(index ? [ui.Text({ children: ' ' })] : []),
        draw(headers.map((header, i) => `- **${header}**: ${row[i] ?? ''}`).join('\n')),
      ]) })
  }
  const widths = headers.map((_, i) => Math.floor(available / headers.length) + (i < available % headers.length ? 1 : 0))
  return ui.Box({ flexDirection: 'column', width: columns, borderStyle: 'single', borderDimColor: true, children: rows.flatMap((row, index) => [
    ...(index === 1 ? [ui.Text({ dimColor: true, children: '─'.repeat(columns - 2) })] : []),
    ui.Box({ flexDirection: 'row', children: headers.map((_, i) =>
      ui.Box({ width: widths[i]! + 2, paddingX: 1, flexShrink: 0, children: draw(index === 0 ? `**${row[i] ?? ''}**` : row[i] ?? '') }),
    ) }),
  ]) })
}

function completed(ui: UI, text: string, props: TextProps, columns: number) {
  const lines = text.split('\n')
  const nodes: ReturnType<UI['Box']>[] = []
  let start = 0
  let fence = ''
  const prose = (end: number) => {
    const text = lines.slice(start, end).join('\n')
    if (text.trim()) nodes.push(ui.Markdown({ text, dimColor: props.dimColor }))
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = ''
      continue
    }
    if (fence || !/^ {0,3}\S/.test(line) || !line.includes('|')) continue
    const headers = cells(line)
    const separator = cells(lines[i + 1] ?? '')
    if (headers.length < 2 || separator.length !== headers.length || !separator.every(cell => /^:?-{2,}:?$/.test(cell))) continue
    prose(i)
    const rows = [headers]
    i += 2
    while (i < lines.length && /^ {0,3}\S/.test(lines[i]!) && lines[i]!.includes('|') && !/^ {0,3}(`{3,}|~{3,})/.test(lines[i]!)) rows.push(cells(lines[i++]!))
    nodes.push(table(ui, rows, columns, props))
    start = i
    i--
  }
  if (!nodes.length) return ui.Markdown({ text, dimColor: props.dimColor })
  prose(lines.length)
  return ui.Box({ flexDirection: 'column', children: nodes })
}

// Where the settled part of a streaming message ends. A block is settled once
// what follows it has begun: a blank line, a closing fence, the next list item
// or the line after a heading. Claude Code draws a reply the same way -- the
// blocks before the last are Markdown, only the last is still in the air -- but
// where it renders that last block as it comes, the trace holds it back: a
// half-written fence, table row or `**` drawn as it streams is the raw syntax
// the reader came to the pane not to see.
export function settled(text: string): number {
  let end = 0
  let fence = ''
  let at = 0
  while (true) {
    const next = text.indexOf('\n', at)
    const line = text.slice(at, next < 0 ? undefined : next)
    // The last line has no break after it yet, so it may still grow -- but one
    // that has begun a new list item or fence already closes what came before.
    if (next < 0) return !fence && /^ {0,3}([-*+]|\d{1,9}[.)]) |^ {0,3}(`{3,}|~{3,})/.test(line) ? at : end
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = ''
        end = next + 1
      }
    } else if (marker) {
      fence = marker
      end = at
    } else if (!line.trim() || /^ {0,3}#{1,6}(\s|$)/.test(line)) end = next + 1
    else if (/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line)) end = at
    at = next + 1
  }
}

export function markdown(ui: UI, text: string, props: TextProps = {}, prefix = '', columns = 120, streaming = false) {
  const width = Math.max(1, columns - prefix.length)
  const source = clean(text)
  // While a message streams, only its settled blocks are drawn, and drawn as
  // Markdown; the block still being written shows as a marker until it closes.
  const shown = streaming ? source.slice(0, settled(source)).trimEnd() : source
  const pending = streaming ? source.slice(shown.length).trim() : ''
  const lines = pending ? pending.split('\n').length : 0
  const marker = ui.Text({ ...props, dimColor: true, children: lines > 1 ? `… writing · ${lines} lines` : '…' })
  const body = shown.trim() ? completed(ui, shown, props, width) : null
  // A separate gutter keeps the prefix from changing a heading or fence's syntax.
  const nodes = body ? [prefix ? ui.Box({ flexDirection: 'row', children: [
    ui.Text({ ...props, children: prefix }),
    ui.Box({ width, children: [body] }),
  ] }) : body] : []
  if (streaming) nodes.push(body || !prefix ? marker : ui.Box({ flexDirection: 'row', children: [ui.Text({ ...props, children: prefix }), marker] }))
  return nodes
}
