/**
 * The last check before an unattended application is sent: every question with the answer
 * FormPilot put in, read again by the AI against your memory and the job. Answers from memory
 * can be stale or in the wrong shape for the question (a full sentence where a number is asked,
 * an option that isn't offered, the wrong company in a note). The AI returns only what to fix.
 */
export interface ReviewItem {
  id: string;
  question: string;
  answer: string;
  /** The choices, when the question has fixed options (the fix must be one of them). */
  options?: string[];
  /** "text", "number", "note" (a cover note / message), "choice". */
  kind: 'text' | 'number' | 'note' | 'choice';
  maxLength?: number;
}
export interface ReviewFix {
  id: string;
  ok: boolean;
  fix?: string;
  why?: string;
}

export const REVIEW_SYSTEM = `You check job application answers right before they are sent, for a candidate who is not watching.
For each item decide: is the answer true for this candidate (per the facts and documents), does it answer the question asked, and is it in the right form for the field?
Fix an answer when it is: false or contradicts the candidate's facts; for a different question; the wrong format (a number field needs only the number, a yes/no needs Yes or No, a choice must be exactly one of the options, dates as the question asks); a placeholder or empty; too long for the field; a note or message that names the wrong company or role, is generic, or is badly written.
Never invent facts that are not in the candidate's facts or documents. If unsure, keep the answer (ok true).
Notes and messages: 3-5 sentences, first person, plain and specific to this job and company.
Reply with JSON only.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, ok: { type: 'boolean' }, fix: { type: 'string' }, why: { type: 'string' } },
        required: ['id', 'ok'],
      },
    },
  },
  required: ['items'],
} as const;

export function buildReviewPrompt(items: ReviewItem[], job: string, facts: string, docs: string): string {
  const list = items
    .map((it) => {
      const opts = it.options?.length ? `\n  options: ${it.options.map((o) => JSON.stringify(o)).join(', ')}` : '';
      const max = it.maxLength ? `\n  max length: ${it.maxLength}` : '';
      return `- id: ${it.id}\n  kind: ${it.kind}\n  question: ${JSON.stringify(it.question)}\n  answer: ${JSON.stringify(it.answer)}${opts}${max}`;
    })
    .join('\n');
  return `CANDIDATE FACTS:\n${facts || '(none)'}\n\nCANDIDATE DOCUMENTS (resume and notes):\n${docs || '(none)'}\n\nTHE JOB (page text):\n${job.slice(0, 4000)}\n\nANSWERS TO CHECK:\n${list}\n\nReturn {"items":[{"id":"…","ok":true} or {"id":"…","ok":false,"fix":"corrected answer","why":"short reason"}]} with one entry per id.`;
}

export function parseReview(text: string): ReviewFix[] {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text) as { items?: ReviewFix[] };
    return (j.items ?? []).filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, ok: x.ok !== false, fix: typeof x.fix === 'string' ? x.fix : undefined, why: typeof x.why === 'string' ? x.why : undefined }));
  } catch {
    return [];
  }
}

/** A fix is used only when it fits the field: one of the options, a number for a number, within the length. */
export function usableFix(it: ReviewItem, f: ReviewFix): string | null {
  if (f.ok || !f.fix?.trim()) return null;
  const v = f.fix.trim();
  if (it.options?.length) return it.options.find((o) => o.trim().toLowerCase() === v.toLowerCase()) ?? null;
  if (it.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) return null;
  if (it.maxLength && v.length > it.maxLength) return null;
  return v;
}
