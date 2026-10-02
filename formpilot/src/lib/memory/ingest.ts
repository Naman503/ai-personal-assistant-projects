/** Add / update / remove memory documents (used by the options page). */

import { db, bumpMemoryVersion, type MemoryDoc } from './db';
import { chunkText, cleanText } from './chunker';
import { uid } from '../util';

export async function addDocument(
  input: { name: string; type: string; text: string; size?: number; id?: string },
  opts: { chunkSize: number; chunkOverlap: number },
): Promise<MemoryDoc> {
  const text = cleanText(input.text);
  const now = Date.now();
  const doc: MemoryDoc = {
    id: input.id ?? uid('doc'),
    name: input.name,
    type: input.type,
    size: input.size ?? text.length,
    chars: text.length,
    text,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    factsStatus: 'pending',
  };
  const chunks = chunkText(text, { size: opts.chunkSize, overlap: opts.chunkOverlap }).map((t, idx) => ({
    id: `${doc.id}:${idx}`,
    docId: doc.id,
    idx,
    text: t,
  }));
  await db().transaction('rw', db().docs, db().chunks, async () => {
    await db().docs.put(doc);
    await db().chunks.bulkPut(chunks);
  });
  await bumpMemoryVersion();
  return doc;
}

export async function updateDocumentText(id: string, text: string, opts: { chunkSize: number; chunkOverlap: number }) {
  const clean = cleanText(text);
  await db().transaction('rw', db().docs, db().chunks, async () => {
    await db().docs.update(id, { text: clean, chars: clean.length, updatedAt: Date.now(), factsStatus: 'pending' });
    await db().chunks.where('docId').equals(id).delete();
    await db().chunks.bulkPut(
      chunkText(clean, { size: opts.chunkSize, overlap: opts.chunkOverlap }).map((t, idx) => ({ id: `${id}:${idx}`, docId: id, idx, text: t })),
    );
  });
  await bumpMemoryVersion();
}

export async function removeDocument(id: string) {
  await db().transaction('rw', db().docs, db().chunks, db().facts, async () => {
    await db().docs.delete(id);
    await db().chunks.where('docId').equals(id).delete();
    await db().facts.where('docId').equals(id).delete();
  });
  await bumpMemoryVersion();
}

export async function setDocumentEnabled(id: string, enabled: boolean) {
  await db().docs.update(id, { enabled, updatedAt: Date.now() });
  await bumpMemoryVersion();
}

/** Re-chunk every document (after changing chunk size). */
export async function rechunkAll(opts: { chunkSize: number; chunkOverlap: number }) {
  const docs = await db().docs.toArray();
  await db().transaction('rw', db().chunks, async () => {
    await db().chunks.clear();
    for (const d of docs) {
      await db().chunks.bulkPut(
        chunkText(d.text, { size: opts.chunkSize, overlap: opts.chunkOverlap }).map((t, idx) => ({ id: `${d.id}:${idx}`, docId: d.id, idx, text: t })),
      );
    }
  });
  await bumpMemoryVersion();
}
