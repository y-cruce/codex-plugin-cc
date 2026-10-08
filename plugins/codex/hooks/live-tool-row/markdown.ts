import type { Elements, TextProps } from 'claude-code'
import { clean } from './format.ts'

type UI = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown'>

export function markdown(ui: UI, text: string, props: TextProps = {}, prefix = '', columns = 120, streaming = false) {
  // Keep unfinished text visible without guessing how its Markdown will close.
  const body = streaming
    ? ui.Text({ ...props, wrap: 'wrap', children: clean(text) })
    : ui.Markdown({ text: clean(text), dimColor: props.dimColor })
  // A separate gutter keeps the prefix from changing a heading or fence's syntax.
  const nodes = [prefix ? ui.Box({ flexDirection: 'row', children: [
    ui.Text({ ...props, children: prefix }),
    ui.Box({ width: Math.max(1, columns - prefix.length), children: [body] }),
  ] }) : body]
  if (streaming) nodes.push(ui.Text({ ...props, dimColor: true, children: '…' }))
  return nodes
}
