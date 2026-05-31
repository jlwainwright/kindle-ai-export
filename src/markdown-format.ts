import type { ContentChunk } from './types'

export interface FormattedContent {
  markdown: string
  annotatedMarkdown: string
  warnings: string[]
}

function normalizeText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replace(/^\s*```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/^#\s+/gm, '## ')
    .replaceAll(
      /^(ROMAN CATHOLIC VIEW):\s*(.+)$/gm,
      '| Roman Catholic View | $2 |'
    )
    .replaceAll(/^(PROTESTANT VIEW):\s*(.+)$/gm, '| Protestant View | $2 |')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

function paragraphLooksLikeHeading(paragraph: string): boolean {
  return /^#{1,6}\s+\S/.test(paragraph)
}

function paragraphLooksLikeListItem(paragraph: string): boolean {
  return /^[-*]\s+\S/.test(paragraph)
}

function paragraphLooksLikeTableRow(paragraph: string): boolean {
  return /^\|.*\|$/.test(paragraph)
}

function paragraphEndsSentence(paragraph: string): boolean {
  return /[.!?”’:)\\\]]$/.test(paragraph.trim())
}

function shouldJoinParagraphs(previous: string, next: string): boolean {
  const prev = previous.trim()
  const current = next.trim()

  if (!prev || !current) return false
  if (paragraphLooksLikeHeading(current)) return false
  if (paragraphLooksLikeListItem(current)) return false
  if (paragraphLooksLikeListItem(prev)) return false
  if (paragraphLooksLikeTableRow(current) || paragraphLooksLikeTableRow(prev)) {
    return false
  }

  if (paragraphEndsSentence(prev)) return false

  return /^[a-z"'“‘]/.test(current)
}

function normalizeMarkdownBlocks(markdown: string): string {
  let normalized = markdown
    .replaceAll(/[ \t]+$/gm, '')
    .replaceAll(/^(#{1,6}\s+.+)\n(?!\n)/gm, '$1\n\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trimEnd()

  normalized = normalized.replaceAll(
    /(\| Roman Catholic View \| .+ \|)\n\n(\| Protestant View \| .+ \|)/g,
    '| View | Formula |\n| --- | --- |\n$1\n$2'
  )

  return normalized.concat('\n')
}

export function formatContentChunks(chunks: ContentChunk[]): FormattedContent {
  const blocks: string[] = []
  const annotatedBlocks: string[] = []
  const warnings: string[] = []

  for (const chunk of chunks) {
    const text = normalizeText(chunk.text)
    if (!text) {
      warnings.push(`empty text for capture ${chunk.index}`)
      continue
    }

    annotatedBlocks.push(
      `<!-- page ${chunk.page}, capture ${chunk.index}: ${chunk.screenshot} -->\n\n${text}`
    )

    const paragraphs = text
      .split(/\n\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)

    for (const paragraph of paragraphs) {
      const lastBlock = blocks.at(-1)
      if (lastBlock && shouldJoinParagraphs(lastBlock, paragraph)) {
        blocks[blocks.length - 1] = `${lastBlock.trim()} ${paragraph}`
      } else {
        blocks.push(paragraph)
      }
    }
  }

  const markdown = normalizeMarkdownBlocks(blocks.join('\n\n'))
  const annotatedMarkdown = normalizeMarkdownBlocks(
    annotatedBlocks.join('\n\n---\n\n')
  )

  if (/```/.test(markdown)) warnings.push('markdown contains code fences')
  if (/^<!-- page /m.test(markdown))
    warnings.push('markdown contains page comments')
  if (/\n{3,}/.test(markdown))
    warnings.push('markdown contains extra blank lines')
  if (/[ \t]+$/m.test(markdown))
    warnings.push('markdown contains trailing whitespace')
  if (!/[.!?”’)]$/.test(markdown.trim())) {
    warnings.push('markdown does not end with a complete sentence')
  }

  return { markdown, annotatedMarkdown, warnings }
}
