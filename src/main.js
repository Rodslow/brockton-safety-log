import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { parseLog, CATEGORIES } from './parse.js';
import { readPdfPages } from './pdftext.js';

const GEOCODER = 'https://nominatim.openstreetmap.org/search';
// Rough box around Brockton, MA, so a street name never matches a different town.
const VIEWBOX = '-71.11,42.13,-70.95,42.02';
const MAX_GEOCODE = 60;
const KEEP_DAYS = 120;
const COLORS = { weapons: '#c0392b', violence: '#c0392b', fire: '#c46a12', crash: '#0b5cad', other: '#6b7280' };
const PRIORITY = new Set(['weapons', 'violence', 'fire', 'crash']);

const $ = (id) => document.getElementById(id);
const els = {
  import: $('import'),
  file: $('file'),
  days: $('days'),
  cat: $('cat'),
  q: $('q'),
  clear: $('clear'),
  status: $('status'),
  banner: $('banner'),
  feed: $('feed'),
};
const setStatus = (t) => (els.status.textContent = t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage (best effort) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    setStatus('Could not save data in this browser; it will be lost when you close the page.');
  }
}

let calls = load('bk:calls', []);
let meta = load('bk:meta', {});
let auto = false; // true when data comes from the automatically updated data file
let updatedAt = null;

// The site rebuilds data/calls.json automatically; use it when it exists.
async function loadPublished() {
  try {
    const res = await fetch('./data/calls.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.calls || !data.calls.length) return;
    calls = data.calls;
    meta = data.meta || {};
    updatedAt = data.updated || null;
    auto = true;
    for (const id of ['getlog', 'import', 'clear']) $(id).hidden = true;
    $('lag').textContent =
      'Built from the Brockton Police dispatch log (calls for service, not confirmed crimes). ' +
      'This page updates itself when the department posts new logs, usually every week or two. ' +
      'Names are never kept, and locations are shown by block.';
  } catch {
    /* no published data: fall back to manual import */
  }
}

// ---------- map ----------
const map = L.map('map').setView([42.0834, -71.0184], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const markers = L.layerGroup().addTo(map);
const markerByGeo = new Map();

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
function fmtTime(hhmm) {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const mm = hhmm.slice(2);
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h >= 12 ? 'PM' : 'AM'}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------- importing ----------
async function importFiles(files) {
  let added = 0;
  const known = new Map(calls.map((c) => [c.id, c]));
  for (const file of files) {
    try {
      setStatus(`Reading ${file.name}…`);
      const pages = await readPdfPages(file, (i, n) => setStatus(`Reading ${file.name}: page ${i} of ${n}`));
      const parsed = parseLog(pages);
      if (!parsed.calls.length) {
        setStatus(`${file.name}: no police log entries found. Is this a Brockton dispatch log?`);
        continue;
      }
      for (const c of parsed.calls) {
        if (!known.has(c.id)) added++;
        known.set(c.id, c);
      }
      if (parsed.meta.thru && (!meta.thru || parsed.meta.thru > meta.thru)) meta = parsed.meta;
    } catch (err) {
      setStatus(`Could not read ${file.name}: ${err.message || err}`);
      return;
    }
  }
  const newest = [...known.values()].reduce((m, c) => (c.date > m ? c.date : m), '0000-00-00');
  const cutoff = addDays(newest, -KEEP_DAYS);
  calls = [...known.values()].filter((c) => c.date >= cutoff);
  save('bk:calls', calls);
  save('bk:meta', meta);
  setStatus(`Imported ${added} new calls.`);
  refresh();
}

els.import.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', async () => {
  const files = [...els.file.files];
  els.file.value = '';
  if (files.length) await importFiles(files);
});
els.clear.addEventListener('click', () => {
  if (!calls.length) return;
  calls = [];
  meta = {};
  save('bk:calls', calls);
  save('bk:meta', meta);
  refresh();
  setStatus('Imported data cleared.');
});

// ---------- filtering ----------
function newestDate() {
  return calls.reduce((m, c) => (c.date > m ? c.date : m), '0000-00-00');
}

function filtered() {
  const days = Number(els.days.value);
  const cat = els.cat.value;
  const q = els.q.value.trim().toLowerCase();
  const cutoff = days ? addDays(newestDate(), -(days - 1)) : '0000-00-00';
  return calls
    .filter((c) => c.date >= cutoff)
    .filter((c) => (cat === 'all' ? true : cat === 'priority' ? PRIORITY.has(c.cat) : c.cat === cat))
    .filter((c) => !q || `${c.reason} ${c.action} ${c.loc?.display ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
}

// ---------- rendering ----------
let runToken = 0;

function renderFeed(rows) {
  els.feed.replaceChildren();
  if (!calls.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No data yet. Download the newest log PDF from the Brockton Police log page, then tap "Add downloaded PDF".';
    els.feed.append(li);
    return;
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No calls match these filters.';
    els.feed.append(li);
    return;
  }
  for (const c of rows.slice(0, 300)) {
    const li = document.createElement('li');
    li.classList.add(c.cat);
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = c.reason + (c.injury ? ' (injury)' : '');
    if (c.cat !== 'other') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = CATEGORIES[c.cat];
      t.append(tag);
    }
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = `${fmtDate(c.date)} ${fmtTime(c.time)} · ${c.loc?.display ?? 'Location not listed'}${c.action ? ' · ' + c.action : ''}`;
    li.append(t, m);
    li.addEventListener('click', () => {
      const mk = c.loc && markerByGeo.get(c.loc.geo);
      if (mk) {
        map.setView(mk.getLatLng(), 16);
        mk.openPopup();
      }
    });
    els.feed.append(li);
  }
}

function renderBanner() {
  if (!calls.length) {
    els.banner.hidden = true;
    return;
  }
  const newest = newestDate();
  const printed = meta.printed ? ` Latest log printed ${fmtDate(meta.printed)}.` : '';
  const checked = auto && updatedAt ? ` Data last refreshed ${new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : '';
  els.banner.textContent = `Data runs through ${fmtDate(newest)}.${printed}${checked} Periods count back from that date, not from today.`;
  els.banner.hidden = false;
}

// ---------- geocoding (best effort, cached, rate limited) ----------
function cacheGet(key) {
  try {
    return JSON.parse(localStorage.getItem(`geo:${key}`));
  } catch {
    return null;
  }
}
function cacheSet(key, val) {
  try {
    localStorage.setItem(`geo:${key}`, JSON.stringify(val));
  } catch {
    /* storage full or blocked; skip caching */
  }
}

async function geocode(query) {
  const cached = cacheGet(query);
  if (cached !== null) return { pt: cached.miss ? null : cached, fromCache: true };
  const url = new URL(GEOCODER);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  url.searchParams.set('viewbox', VIEWBOX);
  url.searchParams.set('bounded', '1');
  url.searchParams.set('q', query);
  try {
    const res = await fetch(url);
    if (!res.ok) return { pt: null, fromCache: false };
    const hit = (await res.json())[0];
    const pt = hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
    cacheSet(query, pt || { miss: true });
    return { pt, fromCache: false };
  } catch {
    return { pt: null, fromCache: false };
  }
}

async function plot(rows, token) {
  markers.clearLayers();
  markerByGeo.clear();
  const byGeo = new Map();
  for (const c of rows) {
    if (!c.loc) continue;
    if (!byGeo.has(c.loc.geo)) byGeo.set(c.loc.geo, []);
    byGeo.get(c.loc.geo).push(c);
  }
  // Automatic data already has coordinates; manual imports are looked up here.
  const all = [...byGeo.entries()];
  const places = auto ? all.filter(([, list]) => list.some((c) => c.pt)) : all.slice(0, MAX_GEOCODE);
  const bounds = [];
  let done = 0;
  for (const [geo, list] of places) {
    if (token !== runToken) return;
    const known = list.find((c) => c.pt)?.pt;
    const { pt, fromCache } = known ? { pt: { lat: known[0], lng: known[1] }, fromCache: true } : await geocode(geo);
    done++;
    if (pt) {
      const top = list.find((c) => c.cat === 'weapons' || c.cat === 'violence') || list.find((c) => c.cat !== 'other') || list[0];
      const mk = L.circleMarker([pt.lat, pt.lng], {
        radius: 6 + Math.min(list.length, 6),
        color: COLORS[top.cat],
        fillOpacity: 0.55,
        weight: 2,
      }).addTo(markers);
      mk.bindPopup(
        `<strong>${esc(list[0].loc.display)}</strong><br>` +
          list
            .slice(0, 6)
            .map((c) => `${esc(fmtDate(c.date))} ${esc(fmtTime(c.time))}: ${esc(c.reason)}`)
            .join('<br>') +
          (list.length > 6 ? `<br>+${list.length - 6} more` : '')
      );
      markerByGeo.set(geo, mk);
      bounds.push([pt.lat, pt.lng]);
      if (bounds.length === 1 || bounds.length % 10 === 0) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
    setStatus(`${rows.length} calls · mapping locations ${done}/${places.length}`);
    if (!fromCache) await sleep(1100); // the free geocoder allows about 1 request per second
  }
  if (token === runToken) {
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    const skipped = auto ? 0 : byGeo.size - places.length;
    setStatus(
      `${rows.length} calls · ${bounds.length} locations mapped` +
        (skipped > 0 ? ` (newest ${MAX_GEOCODE} places; ${skipped} more in the list)` : '')
    );
  }
}

function refresh() {
  const token = ++runToken;
  const rows = filtered();
  renderBanner();
  renderFeed(rows);
  markers.clearLayers();
  markerByGeo.clear();
  if (!rows.length) {
    if (calls.length) setStatus('No calls match these filters.');
    return;
  }
  plot(rows, token);
}

let typing = null;
els.q.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(refresh, 350);
});
for (const el of [els.days, els.cat]) el.addEventListener('change', refresh);

refresh();
loadPublished().then(() => {
  if (auto) refresh();
});
