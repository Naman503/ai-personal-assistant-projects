import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Brain, FileText, Loader2, Plus, Search, Sparkles, StickyNote, Trash2, UploadCloud, Pencil, Check, X, RefreshCw, AlertCircle, Database } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, Input, PageHeader, Row, Slider, Switch, Textarea } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { db, bumpMemoryVersion, type Fact, type MemoryDoc } from '@/lib/memory/db';
import { addDocument, rechunkAll, removeDocument, setDocumentEnabled, updateDocumentText } from '@/lib/memory/ingest';
import { ACCEPTED_EXTENSIONS, parseFile } from '@/lib/memory/parsers';
import { canonicalKey } from '@/lib/memory/facts';
import { rpc, track } from '@/lib/messages';
import type { RetrievalResult } from '@/lib/memory/retrieval';
import { formatBytes, uid } from '@/lib/util';
import type { PageProps } from '../App';

function useMemoryData() {
  const [docs, setDocs] = useState<(MemoryDoc & { chunks: number })[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const reload = useCallback(async () => {
    const d = await db().docs.orderBy('updatedAt').reverse().toArray();
    const counts = await Promise.all(d.map((x) => db().chunks.where('docId').equals(x.id).count()));
    setDocs(d.map((x, i) => ({ ...x, chunks: counts[i] })));
    setFacts(await db().facts.orderBy('updatedAt').reverse().toArray());
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Poll while facts are being extracted in the background.
  const pending = docs.some((d) => d.factsStatus === 'pending');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [pending, reload]);
  return { docs, facts, reload };
}

function FactRow({ f, onSave, onDelete }: { f: Fact; onSave: (label: string, value: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(f.label);
  const [value, setValue] = useState(f.value);
  if (editing)
    return (
      <div className="flex items-center gap-2 px-5 py-2.5">
        <Input className="w-48" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input className="flex-1" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (onSave(label, value), setEditing(false))} />
        <Button size="icon-sm" variant="subtle" onClick={() => (onSave(label, value), setEditing(false))}>
          <Check className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setEditing(false)}>
          <X className="size-3.5" />
        </Button>
      </div>
    );
  return (
    <div className="group flex items-center gap-3 px-5 py-2.5 not-last:border-b not-last:border-zinc-100 dark:not-last:border-zinc-800/60">
      <div className="w-48 shrink-0 truncate text-[13px] text-zinc-500">{f.label}</div>
      <div className="min-w-0 flex-1 truncate text-sm font-medium">{f.value}</div>
      <Badge tone={f.source === 'manual' ? 'neutral' : f.source === 'learned' ? 'green' : 'brand'}>
        {f.source === 'manual' ? 'Manual' : f.source === 'learned' ? 'Learned' : 'Extracted'}
      </Badge>
      <div className="flex opacity-0 transition group-hover:opacity-100">
        <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} title="Edit">
          <Pencil className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" className="hover:text-red-600" onClick={onDelete} title="Delete">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function Memory({ settings, update }: PageProps) {
  const m = settings.memory;
  const { docs, facts, reload } = useMemoryData();
  const [busy, setBusy] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<{ id?: string; title: string; text: string } | null>(null);
  const [newFact, setNewFact] = useState({ label: '', value: '' });
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const opts = { chunkSize: m.chunkSize, chunkOverlap: m.chunkOverlap };

  const notify = (docId?: string, added?: { kind: string }) =>
    rpc({ type: 'memory-changed', docId, extractFacts: !!docId, isNew: !!added, docKind: added?.kind }).catch(() => {});

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setBusy((b) => [...b, file.name]);
      try {
        const { text, kind } = await parseFile(file);
        const doc = await addDocument({ name: file.name, type: kind, text, size: file.size }, opts);
        await notify(doc.id, { kind });
        track('options_action', { action: 'doc_uploaded' });
        toast.success(`${file.name} added`, { description: `${text.length.toLocaleString()} characters. Extracting key facts…` });
      } catch (e) {
        track('options_action', { action: 'doc_failed' });
        toast.error(`${file.name}: ${(e as Error).message}`);
      } finally {
        setBusy((b) => b.filter((n) => n !== file.name));
        void reload();
      }
    }
  };

  const saveNote = async () => {
    if (!note || !note.text.trim()) return;
    if (note.id) {
      await updateDocumentText(note.id, note.text, opts);
      await db().docs.update(note.id, { name: note.title || 'Note' });
      await notify(note.id);
      track('options_action', { action: 'note_edited' });
    } else {
      const doc = await addDocument({ name: note.title.trim() || 'Note', type: 'note', text: note.text }, opts);
      await notify(doc.id, { kind: 'note' });
      track('options_action', { action: 'note_added' });
    }
    toast.success('Saved to memory');
    setNote(null);
    void reload();
  };

  const runSearch = async () => {
    if (!query.trim()) return setResult(null);
    try {
      setResult(await rpc<RetrievalResult>({ type: 'search-memory', query }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const totalChars = docs.filter((d) => d.enabled).reduce((n, d) => n + d.chars, 0);

  return (
    <>
      <PageHeader
        title="Memory"
        description="Everything FormPilot knows about you. Answers are grounded in these documents and facts, which never leave your device except as excerpts sent to the AI provider you choose."
        actions={
          <>
            <Button onClick={() => setNote({ title: '', text: '' })}>
              <StickyNote className="size-3.5" /> New note
            </Button>
            <Button variant="primary" onClick={() => fileRef.current?.click()}>
              <UploadCloud className="size-3.5" /> Upload files
            </Button>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept={ACCEPTED_EXTENSIONS.join(',')}
        onChange={(e) => {
          if (e.target.files?.length) void ingest(e.target.files);
          e.target.value = '';
        }}
      />

      {note && (
        <Card className="animate-fade-up mb-5 p-5">
          <Input className="mb-3 font-medium" placeholder="Title, e.g. “Work experience” or “Common answers”" value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} />
          <Textarea
            rows={8}
            autoFocus
            placeholder={'Write anything FormPilot should know. Q&A pairs work great:\n\nWhy do you want to work here? I love building tools that…\nNotice period: 30 days\nWilling to relocate: Yes, to Bangalore or remote'}
            value={note.text}
            onChange={(e) => setNote({ ...note, text: e.target.value })}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNote(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveNote} disabled={!note.text.trim()}>
              Save note
            </Button>
          </div>
        </Card>
      )}

      <div
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
        className={cn(
          'mb-5 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition',
          drag ? 'border-brand bg-brand/5' : 'border-zinc-200 hover:border-zinc-300 hover:bg-white dark:border-zinc-800 dark:hover:bg-zinc-900/50',
        )}
      >
        <div className="mb-2 grid size-10 place-items-center rounded-xl bg-brand/10 text-brand">
          {busy.length ? <Loader2 className="size-5 animate-spin" /> : <UploadCloud className="size-5" />}
        </div>
        <p className="text-sm font-medium">{busy.length ? `Reading ${busy.join(', ')}…` : 'Drop your resume, CV, profile or notes here'}</p>
        <p className="mt-1 text-xs text-zinc-500">PDF, DOCX, TXT, MD, CSV, JSON or HTML · up to 25 MB · parsed locally</p>
      </div>

      <Card className="mb-5">
        <CardHeader
          icon={<FileText className="size-4" />}
          title="Documents"
          description={`${docs.length} document${docs.length === 1 ? '' : 's'} · ${totalChars.toLocaleString()} characters active${totalChars <= m.contextBudgetChars && totalChars > 0 ? ' · small enough to send in full' : ''}`}
        />
        {docs.length === 0 ? (
          <Empty icon={<FileText className="size-5" />} title="No documents yet" description="Upload a resume or write a note. FormPilot extracts key facts automatically." />
        ) : (
          docs.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-5 py-3 not-last:border-b not-last:border-zinc-100 dark:not-last:border-zinc-800/60">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-zinc-100 font-mono text-[10px] font-semibold text-zinc-500 uppercase dark:bg-zinc-800">{d.type}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{d.name}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                  <span>{formatBytes(d.size)}</span>·<span>{d.chars.toLocaleString()} chars</span>·<span>{d.chunks} chunks</span>·
                  {d.factsStatus === 'pending' && (
                    <span className="inline-flex items-center gap-1 text-brand">
                      <Loader2 className="size-3 animate-spin" /> extracting facts
                    </span>
                  )}
                  {d.factsStatus === 'done' && <span className="text-emerald-600">facts extracted</span>}
                  {d.factsStatus === 'error' && (
                    <span className="inline-flex items-center gap-1 text-red-600" title={d.error}>
                      <AlertCircle className="size-3" /> extraction failed
                    </span>
                  )}
                  {d.factsStatus === 'skipped' && <span className="text-amber-600">add a provider to extract facts</span>}
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Re-extract facts"
                onClick={async () => {
                  track('options_action', { action: 'facts_reextract' });
                  await db().docs.update(d.id, { factsStatus: 'pending' });
                  void reload();
                  const n = await rpc<number>({ type: 'extract-facts', docId: d.id }).catch(() => 0);
                  toast.success(`Extracted ${n} facts from ${d.name}`);
                  void reload();
                }}
              >
                <Sparkles className="size-3.5" />
              </Button>
              <Button size="icon-sm" variant="ghost" title="View / edit text" onClick={() => setNote({ id: d.id, title: d.name, text: d.text })}>
                <Pencil className="size-3.5" />
              </Button>
              <Switch
                checked={d.enabled}
                onCheckedChange={async (v) => {
                  track('options_action', { action: 'doc_toggled' });
                  await setDocumentEnabled(d.id, v);
                  await notify();
                  void reload();
                }}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                className="hover:text-red-600"
                title="Delete"
                onClick={async () => {
                  if (!confirm(`Delete “${d.name}” and the facts extracted from it?`)) return;
                  track('options_action', { action: 'doc_deleted' });
                  await removeDocument(d.id);
                  await notify();
                  void reload();
                  toast.success('Deleted');
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader
          icon={<Brain className="size-4" />}
          title="Key facts"
          description="Short facts fill instantly with no AI call. Edit anything that's wrong. Manual facts always win."
        />
        <form
          className="flex gap-2 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800/60"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newFact.label.trim() || !newFact.value.trim()) return;
            track('options_action', { action: 'fact_added' });
            await db().facts.put({ id: uid('fact'), key: canonicalKey(newFact.label), label: newFact.label.trim(), value: newFact.value.trim(), source: 'manual', updatedAt: Date.now() });
            await bumpMemoryVersion();
            setNewFact({ label: '', value: '' });
            void reload();
          }}
        >
          <Input className="w-48" placeholder="Label (e.g. Email)" value={newFact.label} onChange={(e) => setNewFact({ ...newFact, label: e.target.value })} />
          <Input className="flex-1" placeholder="Value" value={newFact.value} onChange={(e) => setNewFact({ ...newFact, value: e.target.value })} />
          <Button type="submit" variant="subtle">
            <Plus className="size-3.5" /> Add
          </Button>
        </form>
        {facts.length === 0 ? (
          <Empty icon={<Brain className="size-5" />} title="No facts yet" description="They are extracted from uploaded documents, or you can add them above." />
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {facts.map((f) => (
              <FactRow
                key={f.id}
                f={f}
                onSave={async (label, value) => {
                  track('options_action', { action: 'fact_edited' });
                  await db().facts.update(f.id, { label, value, key: canonicalKey(label), source: 'manual', updatedAt: Date.now() });
                  await bumpMemoryVersion();
                  void reload();
                }}
                onDelete={async () => {
                  track('options_action', { action: 'fact_deleted' });
                  await db().facts.delete(f.id);
                  await bumpMemoryVersion();
                  void reload();
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Search className="size-4" />} title="Test retrieval" description="See which memory excerpts FormPilot would use for a question." />
        <form
          className="flex gap-2 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <Input placeholder="e.g. Describe a challenging project you led" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        {result && (
          <div className="space-y-2 px-5 pb-5">
            <div className="text-xs text-zinc-500">
              {result.whole ? 'Your memory is small, so all documents are sent in full.' : `${result.chunks.length} excerpts`} · {result.ms}ms
            </div>
            {result.chunks.map((c) => (
              <div key={c.id} className="rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-800/30">
                <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                  <Badge>{c.docName}</Badge> score {c.score.toFixed(3)}
                </div>
                <div className="line-clamp-4 whitespace-pre-wrap">{c.text}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader icon={<Database className="size-4" />} title="Retrieval settings" description="For power users." />
        <Row label="Use memory" description="Turn off to answer from facts and the page only.">
          <Switch checked={m.enabled} onCheckedChange={(v) => update((d) => void (d.memory.enabled = v))} />
        </Row>
        <Row label="Auto-extract facts" description="Use the AI once per uploaded document to pull out key facts.">
          <Switch checked={m.autoExtractFacts} onCheckedChange={(v) => update((d) => void (d.memory.autoExtractFacts = v))} />
        </Row>
        <Row label="Excerpts per request (top-k)">
          <Slider className="w-64" value={m.topK} min={1} max={15} onChange={(v) => update((d) => void (d.memory.topK = v))} />
        </Row>
        <Row label="Context budget" description="Max characters of memory per request. If all your docs fit, they're sent whole and retrieval is skipped.">
          <Slider className="w-64" value={m.contextBudgetChars} min={1000} max={40000} step={1000} onChange={(v) => update((d) => void (d.memory.contextBudgetChars = v))} format={(v) => `${v / 1000}k`} />
        </Row>
        <Row label="Chunk size / overlap" description="Changing these re-splits every document.">
          <div className="flex items-center gap-2">
            <Input type="number" className="w-24" value={m.chunkSize} min={200} max={4000} onChange={(e) => update((d) => void (d.memory.chunkSize = Number(e.target.value) || 900))} />
            <Input type="number" className="w-20" value={m.chunkOverlap} min={0} max={1000} onChange={(e) => update((d) => void (d.memory.chunkOverlap = Number(e.target.value) || 0))} />
            <Button
              size="icon"
              title="Re-chunk all documents"
              onClick={async () => {
                track('options_action', { action: 'rechunk' });
                await rechunkAll(opts);
                await notify();
                void reload();
                toast.success('Re-chunked all documents');
              }}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </Row>
        <Row label="Semantic search (embeddings)" description="Hybrid BM25 + Gemini embeddings with rank fusion. Better for paraphrased questions. Needs a Gemini key.">
          <Switch
            checked={m.useEmbeddings}
            onCheckedChange={(v) => {
              update((d) => void (d.memory.useEmbeddings = v));
              if (v) setTimeout(() => void notify(), 500);
            }}
          />
        </Row>
      </Card>
    </>
  );
}
