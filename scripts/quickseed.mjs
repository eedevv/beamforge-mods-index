/**
 * Quick seed: scrape 3 pages each from BeamNG (vehicles, maps) + modhub.us
 * to populate the index with real data for initial deployment.
 * Run: node scripts/quickseed.mjs
 */
import https from 'node:https'
import http  from 'node:http'
import fs    from 'node:fs'
import path  from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseHtml } from 'node-html-parser'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.resolve(__dirname, '..')
const DELAY_MS   = 1300
const PAGE_SIZE  = 50
const BEAMNG_BASE = 'https://www.beamng.com'
const MODLAND_BASE = 'https://www.modhub.us'

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
}

function fetchHtml(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Too many redirects'))
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers: HEADERS, timeout: 25000 },
      res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const next = res.headers.location.startsWith('http') ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseDateTitle(t) {
  try { return Math.floor(new Date(t.replace(' at ', ' ')).getTime() / 1000) } catch { return 0 }
}

const CAT_LABELS = { 2: 'Vehicles', 9: 'Maps', 8: 'Scenarios', 7: 'Mods of Mods', 12: 'Skins' }
const CATS = [
  { id: 2, label: 'Vehicles',     slug: 'vehicles.2' },
  { id: 9, label: 'Maps',         slug: 'terrains-levels-maps.9' },
  { id: 8, label: 'Scenarios',    slug: 'scenarios.8' },
  { id: 7, label: 'Mods of Mods', slug: 'mods-of-mods.7' },
  { id: 12, label: 'Skins',       slug: 'skins.12' },
]

function parseBeamItem(el, categoryId) {
  try {
    const titleEl = el.querySelector('a.resourceTitle')
      ?? el.querySelector('.resourceInfo h3.title a')
      ?? el.querySelector('h3.title a')
    if (!titleEl) return null
    const href = titleEl.getAttribute('href') ?? ''
    const idMatch = href.match(/\.(\d+)\/?$/) ?? href.match(/\.(\d+)/)
    if (!idMatch) return null
    const id    = parseInt(idMatch[1], 10)
    const title = titleEl.text.trim().replace(/^\[[\w\s]+\]\s*/, '')
    if (!title || id <= 0) return null

    const iconEl = el.querySelector('a.resourceIcon img') ?? el.querySelector('.resourceImage img')
    let thumbSrc = iconEl?.getAttribute('src') ?? ''
    const thumbnailUrl = thumbSrc
      ? (thumbSrc.startsWith('http') ? thumbSrc : `${BEAMNG_BASE}/${thumbSrc.replace(/^\//, '')}`)
      : ''

    const authorSpan = el.querySelector('span.author')
    const author = authorSpan
      ? authorSpan.text.replace(/^[\s\-–by]+/i, '').trim()
      : (el.querySelector('a.username')?.text.trim() ?? 'Unknown')

    const tagLineEl = el.querySelector('div.tagLine') ?? el.querySelector('.tagLine')
    const tagLine = tagLineEl
      ? tagLineEl.text.replace(/\s*[-–]\s*by\s+.+$/i, '').trim()
      : ''

    const dateEl   = el.querySelector('span.DateTime') ?? el.querySelector('time')
    const lastUpdate = dateEl ? parseDateTitle(dateEl.getAttribute('title') ?? '') : 0

    const resourceUrl = `${BEAMNG_BASE}/${href.replace(/^\//, '')}`
    return {
      id, source: 'beamng', title, author: author || 'Unknown', version: '',
      downloadCount: 0, viewCount: 0, rating: 0, ratingCount: 0,
      categoryId, categoryTitle: CAT_LABELS[categoryId] ?? '',
      description: tagLine, tagLine, thumbnailUrl,
      downloadUrl: '', resourceUrl, lastUpdate, postedDate: lastUpdate,
      requiresLogin: true,
    }
  } catch { return null }
}

// ── Scrape BeamNG categories ──
console.log('\n=== BeamNG ===')
const allBeamng = new Map()
for (const cat of CATS) {
  for (let pg = 1; pg <= 4; pg++) {
    const url = `${BEAMNG_BASE}/resources/categories/${cat.slug}/?page=${pg}`
    try {
      const { html, status } = await fetchHtml(url)
      if (status >= 400) break
      const root = parseHtml(html)
      const els  = [...root.querySelectorAll('li.visible'), ...root.querySelectorAll('li.featuredResource')]
      let added  = 0
      for (const el of els) {
        const r = parseBeamItem(el, cat.id)
        if (r && !allBeamng.has(r.id)) { allBeamng.set(r.id, r); added++ }
      }
      console.log(`  [${cat.label}] pg${pg}: +${added} (total ${allBeamng.size})`)
    } catch (e) {
      console.error(`  [${cat.label}] pg${pg} error: ${e.message}`)
    }
    if (pg < 4) await sleep(DELAY_MS)
  }
  await sleep(DELAY_MS)
}

// ── Scrape modhub.us ──
console.log('\n=== modhub.us ===')
const allModland = []
for (let pg = 1; pg <= 4; pg++) {
  const url = pg > 1
    ? `${MODLAND_BASE}/category/beamng-drive-mods/page/${pg}/`
    : `${MODLAND_BASE}/category/beamng-drive-mods/`
  try {
    const { html, status } = await fetchHtml(url)
    if (status >= 400) break
    const root = parseHtml(html)
    const els  = root.querySelectorAll('div.small-block')
    let added  = 0
    for (const el of els) {
      const titleEl = el.querySelector('h4.top-download-col-img-text a') ?? el.querySelector('h4 a')
      if (!titleEl) continue
      const title = titleEl.text.trim()
      const href  = titleEl.getAttribute('href') ?? ''
      if (!title || !href) continue
      const resourceUrl = href.startsWith('http') ? href : `${MODLAND_BASE}${href}`
      const slug    = (href.match(/\/([^/]+)\/?$/) ?? [])[1] ?? `${pg}_${added}`
      const slugHash = Math.abs(Array.from(slug).reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0) | 0, 0)) + 1_000_000
      const style   = el.getAttribute('style') ?? ''
      const bgMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/)
      const thumbnailUrl = bgMatch
        ? (bgMatch[1].startsWith('http') ? bgMatch[1] : `${MODLAND_BASE}${bgMatch[1]}`)
        : ''
      allModland.push({
        id: slugHash, source: 'modland', title, author: 'modhub.us', version: '',
        downloadCount: 0, viewCount: 0, rating: 0, ratingCount: 0,
        categoryId: 0, categoryTitle: '', description: '', tagLine: '',
        thumbnailUrl, downloadUrl: '', resourceUrl,
        lastUpdate: 0, postedDate: 0, requiresLogin: false,
      })
      added++
    }
    console.log(`  pg${pg}: +${added} (total ${allModland.length})`)
  } catch (e) {
    console.error(`  pg${pg} error: ${e.message}`)
  }
  if (pg < 4) await sleep(DELAY_MS)
}

// ── Write output ──
function writePages(source, mods) {
  const dir = path.join(OUTPUT_DIR, source)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('page-') && f.endsWith('.json')) fs.unlinkSync(path.join(dir, f))
  }
  const totalPages = Math.ceil(mods.length / PAGE_SIZE) || 1
  for (let i = 0; i < totalPages; i++) {
    const chunk = mods.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
    fs.writeFileSync(path.join(dir, `page-${i + 1}.json`), JSON.stringify(chunk, null, 2))
  }
  console.log(`  ${source}: ${mods.length} mods → ${totalPages} pages`)
  return totalPages
}

const beamngMods  = [...allBeamng.values()]
const modlandMods = allModland

console.log('\n=== Writing output ===')
const bp = writePages('beamng',  beamngMods)
const mp = writePages('modland', modlandMods)

const index = {
  version:   1,
  updatedAt: Math.floor(Date.now() / 1000),
  sources: {
    beamng:  { totalMods: beamngMods.length,  totalPages: bp, pageSize: PAGE_SIZE },
    modland: { totalMods: modlandMods.length, totalPages: mp, pageSize: PAGE_SIZE },
  }
}
fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 2))
console.log('\nDone! BeamNG:', beamngMods.length, '| Modland:', modlandMods.length)
