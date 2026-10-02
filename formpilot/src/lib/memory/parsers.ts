/**
 * File → plain text. Runs in the options page (a Window context): pdf.js needs a
 * Worker, and the MV3 service worker can't spawn one. Heavy libraries are
 * imported lazily, so the options page loads instantly.
 */

import { createLogger } from '../logger';

const log = createLogger('parse');

export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown', '.json', '.csv', '.html', '.htm', '.rtf'];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function fileKind(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'markdown') return 'md';
  if (ext === 'htm') return 'html';
  return ext;
}

async function parsePdf(buf: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Text extraction needs no fonts or image decoders; skipping them avoids wasm/CSP issues in MV3.
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
  });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      } else if (item.str && !item.str.endsWith(' ')) line += ' ';
    }
    if (line) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
    page.cleanup();
  }
  await task.destroy();
  const text = pages.join('\n\n');
  if (text.replace(/\s/g, '').length < 20 && doc.numPages > 0) {
    throw new Error('This PDF has no extractable text (it is probably a scanned image). Paste the text as a note instead.');
  }
  return text;
}

async function parseDocx(buf: ArrayBuffer): Promise<string> {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const res = await mammoth.extractRawText({ arrayBuffer: buf });
  if (res.messages?.length) log.debug('mammoth messages', res.messages);
  return res.value;
}

function parseHtml(s: string): string {
  const doc = new DOMParser().parseFromString(s, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return doc.body?.innerText ?? doc.body?.textContent ?? '';
}

function parseRtf(s: string): string {
  return s
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\*?\\[^{}]+}|[{}]|\\\n?[A-Za-z]+\n?(?:-?\d+)?[ ]?/g, '')
    .trim();
}

export async function parseFile(file: File): Promise<{ text: string; kind: string }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const kind = fileKind(file.name);
  const end = log.time(`parse ${file.name}`);
  let text: string;
  switch (kind) {
    case 'pdf':
      text = await parsePdf(await file.arrayBuffer());
      break;
    case 'docx':
      text = await parseDocx(await file.arrayBuffer());
      break;
    case 'html':
      text = parseHtml(await file.text());
      break;
    case 'rtf':
      text = parseRtf(await file.text());
      break;
    case 'json': {
      const raw = await file.text();
      try {
        text = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        text = raw;
      }
      break;
    }
    case 'txt':
    case 'md':
    case 'csv':
      text = await file.text();
      break;
    default:
      throw new Error(`Unsupported file type ".${kind}". Use PDF, DOCX, TXT, MD, CSV, JSON or HTML.`);
  }
  end({ chars: text.length });
  if (!text.trim()) throw new Error('No text found in this file.');
  return { text, kind };
}
