/**
 * BeamForge Mod Index Scraper
 *
 * Scrapes:
 *   - BeamNG.com/resources/ (XenForo 2 Resource Manager)
 *   - beamng-mods.net       (WordPress community hub)
 *
 * Outputs:
 *   index.json
 *   beamng/page-N.json   (50 mods per page)
 *   modland/page-N.json
 *
 * Run: node scripts/scrape.mjs
 */

import https from 'node:https'
import http  from 'node:http'
import fs    from 'node:fs'
import path  from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseHtml } from 'node-html-parser'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.resolve(__dirname, '..')
const PAGE_SIZE  = 50
const DELAY_MS   = 1200   // polite delay between requests

// ── HTTP ──────────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control':   'no-cache',
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function fetchHtml(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('Too many redirects: ' + url))
    let parsed
    try { parsed = new URL(url) } catch { return reject(new Error('Bad URL: ' + url)) }
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: HEADERS, timeout: 25000 },
      (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location
          const next = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.host}${loc}`
          res.resume()
          return fetchHtml(next, depth + 1).then(resolve).catch(reject)
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf-8'), status: res.statusCode ?? 200 }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)) })
    req.end()
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(s) {
  return parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0
}

function parseRating(s) {
  const slash = String(s).match(/([\d.]+)\s*\/\s*([\d.]+)/)
  if (slash) {
    const val = parseFloat(slash[1]), max = parseFloat(slash[2])
    return max > 0 ? Math.round((val / max) * 50) / 10 : val
  }
  return parseFloat(String(s).replace(/[^\d.]/g, '')) || 0
}

function resolveUrl(src, base) {
  if (!src) return ''
  if (src.startsWith('http')) return src
  if (src.startsWith('//')) return 'https:' + src
  try { return new URL(src, base).href } catch { return src }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BeamNG Scraper
// ═══════════════════════════════════════════════════════════════════════════

const BEAMNG_BASE = 'https://www.beamng.com'

// Category ID → human label (for categoryTitle field)
const BEAMNG_CAT_LABELS = {
  2: 'Vehicles', 3: 'Scripts', 4: 'Other', 5: 'Maps', 6: 'Parts'
}

function buildBeamNGUrl(page) {
  return `${BEAMNG_BASE}/resources/?order=last_update&direction=desc&page=${page}`
}

function parseBeamNGItem(el) {
  try {
    const titleEl = (
      el.querySelector('.contentRow-title > a[href*="/resources/"]') ??
      el.querySelector('.resourceListItem-title > a[href*="/resources/"]') ??
      el.querySelector('h3 > a[href*="/resources/"]') ??
      el.querySelector('a[href*="/resources/"]')
    )
    if (!titleEl) return null
    const href    = titleEl.getAttribute('href') ?? ''
    const idMatch = href.match(/\.(\d+)\/?(?:\?|#|$)/)
    if (!idMatch) return null
    const id    = parseInt(idMatch[1], 10)
    const title = titleEl.text.trim()
    if (!title || !id) return null

    const imgEl = (
      el.querySelector('.resourceListItem-icon') ??
      el.querySelector('.contentRow-figure img') ??
      el.querySelector('.resourceListItem-figure img') ??
      el.querySelector('img[src*="beamng.com"]') ??
      el.querySelector('img')
    )
    let thumbnailUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? ''
    if (thumbnailUrl && !thumbnailUrl.startsWith('http')) {
      thumbnailUrl = thumbnailUrl.startsWith('//') ? 'https:' + thumbnailUrl : BEAMNG_BASE + thumbnailUrl
    }

    const authorEl = (
      el.querySelector('.username[href*="/members/"]') ??
      el.querySelector('a[href*="/members/"]') ??
      el.querySelector('.resourceListItem-author a')
    )
    const author = authorEl?.text.trim() ?? ''

    const verEl  = el.querySelector('.resourceListItem-version, [class*="version"]')
    const version = verEl?.text.replace(/^[\s\-–]+/, '').trim() ?? ''

    const tagLineEl = (
      el.querySelector('.resourceListItem-tagLine') ??
      el.querySelector('.contentRow-snippet') ??
      el.querySelector('[class*="tagLine"]')
    )
    const tagLine = tagLineEl?.text.trim() ?? ''

    // Stats via <dl><dt>N</dt><dd>label</dd></dl>
    let downloadCount = 0, viewCount = 0, rating = 0, ratingCount = 0
    for (const dl of el.querySelectorAll('dl')) {
      const dt  = dl.querySelector('dt')?.text.trim() ?? ''
      const dd  = dl.querySelector('dd')?.text.toLowerCase().trim() ?? ''
      if (!dt || !dd) continue
      if (dd.includes('download'))    downloadCount = parseNum(dt)
      else if (dd.includes('view'))   viewCount     = parseNum(dt)
      else if (dd.includes('rating')) rating        = parseRating(dt)
      else if (dd.includes('review')) ratingCount   = parseNum(dt)
    }

    // Category — read from class name like "resource_category_2"
    let categoryId = 0
    for (const cls of (el.getAttribute('class') ?? '').split(' ')) {
      const m = cls.match(/resource_category_(\d+)/)
      if (m) { categoryId = parseInt(m[1], 10); break }
    }

    const timeEl = el.querySelector('time, .u-dt, .dateTime')
    let lastUpdate = 0
    if (timeEl) {
      const ts  = timeEl.getAttribute('data-time')
      const dt  = timeEl.getAttribute('datetime')
      lastUpdate = ts ? parseInt(ts, 10) : (dt ? Math.floor(new Date(dt).getTime() / 1000) : 0)
    }

    const resourceUrl = `${BEAMNG_BASE}${href.startsWith('/') ? href : '/' + href}`
    const downloadUrl = `${BEAMNG_BASE}/resources/${id}/download`

    return {
      id, source: 'beamng', title, author, version,
      downloadCount, viewCount, rating, ratingCount,
      categoryId, categoryTitle: BEAMNG_CAT_LABELS[categoryId] ?? '',
      description: tagLine, tagLine, thumbnailUrl,
      downloadUrl, resourceUrl, lastUpdate, postedDate: lastUpdate,
      requiresLogin: true,
    }
  } catch { return null }
}

async function scrapeBeamNGPage(page) {
  const url = buildBeamNGUrl(page)
  console.log(`  [BeamNG] page ${page}: ${url}`)
  const { html, status } = await fetchHtml(url)
  if (status >= 400) { console.warn(`  [BeamNG] HTTP ${status} on page ${page}`); return { items: [], hasMore: false } }

  const root  = parseHtml(html)
  let itemEls = root.querySelectorAll('.resourceListItem')
  if (!itemEls.length) itemEls = root.querySelectorAll('[class*="resourceListItem"]:not(ol):not(ul)')
  if (!itemEls.length) itemEls = root.querySelectorAll('.block-row[class*="resource"]')

  const items = []
  for (const el of itemEls) {
    if (el.tagName === 'OL' || el.tagName === 'UL') continue
    const r = parseBeamNGItem(el)
    if (r && r.id > 0) items.push(r)
  }

  // Check for next page: look for "next" link or data-last attribute
  const pageNavEl = root.querySelector('[data-last]')
  const totalPages = pageNavEl ? parseInt(pageNavEl.getAttribute('data-last') ?? '1', 10) : 0
  const hasMore = totalPages > page || (items.length >= 18 && !pageNavEl)

  console.log(`  [BeamNG] page ${page}: ${items.length} items, hasMore=${hasMore}`)
  return { items, hasMore, totalPages }
}

async function scrapeBeamNG() {
  console.log('\n=== Scraping BeamNG.com ===')
  const allMods = []
  let page = 1
  let totalPages = 999

  while (page <= totalPages && page <= 200) { // hard cap 200 pages
    try {
      const { items, hasMore, totalPages: tp } = await scrapeBeamNGPage(page)
      if (tp) totalPages = tp
      allMods.push(...items)
      if (!hasMore || items.length === 0) break
      page++
      await delay(DELAY_MS)
    } catch (err) {
      console.error(`  [BeamNG] Error on page ${page}:`, err.message)
      break
    }
  }

  console.log(`[BeamNG] Total scraped: ${allMods.length} mods`)
  return allMods
}

// ═══════════════════════════════════════════════════════════════════════════
//  Modland (beamng-mods.net) Scraper
// ═══════════════════════════════════════════════════════════════════════════

const MODLAND_BASE = 'https://beamng-mods.net'

function buildModlandUrl(page) {
  return page > 1 ? `${MODLAND_BASE}/page/${page}/` : `${MODLAND_BASE}/`
}

function parseModlandItem(el, idCounter) {
  try {
    const titleEl = (
      el.querySelector('.entry-title a, h2.post-title a, h3.post-title a, .post-header a') ??
      el.querySelector('a[rel="bookmark"], .post h2 a, article h2 a, article h3 a')
    )
    if (!titleEl) return null
    const title       = titleEl.text.trim()
    const resourceUrl = titleEl.getAttribute('href') ?? ''
    if (!title || !resourceUrl) return null

    // Stable hash ID from URL slug
    const slugMatch = resourceUrl.match(/\/([^/]+)\/?$/)
    const slug      = slugMatch ? slugMatch[1] : String(idCounter)
    const slugHash  = Array.from(slug).reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0x7fffffff, 0) + 1_000_000

    const imgEl = (
      el.querySelector('.post-thumbnail img, .featured-image img, .entry-image img') ??
      el.querySelector('img.wp-post-image, img.attachment-post-thumbnail') ??
      el.querySelector('img')
    )
    let thumbnailUrl = imgEl?.getAttribute('src') ?? imgEl?.getAttribute('data-src') ?? imgEl?.getAttribute('data-lazy-src') ?? ''
    thumbnailUrl     = resolveUrl(thumbnailUrl, MODLAND_BASE)

    const authorEl = (
      el.querySelector('.author a, .post-author a, .entry-author a, [class*="author"] a') ??
      el.querySelector('a[href*="/author/"]')
    )
    const author   = authorEl?.text.trim() ?? 'Unknown'

    const descEl   = el.querySelector('.entry-summary, .post-excerpt, .entry-content p') ?? el.querySelector('p')
    const tagLine  = descEl?.text.trim().slice(0, 200) ?? ''

    const dlEl      = el.querySelector('a[href$=".zip"], a[href$=".7z"], a[href*="download"]')
    const downloadUrl = dlEl?.getAttribute('href') ?? ''

    const dlCountEl    = el.querySelector('[class*="download-count"], [class*="views"], .post-views')
    const downloadCount = dlCountEl ? parseNum(dlCountEl.text) : 0

    const timeEl = el.querySelector('time, [datetime]')
    let lastUpdate = 0
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime') ?? timeEl.getAttribute('content') ?? ''
      lastUpdate = dt ? Math.floor(new Date(dt).getTime() / 1000) : 0
    }

    return {
      id: slugHash, source: 'modland', title, author, version: '',
      downloadCount, viewCount: 0, rating: 0, ratingCount: 0,
      categoryId: 0, categoryTitle: '',
      description: tagLine, tagLine, thumbnailUrl,
      downloadUrl, resourceUrl, lastUpdate, postedDate: lastUpdate,
      requiresLogin: false,
    }
  } catch { return null }
}

async function scrapeModlandPage(page) {
  const url = buildModlandUrl(page)
  console.log(`  [Modland] page ${page}: ${url}`)
  const { html, status } = await fetchHtml(url)
  if (status === 404) return { items: [], hasMore: false }
  if (status >= 400) { console.warn(`  [Modland] HTTP ${status} on page ${page}`); return { items: [], hasMore: false } }

  const root  = parseHtml(html)
  let itemEls = root.querySelectorAll('article.post, article[class*="type-post"], .post-item, .mod-item')
  if (!itemEls.length) itemEls = root.querySelectorAll('article')
  if (!itemEls.length) itemEls = root.querySelectorAll('.entry, .hentry')

  const items = []
  let counter = page * 1000
  for (const el of itemEls) {
    const r = parseModlandItem(el, counter++)
    if (r) items.push(r)
  }

  // WordPress pagination — look for next page link
  const nextEl   = root.querySelector('a.next, a[rel="next"], .page-numbers.next')
  const hasMore  = !!nextEl && items.length > 0

  console.log(`  [Modland] page ${page}: ${items.length} items, hasMore=${hasMore}`)
  return { items, hasMore }
}

async function scrapeModland() {
  console.log('\n=== Scraping beamng-mods.net ===')
  const allMods = []
  let page      = 1

  while (page <= 100) { // hard cap 100 pages
    try {
      const { items, hasMore } = await scrapeModlandPage(page)
      allMods.push(...items)
      if (!hasMore || items.length === 0) break
      page++
      await delay(DELAY_MS)
    } catch (err) {
      console.error(`  [Modland] Error on page ${page}:`, err.message)
      break
    }
  }

  console.log(`[Modland] Total scraped: ${allMods.length} mods`)
  return allMods
}

// ═══════════════════════════════════════════════════════════════════════════
//  Write output
// ═══════════════════════════════════════════════════════════════════════════

function writePages(source, mods) {
  const dir = path.join(OUTPUT_DIR, source)
  fs.mkdirSync(dir, { recursive: true })

  // Remove old pages
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('page-') && f.endsWith('.json')) {
      fs.unlinkSync(path.join(dir, f))
    }
  }

  const totalPages = Math.ceil(mods.length / PAGE_SIZE) || 1
  for (let i = 0; i < totalPages; i++) {
    const page  = i + 1
    const chunk = mods.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
    fs.writeFileSync(
      path.join(dir, `page-${page}.json`),
      JSON.stringify(chunk, null, 2)
    )
    console.log(`  Wrote ${source}/page-${page}.json (${chunk.length} mods)`)
  }
  return totalPages
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════

console.log('BeamForge Mod Index Scraper starting...')
console.log('Output directory:', OUTPUT_DIR)

let beamngMods  = []
let modlandMods = []

try {
  beamngMods = await scrapeBeamNG()
} catch (err) {
  console.error('[BeamNG] Fatal scrape error:', err.message)
}

try {
  modlandMods = await scrapeModland()
} catch (err) {
  console.error('[Modland] Fatal scrape error:', err.message)
}

const beamngPages  = writePages('beamng',  beamngMods)
const modlandPages = writePages('modland', modlandMods)

const index = {
  version:   1,
  updatedAt: Math.floor(Date.now() / 1000),
  sources: {
    beamng: {
      totalMods:  beamngMods.length,
      totalPages: beamngPages,
      pageSize:   PAGE_SIZE,
    },
    modland: {
      totalMods:  modlandMods.length,
      totalPages: modlandPages,
      pageSize:   PAGE_SIZE,
    },
  }
}

fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 2))
console.log('\nWrote index.json')
console.log(`\nDone! BeamNG: ${beamngMods.length} mods (${beamngPages} pages) | Modland: ${modlandMods.length} mods (${modlandPages} pages)`)
