// Usage: node test/parse-test.mjs path/to/log.pdf
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { groupItems, parseLog, CATEGORIES } from '../src/parse.js';

const file = process.argv[2];
if (!file) {
  console.error('Pass a police log PDF path.');
  process.exit(1);
}

const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const tc = await (await doc.getPage(i)).getTextContent();
  pages.push(groupItems(tc.items));
}
const { calls, meta } = parseLog(pages);

console.log('pages', doc.numPages, 'meta', meta);
console.log('calls', calls.length, 'with location', calls.filter((c) => c.loc).length);
const byCat = {};
for (const c of calls) byCat[c.cat] = (byCat[c.cat] || 0) + 1;
console.log('by category', byCat);
console.log('dates', [...new Set(calls.map((c) => c.date))].join(', '));

// Privacy check: nothing stored should look like a person's name or a summons field.
const blob = JSON.stringify(calls);
const leaks = [/Patrolman|Sergeant|Officer|Telephone Operator/i, /Summons|Charges|Age:/i, /\bApt\b/i].filter((re) => re.test(blob));
console.log('privacy leaks found:', leaks.length ? leaks.map(String) : 'none');

console.log('\nsample (priority calls):');
for (const c of calls.filter((c) => c.cat !== 'other').slice(0, 12)) {
  console.log(`${c.date} ${c.time}  [${CATEGORIES[c.cat]}${c.injury ? ', injury' : ''}]  ${c.reason}  |  ${c.action}  |  ${c.loc?.display ?? '(no location)'}  ->  ${c.loc?.geo ?? ''}`);
}
console.log('\nunclassified reasons:', [...new Set(calls.filter((c) => c.cat === 'other').map((c) => c.reason))].join(' ; '));
