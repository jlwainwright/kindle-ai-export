import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { formatContentChunks } from './markdown-format'
import { assert, getEnv, readJsonFile } from './utils'

interface MarkdownSection {
  depth: number
  label: string
  body: string
}

function anchorForLabel(label: string): string {
  return label.toLowerCase().replaceAll(/[^\da-z]+/g, '-')
}

function startsWithTocLabel(text: string, label: string): boolean {
  const escapedLabel = label.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^\\s*#*\\s*${escapedLabel}\\b`, 'i').test(text)
}

function stripLeadingTocHeading(markdown: string, label: string): string {
  const escapedLabel = label.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return (
    markdown
      // eslint-disable-next-line security/detect-non-literal-regexp
      .replace(new RegExp(`^\\s*#{1,6}\\s+${escapedLabel}\\s*\\n+`, 'i'), '')
      // eslint-disable-next-line security/detect-non-literal-regexp
      .replace(new RegExp(`^\\s*${escapedLabel}\\s*\\n+`, 'i'), '')
  )
}

function findNextTocIndex({
  content,
  currentIndex,
  nextPage,
  nextLabel
}: {
  content: ContentChunk[]
  currentIndex: number
  nextPage?: number | undefined
  nextLabel: string
}): number {
  if (!nextPage) return content.length

  const firstNextPageIndex = content.findIndex(
    (chunk, index) => index >= currentIndex && chunk.page >= nextPage
  )

  if (firstNextPageIndex === -1) return content.length
  if (firstNextPageIndex === currentIndex) return firstNextPageIndex

  const firstNextPageChunk = content[firstNextPageIndex]!
  if (
    firstNextPageChunk.page === nextPage &&
    !startsWithTocLabel(firstNextPageChunk.text, nextLabel)
  ) {
    const laterNextTocIndex = content.findIndex(
      (chunk, index) =>
        index > firstNextPageIndex &&
        chunk.page >= nextPage &&
        startsWithTocLabel(chunk.text, nextLabel)
    )

    if (laterNextTocIndex !== -1) return laterNextTocIndex

    const nextHigherPageIndex = content.findIndex(
      (chunk, index) => index > firstNextPageIndex && chunk.page > nextPage
    )
    return nextHigherPageIndex !== -1 ? nextHigherPageIndex : content.length
  }

  return firstNextPageIndex
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)

  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const sections: MarkdownSection[] = []
  for (let i = 0, index = 0; i < metadata.toc.length - 1; i++) {
    const tocItem = metadata.toc[i]!
    if (tocItem.page === undefined) continue

    const nextTocItem = metadata.toc[i + 1]!
    const nextIndex = findNextTocIndex({
      content,
      currentIndex: index,
      nextPage: nextTocItem.page,
      nextLabel: nextTocItem.label
    })
    if (nextIndex <= index) continue

    const chunks = content.slice(index, nextIndex)
    const formatted = formatContentChunks(chunks)
    if (formatted.warnings.length) {
      console.warn(`format warnings for ${tocItem.label}`, formatted.warnings)
    }

    const body = stripLeadingTocHeading(
      formatted.markdown,
      tocItem.label
    ).trim()
    if (!body) continue

    sections.push({
      depth: tocItem.depth,
      label: tocItem.label,
      body
    })

    index = nextIndex
  }
  assert(sections.length, 'no exportable book sections found')

  let output = `# ${title}

> By ${authors.join(', ')}

---

## Table of Contents

${sections
  .map(
    (section) =>
      `${'  '.repeat(section.depth)}- [${section.label}](#${anchorForLabel(section.label)})`
  )
  .join('\n')}

---`

  for (const section of sections) {
    output += `

${'#'.repeat(section.depth + 2)} ${section.label}

${section.body}
`
  }

  await fs.writeFile(path.join(outDir, 'book.md'), output)

  const annotated = formatContentChunks(content).annotatedMarkdown
  await fs.writeFile(path.join(outDir, 'book.annotated.md'), annotated)

  console.log(output)
}

await main()
