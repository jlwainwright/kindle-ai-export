import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { SetRequired } from 'type-fest'
import { input } from '@inquirer/prompts'
import delay from 'delay'
import pRace from 'p-race'
// import { chromium } from 'playwright'
import { chromium } from 'patchright'
import sharp from 'sharp'

import type {
  AmazonRenderLocationMap,
  AmazonRenderToc,
  AmazonRenderTocItem,
  BookMetadata,
  TocItem
} from './types'
import { parsePageNav, parseTocItems } from './playwright-utils'
import {
  assert,
  extractTar,
  getEnv,
  hashObject,
  normalizeAuthors,
  normalizeBookMetadata,
  parseJsonpResponse,
  tryReadJsonFile
} from './utils'

// Block amazon analytics requests
// (not strictly necessary, but adblockers do this by default anyway and it
// makes the script run a bit faster)
const urlRegexBlacklist = [
  /unagi-\w+\.amazon\.com/i, // 'unagi-na.amazon.com'
  /m\.media-amazon\.com.*\/showads/i,
  /fls-na\.amazon\.com.*\/remote-weblab-triggers/i
]

type RENDER_METHOD = 'screenshot' | 'blob'
const renderMethod: RENDER_METHOD = 'blob'

async function main() {
  const asin = getEnv('ASIN')
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(asin, 'ASIN is required')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')
  const asinL = asin.toLowerCase()

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const metadataPath = path.join(outDir, 'metadata.json')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const result: SetRequired<Partial<BookMetadata>, 'pages' | 'nav'> = {
    pages: [],
    // locationMap: { locations: [], navigationUnit: [] },
    nav: {
      startPosition: -1,
      endPosition: -1,
      startContentPosition: -1,
      startContentPage: -1,
      endContentPosition: -1,
      endContentPage: -1,
      totalNumPages: -1,
      totalNumContentPages: -1
    }
  }

  const deviceScaleFactor = 2
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      // hide chrome's crash restore popup
      '--hide-crash-restore-bubble',
      // disable chrome's password autosave popups
      '--disable-features=PasswordAutosave',
      // disable chrome's passkey popups
      '--disable-features=WebAuthn',
      // disable chrome creating 1GB temp directories on each run
      '--disable-features=MacAppCodeSignClone'
    ],
    ignoreDefaultArgs: [
      // disable chrome's default automation detection flag
      '--enable-automation',
      // adding this cause chrome shows a weird admin popup without it
      '--no-sandbox',
      // adding this cause chrome shows a weird admin popup without it
      '--disable-blink-features=AutomationControlled'
    ],
    // bypass amazon's default content security policy which allows us to inject
    // our own scripts into the page
    bypassCSP: true,
    deviceScaleFactor,
    viewport: { width: 1280, height: 720 }
  })

  const page = context.pages()[0] ?? (await context.newPage())

  await page.route('**/*', async (route) => {
    const urlString = route.request().url()
    for (const regex of urlRegexBlacklist) {
      if (regex.test(urlString)) {
        return route.abort()
      }
    }

    return route.continue()
  })

  page.on('response', async (response) => {
    try {
      const status = response.status()
      if (status !== 200) {
        return
      }

      const url = new URL(response.url())
      if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return

        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }

        if (!result.meta) {
          console.warn('book meta', metadata)
          result.meta = metadata
        }
      } else if (
        url.hostname === 'read.amazon.com' &&
        url.searchParams.get('asin')?.toLowerCase() === asinL
      ) {
        if (url.pathname === '/service/mobile/reader/startReading') {
          const body: any = await response.json()
          delete body.karamelToken
          delete body.metadataUrl
          delete body.YJFormatVersion
          if (!result.info) {
            console.warn('book info', body)
          }
          result.info = body
        } else if (url.pathname === '/renderer/render') {
          // TODO: these TAR files have some useful metadata that we could use...
          const params = Object.fromEntries(url.searchParams.entries())
          const hash = hashObject(params)
          const renderDir = path.join(userDataDir, 'render', hash)
          await fs.mkdir(renderDir, { recursive: true })
          const body = await response.body()
          const tempDir = await extractTar(body, { cwd: renderDir })
          const { startingPosition, skipPageCount, numPage } = params
          console.log('RENDER TAR', tempDir, {
            startingPosition,
            skipPageCount,
            numPage
          })

          const locationMap = await tryReadJsonFile<AmazonRenderLocationMap>(
            path.join(renderDir, 'location_map.json')
          )
          if (locationMap) {
            result.locationMap = locationMap

            for (const navUnit of result.locationMap.navigationUnit) {
              navUnit.page = Number.parseInt(navUnit.label, 10)
              assert(
                !Number.isNaN(navUnit.page),
                `invalid locationMap page number: ${navUnit.label}`
              )
            }
          }

          const metadata = await tryReadJsonFile<any>(
            path.join(renderDir, 'metadata.json')
          )
          if (metadata) {
            result.nav.startPosition = metadata.firstPositionId
            result.nav.endPosition = metadata.lastPositionId
          }

          const rawToc = await tryReadJsonFile<AmazonRenderToc>(
            path.join(renderDir, 'toc.json')
          )
          if (rawToc && result.locationMap && !result.toc) {
            const toc: TocItem[] = []

            for (const rawTocItem of rawToc) {
              toc.push(...getTocItems(rawTocItem, { depth: 0 }))
            }

            result.toc = toc
          }

          // TODO: `page_data_0_5.json` has start/end/words for each page in this render batch
          // const toc = JSON.parse(
          //   await fs.readFile(path.join(tempDir, 'toc.json'), 'utf8')
          // )
          // console.warn('toc', toc)
        }
      }
    } catch {}
  })

  // Only used for the 'blob' render method
  const capturedBlobs = new Map<
    string,
    {
      type: string
      base64: string
    }
  >()

  if (renderMethod === 'blob') {
    await page.exposeFunction('nodeLog', (...args: any[]) => {
      console.error('[page]', ...args)
    })

    await page.exposeBinding('captureBlob', (_source, url, payload) => {
      capturedBlobs.set(url, payload)
    })

    await context.addInitScript(() => {
      const origCreateObjectURL = URL.createObjectURL.bind(URL)
      URL.createObjectURL = function (blob: Blob) {
        // TODO: filter for image/png blobs? since those are the only ones we're using
        // (haven't found this to be an issue in practice)
        const type = blob.type || 'application/octet-stream'
        const url = origCreateObjectURL(blob)
        // nodeLog('createObjectURL', url, type, blob.size)

        // Snapshot blob bytes immediately because kindle's renderer revokes
        // them immediately after they're used.
        ;(async () => {
          const buf = await blob.arrayBuffer()
          // store raw base64 (not data URL) to keep payload small
          let binary = ''
          const bytes = new Uint8Array(buf)
          for (const byte of bytes) {
            // eslint-disable-next-line unicorn/prefer-code-point
            binary += String.fromCharCode(byte)
          }

          const base64 = btoa(binary)

          // @ts-expect-error captureBlob
          captureBlob(url, { type, base64 })
        })()

        return url
      }
    })
  }

  // Try going directly to the book reader page if we're already authenticated.
  // Otherwise wait for the signin page to load.
  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

  // If we're on the signin page, start the authentication flow.
  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    // await page.locator('input[type="checkbox"]').click()
    await page.locator('input[type="submit"]').click()

    if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
      // Wait for an SMS/2FA code delivered out-of-band into /tmp/amazon_otp.txt
      // (Amazon SMS is triggered the moment this verify screen loads above.)
      // eslint-disable-next-line no-process-env
      let code = process.env.AMAZON_OTP || ''
      if (!code) {
        const otpFile = '/tmp/amazon_otp.txt'
        const fsx = await import('node:fs/promises')
        console.log('WAITING_FOR_OTP_FILE ' + otpFile)
        for (let i = 0; i < 100; i++) {
          // up to ~8min (5s * 100)
          try {
            const c = (await fsx.readFile(otpFile, 'utf8')).trim()
            if (/^\d{4,8}$/.test(c)) {
              code = c
              console.log('GOT_OTP_FROM_FILE')
              break
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
      if (!code) {
        code = await input({ message: '2-factor auth code?' })
      }

      // Only enter 2-factor auth code if needed
      if (code) {
        // Amazon may show either the authenticator-app field (input[type="tel"])
        // or the SMS CVF screen (input[name="otc"] + #continue). Handle both.
        const telCount = await page.locator('input[type="tel"]').count()
        const otcCount = await page.locator('input[name="otc"]').count()
        if (otcCount > 0) {
          await page.locator('input[name="otc"]').fill(code)
          const cont = page.locator('#continue, input[type="submit"]').first()
          await cont.click()
        } else if (telCount > 0) {
          await page.locator('input[type="tel"]').fill(code)
          await page
            .locator(
              'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
            )
            .click()
        }
        await page.waitForTimeout(4000)
      }
    }

    if (!page.url().includes(bookReaderUrl)) {
      await page.goto(bookReaderUrl)
    }
  }

  async function firstVisibleLocator(
    selectors: string[],
    { timeout = 5000 }: { timeout?: number } = {}
  ) {
    const deadline = Date.now() + timeout
    let lastErr: unknown

    do {
      for (const selector of selectors) {
        const locator = page.locator(selector).first()
        try {
          if (await locator.isVisible({ timeout: 250 })) {
            return locator
          }
        } catch (err) {
          lastErr = err
        }
      }

      await delay(100)
    } while (Date.now() < deadline)

    if (lastErr) {
      console.warn('Selector lookup failed', String(lastErr))
    }
  }

  async function clickFirstVisible(
    selectors: string[],
    {
      timeout = 5000,
      optional = false
    }: { timeout?: number; optional?: boolean } = {}
  ) {
    const locator = await firstVisibleLocator(selectors, { timeout })
    if (!locator) {
      if (optional) {
        return false
      }

      throw new Error(
        `Unable to find visible selector: ${selectors.join(', ')}`
      )
    }

    await locator.click()
    return true
  }

  async function firstTextContent(selectors: string[]) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      try {
        if (await locator.isVisible({ timeout: 250 })) {
          const text = await locator.textContent()
          if (text?.trim()) {
            return text
          }

          const ariaLabel = await locator.getAttribute('aria-label')
          if (ariaLabel?.trim()) {
            return ariaLabel
          }
        }
      } catch {}
    }
  }

  async function findPageNavTextFromDocument() {
    return page.evaluate(() => {
      const global = globalThis as any
      const doc = global.document
      const walker = doc.createTreeWalker(doc.body, 4)
      let node = walker.nextNode()

      while (node) {
        const text = node.textContent?.replaceAll(/\s+/g, ' ').trim()
        if (
          text &&
          /(page\s+\d+\s+of\s+\d+|location\s+\d+\s+of\s+\d+)/i.test(text)
        ) {
          return text
        }

        node = walker.nextNode()
      }
    })
  }

  async function revealReaderChrome() {
    await page.mouse.move(640, 24).catch(() => undefined)
    await page
      .locator(
        '#reader-header, .top-chrome, ion-header, [data-testid="reader-header"]'
      )
      .first()
      .hover({ force: true, timeout: 1000 })
      .catch(() => undefined)
    await page.keyboard.press('Escape').catch(() => undefined)
    await delay(200)
  }

  async function logReaderDiagnostics(tag: string) {
    const diagnostics = await page.evaluate(() => {
      const global = globalThis as any
      const doc = global.document
      const buttons = Array.from(
        doc.querySelectorAll(
          'button, ion-button, [role="button"], [aria-label]'
        )
      )
        .map((el: any) => ({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.replaceAll(/\s+/g, ' ').trim().slice(0, 80),
          ariaLabel: el.getAttribute('aria-label'),
          id: el.id,
          className:
            typeof el.className === 'string'
              ? el.className.slice(0, 80)
              : undefined
        }))
        .filter((item) => item.text || item.ariaLabel || item.id)
        .slice(0, 40)

      return {
        url: global.location.href,
        title: doc.title,
        text: doc.body?.textContent?.replaceAll(/\s+/g, ' ').slice(0, 800),
        buttons
      }
    })
    console.warn(`${tag}: ${JSON.stringify(diagnostics, null, 2)}`)
  }

  async function updateSettings() {
    console.log('Looking for Reader settings button')
    await revealReaderChrome()
    const settingsButton = await firstVisibleLocator(
      [
        'ion-button[aria-label="Reader settings"]',
        'button[aria-label="Reader settings"]',
        '[aria-label="Reader settings"]',
        'ion-button[aria-label="Aa"]',
        'button[aria-label="Aa"]',
        '[aria-label="Aa"]'
      ],
      { timeout: 30_000 }
    )

    if (!settingsButton) {
      await logReaderDiagnostics('reader-settings-missing')
      console.warn('Reader settings button not found; continuing with defaults')
      return
    }

    console.log('Clicking Reader settings')
    await settingsButton.click()
    await delay(500)

    // Change font to Amazon Ember
    // My hypothesis is that this font will be easier for OCR to transcribe...
    // TODO: evaluate different fonts & settings
    console.log('Changing font to Amazon Ember')
    await clickFirstVisible(
      [
        '#AmazonEmber',
        '[value="AmazonEmber"]',
        '[aria-label="Amazon Ember"]',
        'text=/Amazon\\s+Ember/i'
      ],
      { timeout: 2000, optional: true }
    )
    await delay(200)

    // Change layout to single column
    console.log('Changing to single column layout')
    await clickFirstVisible(
      [
        '[role="radio"][aria-label*="Single Column"]',
        '[role="radio"][aria-label*="single column" i]',
        '[aria-label*="Single Column"]',
        'text=/Single\\s+Column/i'
      ],
      { timeout: 2000, optional: true }
    )
    await delay(200)

    console.log('Closing settings')
    const closedSettings = await clickFirstVisible(
      [
        'ion-button[aria-label="Close"]',
        'button[aria-label="Close"]',
        '[aria-label="Close"]'
      ],
      { timeout: 1000, optional: true }
    )
    if (
      !closedSettings &&
      (await settingsButton.isVisible().catch(() => false))
    ) {
      await settingsButton.click()
    }
    await delay(500)
  }

  async function goToPage(pageNumber: number) {
    await revealReaderChrome()
    await delay(200)
    await clickFirstVisible(
      [
        'ion-button[aria-label="Reader menu"]',
        'button[aria-label="Reader menu"]',
        '[aria-label="Reader menu"]',
        'ion-button[aria-label="More options"]',
        'button[aria-label="More options"]',
        '[aria-label="More options"]'
      ],
      { timeout: 10_000 }
    )
    await delay(500)
    await clickFirstVisible(
      [
        'ion-item[role="listitem"]:has-text("Go to Page")',
        'ion-item:has-text("Go to Page")',
        'button:has-text("Go to Page")',
        '[role="menuitem"]:has-text("Go to Page")',
        'text=/Go\\s+to\\s+Page/i'
      ],
      { timeout: 10_000 }
    )
    const pageInput = await firstVisibleLocator(
      [
        'ion-modal input[placeholder="page number"]',
        'ion-modal input[placeholder*="page" i]',
        'input[placeholder="page number"]',
        'input[placeholder*="page" i]',
        'input[type="number"]',
        'input[type="tel"]'
      ],
      { timeout: 10_000 }
    )
    assert(pageInput, 'Unable to find go-to-page input')
    await pageInput.fill(`${pageNumber}`)
    // await page.locator('ion-modal button', { hasText: 'Go' }).click()
    await clickFirstVisible(
      [
        'ion-modal ion-button[item-i-d="go-to-modal-go-button"]',
        'ion-modal ion-button:has-text("Go")',
        'ion-modal button:has-text("Go")',
        'button:has-text("Go")'
      ],
      { timeout: 10_000 }
    )
    await delay(500)
  }

  async function getPageNav() {
    const footerText =
      (await firstTextContent([
        'ion-footer ion-title',
        'ion-footer',
        '[role="contentinfo"]',
        '[aria-label*="Page" i]',
        '[aria-label*="Location" i]'
      ])) ?? (await findPageNavTextFromDocument())
    return parsePageNav(footerText)
  }

  async function ensureFixedHeaderUI() {
    await revealReaderChrome()
    const patched = await page.evaluate(() => {
      const doc = (globalThis as any).document
      const selectors = [
        '.top-chrome',
        '#reader-header',
        'ion-header',
        '[data-testid="reader-header"]',
        '[class*="reader-header"]',
        '[class*="ReaderHeader"]'
      ]
      const elements = selectors.flatMap((selector) =>
        Array.from(doc.querySelectorAll(selector))
      )

      for (const el of elements as any[]) {
        el.style.transition = 'none'
        el.style.transform = 'none'
        el.style.opacity = '1'
      }

      return elements.length
    })
    if (!patched) {
      await logReaderDiagnostics('reader-header-missing')
      console.warn('Reader header not found; continuing without header patch')
    }
  }

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('ion-alert button', { hasText: 'No' })
    if (await $alertNo.isVisible()) {
      await $alertNo.click()
    }
  }

  async function writeResultMetadata() {
    return fs.writeFile(
      metadataPath,
      JSON.stringify(normalizeBookMetadata(result), null, 2)
    )
  }

  function getTocItems(
    rawTocItem: AmazonRenderTocItem,
    { depth = 0 }: { depth?: number } = {}
  ): TocItem[] {
    const positionId = rawTocItem.tocPositionId
    const page = getPageForPosition(positionId)

    const tocItem: TocItem = {
      label: rawTocItem.label,
      positionId,
      page,
      depth
    }

    const tocItems: TocItem[] = [tocItem]

    if (rawTocItem.entries) {
      for (const rawTocItemEntry of rawTocItem.entries) {
        tocItems.push(...getTocItems(rawTocItemEntry, { depth: depth + 1 }))
      }
    }

    return tocItems
  }

  function getPageForPosition(position: number): number {
    if (!result.locationMap) return -1

    let resultPage = 1

    // TODO: this is O(n) but we can do better
    for (const { startPosition, page } of result.locationMap.navigationUnit) {
      if (startPosition > position) break

      resultPage = page
    }

    return resultPage
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  console.log('Waiting for book reader to load...')
  await page
    .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
    .catch(() => {
      console.warn(
        'Main reader content may not have loaded, continuing anyway...'
      )
    })

  // Record the initial page navigation so we can reset back to it later
  const initialPageNav = await getPageNav()

  // At this point, we should have recorded all the base book metadata from the
  // initial network requests.
  assert(result.info, 'expected book info to be initialized')
  assert(result.meta, 'expected book meta to be initialized')
  assert(result.toc?.length, 'expected book toc to be initialized')
  assert(result.locationMap, 'expected book location map to be initialized')

  result.nav.startContentPosition = result.meta.startPosition
  result.nav.totalNumPages = result.locationMap.navigationUnit.reduce(
    (acc, navUnit) => {
      return Math.max(acc, navUnit.page ?? -1)
    },
    -1
  )
  assert(result.nav.totalNumPages > 0, 'parsed book nav has no pages')
  result.nav.startContentPage = getPageForPosition(
    result.nav.startContentPosition
  )

  const parsedToc = parseTocItems(result.toc, {
    totalNumPages: result.nav.totalNumPages
  })
  result.nav.endContentPage =
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages
  result.nav.endContentPosition =
    parsedToc.firstPostContentPageTocItem?.positionId ?? result.nav.endPosition

  result.nav.totalNumContentPages = Math.min(
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages,
    result.nav.totalNumPages
  )
  assert(result.nav.totalNumContentPages > 0, 'No content pages found')
  const pageNumberPaddingAmount = `${result.nav.totalNumContentPages * 2}`
    .length
  await writeResultMetadata()

  // Navigate to the first content page of the book
  await goToPage(result.nav.startContentPage)

  let done = false
  console.warn(
    `\nreading ${result.nav.totalNumContentPages} content pages out of ${result.nav.totalNumPages} total pages...\n`
  )

  // Loop through each page of the book
  do {
    const pageNav = await getPageNav()

    if (pageNav?.page === undefined) {
      break
    }

    if (pageNav.page > result.nav.totalNumContentPages) {
      break
    }

    const index = result.pages.length

    const src = (await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src'))!

    let renderedPageImageBuffer: Buffer | undefined

    if (renderMethod === 'blob') {
      const blob = await pRace<{ type: string; base64: string } | undefined>(
        (signal) => [
          (async () => {
            while (!signal.aborted) {
              const blob = capturedBlobs.get(src)

              if (blob) {
                capturedBlobs.delete(src)
                return blob
              }

              await delay(1)
            }
          })(),

          delay(10_000, { signal })
        ]
      )

      assert(
        blob,
        `no blob found for src: ${src} (index ${index}; page ${pageNav.page})`
      )

      const rawRenderedImage = Buffer.from(blob.base64, 'base64')
      const c = sharp(rawRenderedImage)
      const m = await c.metadata()
      renderedPageImageBuffer = await c
        .resize({
          width: Math.floor(m.width / deviceScaleFactor),
          height: Math.floor(m.height / deviceScaleFactor)
        })
        .png({ quality: 90 })
        .toBuffer()
    } else {
      renderedPageImageBuffer = await page
        .locator(krRendererMainImageSelector)
        .screenshot({ type: 'png', scale: 'css' })
    }

    assert(
      renderedPageImageBuffer,
      `no buffer found for src: ${src} (index ${index}; page ${pageNav.page})`
    )

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pageNumberPaddingAmount, '0') +
        '-' +
        `${pageNav.page}`.padStart(pageNumberPaddingAmount, '0') +
        '.png'
    )

    await fs.writeFile(screenshotPath, renderedPageImageBuffer)
    const pageChunk = {
      index,
      page: pageNav.page,
      screenshot: screenshotPath
    }
    result.pages.push(pageChunk)
    console.warn(pageChunk)
    await writeResultMetadata()

    let retries = 0

    do {
      // This delay seems to help speed up the navigation process, possibly due
      // to the navigation chevron needing time to settle.
      await delay(100)

      let navigationTimeout = 10_000
      try {
        // await page.keyboard.press('ArrowRight')
        await page
          .locator('.kr-chevron-container-right')
          .click({ timeout: 5000 })
      } catch (err: any) {
        console.warn('unable to click next page button', err.message, pageNav)
        navigationTimeout = 1000
      }

      const navigatedToNextPage = await pRace<boolean | undefined>((signal) => [
        (async () => {
          while (!signal.aborted) {
            const newSrc = await page
              .locator(krRendererMainImageSelector)
              .getAttribute('src')

            if (newSrc && newSrc !== src) {
              // Successfully navigated to the next page
              return true
            }

            await delay(10)
          }

          return false
        })(),

        delay(navigationTimeout, { signal })
      ])

      if (navigatedToNextPage) {
        break
      }

      if (++retries >= 30) {
        console.warn('unable to navigate to next page; breaking...', pageNav)
        done = true
        break
      }
    } while (true)
  } while (!done)

  await writeResultMetadata()
  console.log()
  console.log(metadataPath)

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page
    await goToPage(initialPageNav.page)
  }

  await context.close()
  await context.browser()?.close()
}

await main()
