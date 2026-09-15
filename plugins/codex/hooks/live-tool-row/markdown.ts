import type { Elements, TextProps } from 'claude-code'
import { cellWidth, clean } from './format.ts'

type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Code'>

function inlineParts(text: string): (TextProps & { children: string })[] {
  const parts: (TextProps & { children: string })[] = []
  const pattern = /(?<!`)`([^`\n]+)`(?!`)|\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!\w)_([^_\n]+)_(?!\w)|(?<!!)\[([^\]\n]+)\]\([^\s)]+\)/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push({ children: text.slice(start, match.index) })
    const [, code, bold, star, underscore, link] = match
    parts.push({
      ...(code !== undefined ? { color: 'cyan' } : bold !== undefined ? { bold: true } : star !== undefined || underscore !== undefined ? { italic: true } : {}),
      children: code ?? bold ?? star ?? underscore ?? link!,
    })
    start = match.index + match[0].length
  }
  if (start < text.length) parts.push({ children: text.slice(start) })
  return parts
}

function inline(ui: UI, text: string) {
  return inlineParts(text).map(part => ui.Text(part))
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'))
}

function table(ui: UI, rows: string[][], columns: number, props: TextProps) {
  const count = Math.max(...rows.map(row => row.length))
  const padded = rows.map(row => Array.from({ length: count }, (_, i) => row[i] ?? ''))
  const widths = Array.from({ length: count }, (_, i) => Math.max(1, ...padded.map(row =>
    cellWidth(inlineParts(row[i]!).map(part => part.children).join('')))))
  const budget = columns - (count - 1) * 2
  const total = widths.reduce((sum, width) => sum + width, 0)
  const compressed = total > budget
  if (budget < count * 8) {
    return padded.slice(1).flatMap((row, index) => [
      ...(index ? [ui.Text({ children: ' ' })] : []),
      ...row.map((cell, i) => ui.Text({ ...props, wrap: 'wrap', children: [
        ui.Text({ bold: true, children: inline(ui, padded[0]![i]!) }),
        ui.Text({ children: ': ' }), ...inline(ui, cell),
      ] })),
    ])
  }
  if (compressed) {
    // Freeze small columns at eight, then proportionally share the remainder.
    let remaining = budget
    let pending = widths.map((_, i) => i)
    while (pending.length) {
      const weight = pending.reduce((sum, i) => sum + widths[i]!, 0)
      const small = pending.filter(i => widths[i]! * remaining / weight < 8)
      if (!small.length) {
        let assigned = 0
        for (const [index, i] of pending.entries()) {
          const width = index === pending.length - 1 ? remaining - assigned : Math.floor(widths[i]! * remaining / weight)
          widths[i] = width
          assigned += width
        }
        break
      }
      for (const i of small) widths[i] = 8
      remaining -= small.length * 8
      pending = pending.filter(i => !small.includes(i))
    }
  }
  return padded.map((row, index) => ui.Box({ flexDirection: 'row', columnGap: 2, children:
    row.map((cell, i) => ui.Box({ width: widths[i], flexShrink: 0, children:
      ui.Text({ ...props, bold: index === 0 || props.bold, wrap: compressed ? 'wrap' : 'truncate-end', children: inline(ui, cell) }),
    })),
  }))
}

// Only terminal primitives; Code.source's 10000-character limit is a host contract.
export function markdown(ui: UI, text: string, props: TextProps = {}, prefix = '', columns = 120) {
  const nodes: ReturnType<UI['Text']>[] = []
  const lines = clean(text).split('\n')
  const paragraph: string[] = []
  const indents: number[] = []
  const add = (value: string, style: TextProps = {}, raw = false) => {
    nodes.push(ui.Text({ ...props, ...style, wrap: 'wrap', children: [
      ...(nodes.length === 0 && prefix ? [ui.Text({ children: prefix })] : []),
      ...(raw ? [ui.Text({ children: value })] : inline(ui, value)),
    ] }))
  }
  const flush = () => {
    if (paragraph.length) add(paragraph.splice(0).join('\n'))
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/)
    const heading = line.match(/^ {0,3}#{1,6}\s+(.*)$/)
    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/)
    const quote = line.match(/^\s*>\s?(.*)$/)
    const raw = /^\s*\|.*\|\s*$/.test(line) || /^\s*(?:([-*_])\s*){3,}$/.test(line)
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('|') && cells(lines[i + 1]!).every(cell => /^:?-{2,}:?$/.test(cell))) {
      flush()
      if (!nodes.length && prefix) add('')
      const rows = [cells(line)]
      i++
      while (i + 1 < lines.length && lines[i + 1]!.includes('|') && lines[i + 1]!.trim()) rows.push(cells(lines[++i]!))
      nodes.push(...table(ui, rows, columns, props))
    } else if (fence) {
      flush()
      const source: string[] = []
      const closing = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`)
      while (i + 1 < lines.length && !closing.test(lines[i + 1]!)) source.push(lines[++i]!)
      if (i + 1 < lines.length) i++
      if (!nodes.length && prefix) add('')
      const code = source.join('\n')
      nodes.push(ui.Code({ source: code.slice(0, 10000), language: fence[2] || undefined }))
      if (code.length > 10000) add('…', { dimColor: true })
    } else if (heading || list || quote || raw) {
      flush()
      if (raw) add(line, {}, true)
      else if (heading) add(heading[1]!, { bold: true })
      else if (quote) add(quote[1]!, { dimColor: true })
      else if (list) {
        const indent = list[1]!.length
        while (indents.length && indents.at(-1)! > indent) indents.pop()
        if (!indents.length || indents.at(-1)! < indent) indents.push(indent)
        add(`${'  '.repeat(indents.length - 1)}${/^\d/.test(list[2]!) ? list[2] : '•'} ${list[3]}`)
      }
    } else {
      indents.length = 0
      paragraph.push(line)
    }
  }
  flush()
  return nodes
}
