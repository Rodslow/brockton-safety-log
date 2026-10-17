import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { groupItems } from './parse.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Read a PDF File and return its text as an array of pages, each an array of lines. */
export async function readPdfPages(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(groupItems(content.items));
    page.cleanup();
    if (onProgress) onProgress(i, doc.numPages);
  }
  await doc.destroy();
  return pages;
}
