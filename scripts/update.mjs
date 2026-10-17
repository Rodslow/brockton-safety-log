// Fetches new Brockton Police dispatch-log PDFs, parses them, finds map
// locations, and writes public/data/calls.json for the app to load.
//
// Run:   node scripts/update.mjs
// Test:  LOCAL_PDF_DIR=./some/folder SKIP_FETCH=1 node scripts/update.mjs
//
// Only call type, time, action, and a block-level location are published.
// Names and arrest/summons details are discarded by src/parse.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { groupItems, parseLog } from '../src/parse.js';

const BASE = process.env.LOG_BASE || 'https://www.brocktonpolice.com';
const INDEX_PATH = '/category/police-log/';
const OUT = process.env.OUT_FILE || 'public/data/calls.json';
const STATE = process.env.STATE_FILE || 'data/state.json';
const GEOCODER = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
const VIEWBOX = '-71.11,42.13,-70.95,42.02'; // rough box around Brockton, MA
const INDEX_PAGES = Number(process.env.INDEX_PAGES || 3);
const MAX_NEW_GEOCODES = Number(process.env.MAX_NEW_GEOCODES || 300);
const GEOCODE_DELAY_MS = Number(process.env.GEOCODE_DELAY_MS || 1100);
const KEEP_DAYS = 120;
const UA = `brockton-safety-log (https://github.com/${process.env.GITHUB_REPOSITORY || 'local-test'})`;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value) + '\n');
}

// ---------- discovery ----------
export function extractLinks(html, base = BASE) {
  const out = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      out.add(new URL(m[1].replace(/&#0?38;|&amp;/g, '&'), base).href);
    } catch {
      /* ignore malformed links */
    }
  }
  return [...out];
}
export const pdfLinks = (links) => links.filter((l) => /\.pdf(\?|$)/i.test(l));
export function postLinks(links, base = BASE) {
  const host = new URL(base).host;
  const re = new RegExp(`/(${MONTHS})[a-z0-9-]*/?$`, 'i');
  return links.filter((l) => {
    try {
      const u = new URL(l);
      return u.host === host && re.test(u.pathname) && !/\/category\//.test(u.pathname);
    } catch {
      return false;
    }
  });
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function discoverPdfs(state) {
  const pdfs = new Set();
  const posts = new Set();
  for (let page = 1; page <= INDEX_PAGES; page++) {
    const url = BASE + INDEX_PATH + (page > 1 ? `page/${page}/` : '');
    let html;
    try {
      html = await getText(url);
    } catch (err) {
      if (page === 1) throw err; // the main page must work
      break; // later pages may simply not exist
    }
    const links = extractLinks(html);
    pdfLinks(links).forEach((l) => pdfs.add(l));
    postLinks(links).forEach((l) => posts.add(l));
  }
  // Posts whose PDF link was not on the index page: open the post.
  for (const post of posts) {
    if (state.posts[post]?.length) {
      state.posts[post].forEach((p) => pdfs.add(p));
      continue;
    }
    try {
      const found = pdfLinks(extractLinks(await getText(post), post));
      state.posts[post] = found;
      found.forEach((p) => pdfs.add(p));
    } catch (err) {
      console.warn(`Skipping post ${post}: ${err.message}`);
    }
  }
  return [...pdfs];
}

// ---------- PDF reading ----------
async function pagesFromBuffer(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(groupItems((await page.getTextContent()).items));
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

// ---------- geocoding ----------
async function geocode(query) {
  const url = new URL(GEOCODER);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('viewbox', VIEWBOX);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('q', query);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 429 || res.status === 403) return { blocked: true };
  if (!res.ok) return { error: true };
  const hit = (await res.json())[0];
  return { pt: hit ? [Number(Number(hit.lat).toFixed(5)), Number(Number(hit.lon).toFixed(5))] : null };
}

async function fillCoordinates(calls, state) {
  const wanted = calls
    .filter((c) => c.cat !== 'other' && c.loc)
    .sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)); // newest first
  let lookups = 0;
  let stop = false;
  for (const c of wanted) {
    const key = c.loc.geo;
    if (key in state.geo) {
      if (state.geo[key]) c.pt = state.geo[key];
      continue;
    }
    if (stop || lookups >= MAX_NEW_GEOCODES) continue;
    lookups++;
    try {
      const r = await geocode(key);
      if (r.blocked) {
        console.warn('Geocoder asked us to slow down; stopping lookups for this run.');
        stop = true;
      } else if (!r.error) {
        state.geo[key] = r.pt;
        if (r.pt) c.pt = r.pt;
      }
    } catch (err) {
      console.warn(`Geocode failed for one place: ${err.message}`);
    }
    await sleep(GEOCODE_DELAY_MS);
  }
  return lookups;
}

// ---------- main ----------
export async function main() {
  const state = await readJson(STATE, {});
  state.pdfs ||= {};
  state.posts ||= {};
  state.geo ||= {};

  const existing = await readJson(OUT, { calls: [], meta: {} });
  const byId = new Map(existing.calls.map((c) => [c.id, c]));
  let meta = existing.meta || {};
  let newPdfs = 0;

  const jobs = []; // {key, size, load: () => Promise<Buffer>}
  if (process.env.LOCAL_PDF_DIR) {
    for (const f of await fs.readdir(process.env.LOCAL_PDF_DIR)) {
      if (!/\.pdf$/i.test(f)) continue;
      const file = path.join(process.env.LOCAL_PDF_DIR, f);
      const size = (await fs.stat(file)).size;
      jobs.push({ key: pathToFileURL(file).href, size, load: () => fs.readFile(file) });
    }
  } else {
    for (const url of await discoverPdfs(state)) {
      let size = null;
      try {
        const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
        size = Number(head.headers.get('content-length')) || null;
      } catch {
        /* fall through: treat as changed */
      }
      jobs.push({
        key: url,
        size,
        load: async () => {
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          if (!res.ok) throw new Error(`${url} returned ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        },
      });
    }
  }

  for (const job of jobs) {
    const seen = state.pdfs[job.key];
    if (seen && seen.size === job.size && job.size !== null) continue;
    try {
      const parsed = parseLog(await pagesFromBuffer(await job.load()));
      if (!parsed.calls.length) {
        console.warn(`No log entries found in ${job.key}; skipping.`);
        continue;
      }
      for (const c of parsed.calls) byId.set(c.id, { ...(byId.get(c.id) || {}), ...c });
      if (parsed.meta.thru && (!meta.thru || parsed.meta.thru > meta.thru)) meta = parsed.meta;
      state.pdfs[job.key] = { size: job.size, calls: parsed.calls.length };
      newPdfs++;
      console.log(`Processed ${job.key}: ${parsed.calls.length} calls`);
    } catch (err) {
      console.warn(`Could not process ${job.key}: ${err.message}`);
    }
  }

  let calls = [...byId.values()];
  const newest = calls.reduce((m, c) => (c.date > m ? c.date : m), '0000-00-00');
  if (newest !== '0000-00-00') {
    const d = new Date(newest + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - KEEP_DAYS);
    const cutoff = d.toISOString().slice(0, 10);
    calls = calls.filter((c) => c.date >= cutoff);
  }

  const lookups = await fillCoordinates(calls, state);
  calls.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));

  const changed = newPdfs > 0 || lookups > 0;
  const out = changed || !existing.updated ? { updated: new Date().toISOString(), meta, calls } : { ...existing, meta, calls };
  await writeJson(OUT, out);
  await writeJson(STATE, state);
  console.log(`Done: ${calls.length} calls, ${newPdfs} new PDFs, ${lookups} new place lookups.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
