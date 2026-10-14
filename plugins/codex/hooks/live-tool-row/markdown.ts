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

export function markdown(ui: UI, text: string, props: TextProps = {}, prefix = '', columns = 120, streaming = false) {
  const width = Math.max(1, columns - prefix.length)
  // Keep unfinished text visible without guessing how its Markdown will close.
  const body = streaming
    ? ui.Text({ ...props, wrap: 'wrap', children: clean(text) })
    : completed(ui, clean(text), props, width)
  // A separate gutter keeps the prefix from changing a heading or fence's syntax.
  const nodes = [prefix ? ui.Box({ flexDirection: 'row', children: [
    ui.Text({ ...props, children: prefix }),
    ui.Box({ width, children: [body] }),
  ] }) : body]
  if (streaming) nodes.push(ui.Text({ ...props, dimColor: true, children: '…' }))
  return nodes
}
