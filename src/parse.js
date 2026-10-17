// Parser for the Brockton Police "Dispatch Log" PDFs.
// Works on text lines only, so it can be tested without a browser.
//
// Privacy: only call number, date, time, call reason, action, and a block-level
// location are kept. Officer names, suspect names, ages, and summons/arrest
// details are never stored.

/**
 * Turn pdf.js text items from one page into an array of line strings.
 * Items on the same baseline are joined left to right; a wide gap becomes a tab
 * so table columns can be split apart later.
 */
export function groupItems(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 2);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y grows upward, so top of page first
    .map(([, cells]) => {
      cells.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const c of cells) {
        if (prevEnd !== null) {
          const gap = c.x - prevEnd;
          // In these PDFs a word space is about 5pt; table columns are 18pt or more apart.
          line += gap > 10 ? '\t' : gap > 0.8 ? ' ' : '';
        }
        line += c.s;
        prevEnd = c.x + c.w;
      }
      return line;
    });
}

const HDR = /^(\d{2}-\d+)\s+(\d{4})\s+(.+)$/;
const DATE_LINE = /^For Date:\s*(\d{2})\/(\d{2})\/(\d{4})/;
const PRINTED = /Printed:\s*(\d{2})\/(\d{2})\/(\d{4})/;
const RANGE = /From:\s*(\d{2})\/(\d{2})\/(\d{4})\s+Thru:\s*(\d{2})\/(\d{2})\/(\d{4})/;

const iso = (m, d, y) => `${y}-${m}-${d}`;

/** Reduce a raw "Location/Address" value to a block-level location. */
export function normalizeLocation(raw) {
  if (!raw) return null;
  let s = raw
    .replace(/\[[^\]]*\]/g, ' ') // [BRO 3967] map code
    .replace(/\s+(APT|UNIT|SUITE|STE|FL|#).*$/i, '') // apartment / unit details
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const [first, second = ''] = s.split(/\s*@\s*/);
  const m = first.match(/^(\d+)(?:-\d+)?\s+(.+)$/);
  const num = m ? parseInt(m[1], 10) : null;
  const street = (m ? m[2] : first).trim();
  const cross = second.replace(/^\d+(?:-\d+)?\s+/, '').trim();
  const blockStart = num === null ? null : Math.floor(num / 100) * 100;
  const display =
    (blockStart === null ? '' : `${blockStart} BLOCK `) + street + (cross ? ` @ ${cross}` : '');
  // Geocode at the middle of the block, never at the exact house number.
  const geo =
    blockStart === null ? `${street}, Brockton, MA` : `${blockStart + 50} ${street}, Brockton, MA`;
  return { display, geo };
}

const RULES = [
  { cat: 'weapons', re: /\bGUN|SHOT|SHOOT|WEAPON|KNIFE|STAB|FIREARM/i },
  { cat: 'violence', re: /ASSAULT|ROBBERY|\bFIGHT|RAPE|KIDNAP|DOMESTIC|THREAT|STALK|SEXUAL|ABDUCT|HOMICIDE|MURDER/i },
  { cat: 'fire', re: /\bFIRE\b|SMOKE|EXPLOSION|GAS LEAK|CARBON MONOXIDE|\bCO ALARM/i, not: /TRANSFER|ALARM, FIRE FALSE/i },
  { cat: 'crash', re: /\bM\s?V\s?A\b|ACCIDENT|CRASH|HIT (AND|&) RUN|STRUCK/i },
];

export const CATEGORIES = {
  weapons: 'Shots / weapons',
  violence: 'Violence',
  fire: 'Fire',
  crash: 'Crash',
  other: 'Other',
};

export function classify(reason) {
  for (const r of RULES) {
    if (r.re.test(reason) && !(r.not && r.not.test(reason))) return r.cat;
  }
  return 'other';
}

/** True if a crash entry mentions an injury (the log writes "No PI" when none). */
export function hasInjury(reason) {
  return /\bPI\b|INJUR/i.test(reason) && !/\bNO PI\b|NO INJUR/i.test(reason);
}

/**
 * @param {string[][]} pages  lines for each page
 * @returns {{calls: object[], meta: {from?: string, thru?: string, printed?: string}}}
 */
export function parseLog(pages) {
  const calls = [];
  const meta = {};
  let date = null;
  let cur = null;

  for (const page of pages) {
    for (const raw of page) {
      const line = raw.replace(/\t+/g, '\t').trim();
      if (!line) continue;

      const r = line.match(RANGE);
      if (r) {
        meta.from = iso(r[1], r[2], r[3]);
        meta.thru = iso(r[4], r[5], r[6]);
      }
      const p = line.match(PRINTED);
      if (p) meta.printed = iso(p[1], p[2], p[3]);

      const d = line.match(DATE_LINE);
      if (d) {
        date = iso(d[1], d[2], d[3]);
        cur = null;
        continue;
      }

      const h = line.match(HDR);
      if (h && date) {
        const [reason = '', action = ''] = h[3].split(/\t+|\s{2,}/).map((x) => x.trim());
        cur = {
          id: h[1],
          date,
          time: h[2],
          reason,
          action,
          cat: classify(reason),
          injury: hasInjury(reason),
          loc: null,
        };
        calls.push(cur);
        continue;
      }

      // Only the call location is read. Summons blocks use a plain "Address:"
      // label (a suspect's home address), which is deliberately ignored.
      const loc = line.match(/^Location\/Address:\s*(.*)$/);
      if (loc && cur && !cur.loc) {
        cur.loc = normalizeLocation(loc[1].replace(/\t+/g, ' '));
      }
    }
  }
  return { calls, meta };
}
