/**
 * Split text into overlapping chunks along natural boundaries
 * (blank lines → sentences → words). Headings stay attached to their paragraph,
 * so every chunk keeps its context.
 */

export interface ChunkOptions {
  size: number;
  overlap: number;
}

export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/-\n(?=[a-z])/g, '') // de-hyphenate PDF line breaks
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentences(p: string): string[] {
  return p.match(/[^.!?\n]+(?:[.!?]+["')\]]?|\n|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];
}

export function chunkText(input: string, { size, overlap }: ChunkOptions): string[] {
  const text = cleanText(input);
  if (!text) return [];
  if (text.length <= size) return [text];

  // Units: paragraphs, further split into sentences when a paragraph is too long.
  const units: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) units.push(p);
    else {
      for (const s of splitSentences(p)) {
        if (s.length <= size) units.push(s);
        else for (let i = 0; i < s.length; i += size - overlap) units.push(s.slice(i, i + size));
      }
    }
  }

  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > size) {
      chunks.push(cur.trim());
      // Carry the tail of the previous chunk for overlap, starting at a word boundary.
      const tail = overlap > 0 ? cur.slice(-overlap) : '';
      const sp = tail.indexOf(' ');
      cur = (sp >= 0 ? tail.slice(sp + 1) : tail) + (tail ? ' ' : '') + u;
    } else {
      cur = cur ? `${cur}\n${u}` : u;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
