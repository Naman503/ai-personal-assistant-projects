/** Site Pilot: what the page reports, what the model may do, and what a round returns. */

/** One control on the page, as the model sees it. */
export interface SnapControl {
  /** Stable for this page: f1, f2… for fields, b1, b2… for buttons. */
  id: string;
  kind: 'text' | 'textarea' | 'email' | 'tel' | 'number' | 'date' | 'url' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'combobox' | 'file' | 'button' | 'link';
  label: string;
  value?: string;
  required?: boolean;
  options?: string[];
  error?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  ats: string;
  /** Headings and other short text that say where we are ("Step 2 of 4", "Application received"). */
  text: string;
  controls: SnapControl[];
  /** Problems found without the model. */
  missing: string[];
  errors: string[];
  /** The page's own verdict: a Submit button is in view and nothing is missing. */
  submitReady: boolean;
}

/** One action the model may ask for. */
export type AgentAction =
  | { do: 'fill'; id: string; value: string }
  | { do: 'choose'; id: string; option: string }
  | { do: 'check'; id: string }
  | { do: 'click'; id: string }
  | { do: 'upload'; id: string }
  | { do: 'scroll' }
  | { do: 'next' }
  | { do: 'submit' }
  | { do: 'stop'; why: string; needsYou?: boolean };

export type SpOutcome = 'sent' | 'ready' | 'needs-you' | 'skipped' | 'failed' | 'unsure';

/** Answers given on the form, for the record. */
export interface SpAnswer {
  q: string;
  a: string;
  src?: string;
}

/** What one round in the page ended with. */
export type RoundResult =
  | { kind: 'continue'; note?: string; answers?: SpAnswer[]; ats?: string; actions?: number }
  | { kind: 'done'; outcome: SpOutcome; reason: string; answers?: SpAnswer[]; ats?: string; actions?: number };

/** What the runner tells the page at the start of a round. */
export interface RoundContext {
  jobId: string;
  title: string;
  company: string;
  /** Actions left for this job. */
  actionsLeft: number;
  /** Submit was already pressed: look for the confirmation first. */
  submitted: number;
  /** Round number on this job. */
  round: number;
  vision: boolean;
  /** Your resume's shareable link, for "link to your resume" questions. */
  resumeLink?: string;
}
