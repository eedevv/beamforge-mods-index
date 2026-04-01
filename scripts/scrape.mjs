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
const DELAY_MS   = 1500   // polite delay between requests

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
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: HEADERS, timeout: 30000 },
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

function resolveUrl(src, base) {
  if (!src) return ''
  if (src.startsWith('http')) return src
  if (src.startsWith('//')) return 'https:' + src
  try { return new URL(src, base).href } catch { return src }
}

function parseDateTitle(title) {
  // title is like "Feb 3, 2026 at 10:06 AM"
  if (!title) return 0
  try { return Math.floor(new Date(title.replace(' at ', ' ')).getTime() / 1000) } catch { return 0 }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BeamNG Scraper
// ═══════════════════════════════════════════════════════════════════════════

const BEAMNG_BASE = 'https://www.beamng.com'

// Category definitions — matches what the app shows
const BEAMNG_CATEGORIES = [
  { id: 2,  label: 'Vehicles',           urlSlug: 'vehicles.2' },
  { id: 9,  label: 'Maps',               urlSlug: 'terrains-levels-maps.9' },
  { id: 8,  label: 'Scenarios',          urlSlug: 'scenarios.8' },
  { id: 10, label: 'User Interface Apps',urlSlug: 'user-interface-apps.10' },
  { id: 13, label: 'Sounds',             urlSlug: 'sounds.13' },
  { id: 12, label: 'Skins',              urlSlug: 'skins.12' },
  { id: 7,  label: 'Mods of Mods',       urlSlug: 'mods-of-mods.7' },
]

// Map app category IDs to what we'll store
const CAT_ID_TO_LABEL = {
  2: 'Vehicles', 9: 'Maps', 8: 'Scenarios',
  10: 'User Interface Apps', 13: 'Sounds', 12: 'Skins', 7: 'Mods of Mods',
}

// Map scraped category IDs to app category IDs (for the app's category filter)
// App categories: 0=All, 2=Vehicles, 5=Maps, 6=Parts, 3=Scripts
// We'll keep original IDs but map to closest app category for display
const CAT_ID_TO_APP_CAT = {
  2:  2,   // Vehicles → Vehicles
  9:  5,   // Maps → Maps
  8:  3,   // Scenarios → Scripts
  10: 3,   // UI Apps → Scripts
  13: 6,   // Sounds → Parts (misc)
  12: 6,   // Skins → Parts
  7:  6,   // Mods of Mods → Parts (misc)
}

/**
 * Parse a single resource list item (li.visible or li.featuredResource)
 * Actual HTML structure from www.beamng.com/resources/:
 *
 * <li class="visible">
 *   <div class="resourceImage">
 *     <a href="resources/slug.ID/" class="resourceIcon"><img src="...jpg" /></a>
 *   </div>
 *   <div class="resourceBody">
 *     <a href="resources/slug.ID/" class="resourceTitle">TITLE</a>
 *     <div class="tagLine">TEXT <span class="author">- by AUTHOR</span></div>
 *     <div class="lastUpdate">Updated: <span class="DateTime" title="Feb 3, 2026 at 10:06 AM">...</span></div>
 *   </div>
 * </li>
 *
 * Featured resources use .resourceInfo with h3.title > a, .details > a.username
 */
function parseBeamNGItem(el, categoryId) {
  try {
    // Title link — try both list-style and featured-style
    const titleEl = (
      el.querySelector('a.resourceTitle') ??
      el.querySelector('.resourceInfo h3.title a') ??
      el.querySelector('h3.title a') ??
      el.querySelector('a[href*="resources/"]')
    )
    if (!titleEl) return null

    const href = titleEl.getAttribute('href') ?? ''
    // Extract numeric ID from slug like "resources/slug-name.29318/" or "resources/slug-name.29318"
    const idMatch = href.match(/\.(\d+)\/?$/) ?? href.match(/\.(\d+)/)
    if (!idMatch) return null

    const id    = parseInt(idMatch[1], 10)
    const title = titleEl.text.trim().replace(/^\[[\w\s]+\]\s*/, '') // strip prefix badges
    if (!title || id <= 0) return null

    // Thumbnail from resourceIcon img
    const iconEl  = el.querySelector('a.resourceIcon img') ?? el.querySelector('.resourceImage img')
    let thumbnailUrl = iconEl?.getAttribute('src') ?? iconEl?.getAttribute('data-src') ?? ''
    thumbnailUrl = resolveUrl(thumbnailUrl, BEAMNG_BASE)

    // Author — either from span.author inside tagLine or from a.username in .details
    let author = ''
    const authorSpan = el.querySelector('span.author')
    if (authorSpan) {
      author = authorSpan.text.replace(/^[\s\-–by]+/i, '').trim()
    } else {
      const authorEl = el.querySelector('a.username') ?? el.querySelector('.details a')
      author = authorEl?.text.trim() ?? ''
    }

    // TagLine — text of div.tagLine minus the " - by AUTHOR" suffix
    const tagLineEl = el.querySelector('div.tagLine') ?? el.querySelector('.tagLine')
    let tagLine = ''
    if (tagLineEl) {
      tagLine = tagLineEl.text
        .replace(/\s*[-–]\s*by\s+.+$/i, '')   // strip " - by AUTHOR" suffix
        .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
        .trim()
    }

    // Last update timestamp — from span.DateTime title attribute
    const dateEl = el.querySelector('span.DateTime') ?? el.querySelector('time')
    let lastUpdate = 0
    if (dateEl) {
      const titleAttr = dateEl.getAttribute('title')
      const datetime  = dateEl.getAttribute('datetime')
      lastUpdate = titleAttr ? parseDateTitle(titleAttr) : (datetime ? Math.floor(new Date(datetime).getTime() / 1000) : 0)
    }

    // Build full URLs
    const hrefFull    = href.startsWith('http') ? href : `${BEAMNG_BASE}/${href.replace(/^\//, '')}`
    const resourceUrl = hrefFull.replace(/\/$/, '') + '/'
    // BeamNG mods require the in-game launcher (beamng: protocol) — no direct zip download
    const downloadUrl = ''

    return {
      id,
      source:        'beamng',
      title,
      author,
      version:       '',
      downloadCount: 0,
      viewCount:     0,
      rating:        0,
      ratingCount:   0,
      categoryId,
      categoryTitle: CAT_ID_TO_LABEL[categoryId] ?? '',
      description:   tagLine,
      tagLine,
      thumbnailUrl,
      downloadUrl,
      resourceUrl,
      lastUpdate,
      postedDate:    lastUpdate,
      requiresLogin: true,
    }
  } catch (err) {
    return null
  }
}

async function scrapeBeamNGCategory(catSlug, catId, maxPages = 80) {
  const mods = []
  let page   = 1
  let totalPages = 9999

  while (page <= totalPages && page <= maxPages) {
    const url = `${BEAMNG_BASE}/resources/categories/${catSlug}/?page=${page}`
    console.log(`  [BeamNG/${catSlug}] page ${page}`)

    try {
      const { html, status } = await fetchHtml(url)
      if (status === 404) break
      if (status >= 400) { console.warn(`    HTTP ${status}`); break }

      const root = parseHtml(html)

      // Collect items: li.visible (main list) and li.featuredResource
      const itemEls = [
        ...root.querySelectorAll('li.visible'),
        ...root.querySelectorAll('li.featuredResource'),
      ]

      // Parse items, avoiding duplicates within this page
      const seen = new Set(mods.map(m => m.id))
      let added = 0
      for (const el of itemEls) {
        const r = parseBeamNGItem(el, catId)
        if (r && r.id > 0 && !seen.has(r.id)) {
          seen.add(r.id)
          mods.push(r)
          added++
        }
      }

      // Detect total pages from pagination
      // Pages appear as links like href="...?page=85" or as nav items
      const pageLinks = html.match(/page=(\d+)/g) ?? []
      const maxPage = pageLinks.reduce((m, p) => {
        const n = parseInt(p.split('=')[1], 10)
        return n > m ? n : m
      }, 1)
      if (maxPage > 1) totalPages = maxPage

      console.log(`    ${added} new mods (total: ${mods.length}, pages: ${totalPages})`)
      if (added === 0 && page > 1) break  // no new mods = done

      page++
      if (page <= Math.min(totalPages, maxPages)) await delay(DELAY_MS)
    } catch (err) {
      console.error(`    Error: ${err.message}`)
      break
    }
  }

  return mods
}

async function scrapeBeamNG() {
  console.log('\n=== Scraping BeamNG.com ===')

  const allMods  = new Map()  // id → mod (dedup across categories)
  const MAX_PAGES_PER_CAT = 60  // 60 × 5 items = 300 per category max

  for (const cat of BEAMNG_CATEGORIES) {
    try {
      const mods = await scrapeBeamNGCategory(cat.urlSlug, cat.id, MAX_PAGES_PER_CAT)
      let newCount = 0
      for (const m of mods) {
        if (!allMods.has(m.id)) {
          allMods.set(m.id, m)
          newCount++
        }
      }
      console.log(`[BeamNG] ${cat.label}: ${newCount} new (running total: ${allMods.size})`)
    } catch (err) {
      console.error(`[BeamNG] Error scraping ${cat.label}: ${err.message}`)
    }
    await delay(DELAY_MS * 2)
  }

  const result = [...allMods.values()]
  console.log(`\n[BeamNG] Grand total: ${result.length} unique mods`)
  return result
}

// ═══════════════════════════════════════════════════════════════════════════
//  Modland (beamng-mods.net) Scraper
// ═══════════════════════════════════════════════════════════════════════════

const MODLAND_BASE = 'https://www.modhub.us'

/**
 * Build URL for modhub.us BeamNG category page
 * Pagination: /category/beamng-drive-mods/page/N/
 */
function buildModlandUrl(page) {
  return page > 1
    ? `${MODLAND_BASE}/category/beamng-drive-mods/page/${page}/`
    : `${MODLAND_BASE}/category/beamng-drive-mods/`
}

/**
 * Parse a single mod block from modhub.us
 *
 * Actual HTML structure:
 * <div class="small-block" style="background-image: url('/uploads/images/.../thumb_slug.webp')">
 *   <div class="darkerer"></div>
 *   <h4 class="top-download-col-img-text">
 *     <a href="/beamng-drive-mods/ford-mustang-shelby-gt500-v10-038x">Ford Mustang Shelby GT500 v1.0</a>
 *   </h4>
 *   <div class="bottom-line row">...</div>
 * </div>
 */
function parseModlandItem(el, idCounter) {
  try {
    const titleEl = el.querySelector('h4.top-download-col-img-text a') ?? el.querySelector('h4 a') ?? el.querySelector('a[href*="/beamng-drive-mods/"]')
    if (!titleEl) return null

    const title = titleEl.text.trim()
    const href  = titleEl.getAttribute('href') ?? ''
    if (!title || !href) return null

    const resourceUrl = href.startsWith('http') ? href : `${MODLAND_BASE}${href}`

    // Stable integer ID from URL slug
    const slugMatch = href.match(/\/([^/]+)\/?$/)
    const slug      = slugMatch ? slugMatch[1] : String(idCounter)
    const slugHash  = Math.abs(Array.from(slug).reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0) | 0, 0)) + 1_000_000

    // Thumbnail from background-image in style attribute
    let thumbnailUrl = ''
    const style = el.getAttribute('style') ?? ''
    const bgMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/)
    if (bgMatch) {
      thumbnailUrl = bgMatch[1].startsWith('http') ? bgMatch[1] : `${MODLAND_BASE}${bgMatch[1]}`
    }

    return {
      id: slugHash, source: 'modland', title, author: 'modhub.us', version: '',
      downloadCount: 0, viewCount: 0, rating: 0, ratingCount: 0,
      categoryId: 0, categoryTitle: '',
      description: '', tagLine: '',
      thumbnailUrl, downloadUrl: '', resourceUrl,
      lastUpdate: 0, postedDate: 0,
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
  const itemEls = root.querySelectorAll('div.small-block')

  const items = []
  let counter = page * 10000
  for (const el of itemEls) {
    const r = parseModlandItem(el, counter++)
    if (r) items.push(r)
  }

  // Check if there's a next page link
  const hasMore = html.includes(`/page/${page + 1}/`) && items.length > 0

  console.log(`  [Modland] page ${page}: ${items.length} items, hasMore=${hasMore}`)
  return { items, hasMore }
}

async function scrapeModland() {
  console.log('\n=== Scraping modhub.us (BeamNG mods) ===')
  const allMods = []
  let page      = 1
  const MAX_PAGES = 60  // 60 × 24 = ~1440 mods

  while (page <= MAX_PAGES) {
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

  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('page-') && f.endsWith('.json')) {
      fs.unlinkSync(path.join(dir, f))
    }
  }

  const totalPages = Math.ceil(mods.length / PAGE_SIZE) || 1
  for (let i = 0; i < totalPages; i++) {
    const page  = i + 1
    const chunk = mods.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
    fs.writeFileSync(path.join(dir, `page-${page}.json`), JSON.stringify(chunk, null, 2))
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
