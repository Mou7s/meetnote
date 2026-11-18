export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'timestamp'; text: string }

export type MarkdownBlock =
  | { type: 'heading'; level: number; spans: InlineSpan[] }
  | { type: 'list'; ordered: boolean; items: { checked?: boolean; spans: InlineSpan[] }[] }
  | { type: 'paragraph'; spans: InlineSpan[] }

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[\d{2}:\d{2}(?::\d{2})?\])/g

export function parseInlineSpans(input: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let cursor = 0
  for (const match of input.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0
    if (index > cursor) spans.push({ kind: 'text', text: input.slice(cursor, index) })
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      spans.push({ kind: 'bold', text: token.slice(2, -2) })
    } else if (token.startsWith('`') && token.endsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) })
    } else {
      spans.push({ kind: 'timestamp', text: token })
    }
    cursor = index + token.length
  }
  if (cursor < input.length) spans.push({ kind: 'text', text: input.slice(cursor) })
  return spans.length ? spans : [{ kind: 'text', text: input }]
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!.trim()
    if (!line) {
      i++
      continue
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length,
        spans: parseInlineSpans(headingMatch[2]!)
      })
      i++
      continue
    }

    const unorderedMatch = /^[-*•]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line)
    const orderedMatch = /^\d+\.\s+(.+)$/.exec(line)
    if (unorderedMatch || orderedMatch) {
      const ordered = !!orderedMatch
      const items: { checked?: boolean; spans: InlineSpan[] }[] = []
      while (i < lines.length) {
        const current = lines[i]!.trim()
        if (!current) break
        if (ordered) {
          const m = /^\d+\.\s+(.+)$/.exec(current)
          if (!m) break
          items.push({ spans: parseInlineSpans(m[1]!) })
        } else {
          const m = /^[-*•]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(current)
          if (!m) break
          items.push({
            checked: m[1] !== undefined ? m[1].toLowerCase() === 'x' : undefined,
            spans: parseInlineSpans(m[2]!)
          })
        }
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraphLines: string[] = []
    while (i < lines.length) {
      const current = lines[i]!.trim()
      if (!current || /^(#{1,3})\s+/.test(current) || /^[-*•]\s+/.test(current) || /^\d+\.\s+/.test(current)) {
        break
      }
      paragraphLines.push(current)
      i++
    }
    blocks.push({ type: 'paragraph', spans: parseInlineSpans(paragraphLines.join('\n')) })
  }

  return blocks
}
