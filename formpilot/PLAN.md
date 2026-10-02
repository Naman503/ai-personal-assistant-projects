# FormPilot — Engineering Plan

An MV3 extension for Chrome and Brave. It suggests answers for any web-form field and shows them in a
dropdown right under the field, the same way Chrome's password manager does. Answers come from the
user's own **memory** (PDFs, DOCX, notes, key facts) and the page's context. Generation runs on
free or bring-your-own-key LLMs.

---

## 1. Research summary → design decisions

| Finding | Source | Decision |
|---|---|---|
| Matching fields to their labels is the hardest part. Multimodal LLMs score under 5% on real forms. | FormFactory (arXiv 2506.01520) | Extract a rich **text** descriptor per field from the DOM: label, aria, help text, section, constraints, options. Don't send screenshots. |
| Users like suggestions that are only partly right and want to see the context behind them. | OmniFill (arXiv 2310.17826) | Several options per field, each with a **source chip** (Memory / History / AI) and the memory docs used. |
| Constraints in the DOM (pattern, maxlength, min/max) improve validity. | FormNexus (arXiv 2402.00950) | Constraints go into the prompt, and `maxlength` is enforced again on insert. |
| Pruning the DOM before the LLM sees it raises accuracy and lowers cost. | Mind2Web (arXiv 2306.06070) | Never send raw HTML. Send a compact field descriptor plus a capped amount of page text. |
| Autonomous agents fail most tasks (WebArena 14%). | WebArena (arXiv 2307.13854) | Human in the loop: suggestions by default. "Fill form" is explicit and has **Undo**. |
| Facts placed in the middle of a long context get lost. | Lost in the Middle (arXiv 2307.03172) | A small context budget, with the most relevant chunks first. Facts go in a separate compact block. |
| BM25 is a strong zero-shot retriever, and hybrid search with RRF beats either method alone. | BEIR (2104.08663), Anthropic Contextual Retrieval | MiniSearch BM25 is always on. Optional Gemini embeddings are fused with Reciprocal Rank Fusion. Small memories skip retrieval and are sent whole. |
| Ollama returns 403 for a `chrome-extension://` Origin. | ollama envconfig, page-assist, heapcode PR #25 | A DNR rule **removes the Origin header**, scoped to `initiatorDomains=[extId]`, `tabIds=[-1]` and the configured Ollama host only. |
| The Prompt API (Gemini Nano) only exists in Window contexts, from Chrome 138, and not in Brave. | Chrome docs, Prompt API spec | It runs in an **offscreen document**. It is detected at runtime and skipped cleanly on Brave. |
| The MV3 service worker dies after 30 s idle, or when a fetch response takes more than 30 s. | Chrome SW lifecycle | Generation streams over a long-lived `runtime.Port`. Each chunk keeps the service worker alive. |
| React/Vue/Angular ignore `el.value = x`. | React #10135 | Insert with `execCommand('insertText')`. If that fails, use the native prototype setter, then `input`, `change` and `blur` events. |
| Rich editors (Lexical, ProseMirror, Draft) undo direct DOM edits. | TextBetter, ProseMirror write-ups | contenteditable tries `execCommand('insertText')` first, then a synthetic `paste` with a DataTransfer. It never sets `innerHTML`. |
| The Bitwarden inline menu uses a closed shadow root, `position:fixed` and full keyboard nav. | Bitwarden contributing docs | The dropdown is a **closed** shadow-root host with hand-written CSS, placed by Floating UI, with arrows/Enter/Esc/Tab. It is mounted inside an open `<dialog>` when the field is in one, because everything outside a modal dialog is inert. |
| Gemini 2.5 is limited for new projects. 3.x uses `thinkingLevel`, not `thinkingBudget`. | ai.google.dev | Default `gemini-3.5-flash-lite` with `thinkingLevel` minimal → low → none as automatic fallbacks. Models are listed live from `/models`. |
| The OpenRouter `:free` line-up changes weekly. | openrouter.ai | Default to `openrouter/free` (auto-router). The live model list comes from `/models`. |

## 2. Architecture

```
┌──────────────────────── Web page (every frame) ────────────────────────┐
│ content script                                                          │
│  ├─ FieldWatcher: focusin (composedPath, open shadow roots), eligibility │
│  ├─ FieldContext extractor (label/aria/section/constraints/options)     │
│  ├─ PageContext (title, form heading, other filled fields, main text)   │
│  ├─ Dropdown UI (React, closed shadow root, Floating UI, keyboard nav)  │
│  └─ Filler (execCommand → native setter → events; contenteditable;      │
│     select matching; maxlength clamp; highlight; undo)                  │
└────────────────────────────┬────────────────────────────────────────────┘
                 Port "fp-suggest" (stream)  │  runtime.sendMessage (RPC)
┌────────────────────────────▼────────────────────────────────────────────┐
│ background service worker                                               │
│  ├─ SuggestEngine                                                       │
│  │   1. instant: Facts (semantic type match) + History (accepted fills) │
│  │   2. response cache (hash of prompt+model, TTL)                      │
│  │   3. retrieval: MiniSearch BM25 (+ Gemini embeddings, RRF)           │
│  │   4. prompt builder → provider chain w/ retry+fallback → stream      │
│  │   5. tolerant JSON parse (partial-json) → validate → clamp           │
│  ├─ Providers: Gemini · OpenAI-compatible (OpenRouter/Groq/LM Studio/…) │
│  │             · Ollama (NDJSON, DNR origin fix) · Chrome AI (offscreen)│
│  ├─ Memory store: Dexie/IndexedDB (docs, chunks, facts, history, cache) │
│  └─ Log ring buffer (+ forwarded content warnings/errors)               │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
   options page (React + Tailwind): providers, generation, memory upload
   (pdf.js / mammoth parse in page), facts, cache, privacy, appearance, logs
   popup: per-site toggle, provider status, quick actions
   offscreen document: Chrome built-in AI (LanguageModel) host
```

## 3. Performance budget
- **Instant suggestions** (facts and history) in under 30 ms. No network call. They show before the AI results.
- **Repeated questions**: the response cache is keyed on the full prompt plus the model, and serves hits in under 50 ms. A field you have already answered also comes back from History.
- **AI**: suggestions are streamed. Partial JSON shows text while it's being generated, so the first text appears in about 300–800 ms on Gemini Flash-Lite or Groq.
- **Lazy content-script start**: nothing runs until the first `focusin` on a field that qualifies. The UI loads only on first use.
- **Retrieval**: the MiniSearch index is cached in the service worker's memory and persisted to IndexedDB, then rebuilt only when memory changes.
- **Debounce and cancel**: moving focus aborts the in-flight request through AbortController, so no tokens are spent on fields you've left.

## 4. Safety and privacy
- Never read, send or fill: passwords, card numbers, CVV, expiry, OTP/2FA, CAPTCHA, PINs, government IDs, bank account numbers.
- Secrets are redacted from memory before sending: card-number and IBAN-like patterns.
- "Local only" mode allows only Chrome AI, Ollama and LM Studio.
- API keys stay in `chrome.storage.local`. They are never synced, and never sent anywhere except their own provider.
- A per-site blocklist or allowlist, and a one-click "pause on this site".
- Forms are never auto-submitted.

## 5. Edge cases covered
- Controlled inputs in React, Vue, Angular and Svelte; contenteditable in Gmail, LinkedIn, Lexical, ProseMirror and Draft.js.
- Open shadow-DOM fields, read via `composedPath`.
- Same-origin and cross-origin iframes: `all_frames` and `match_origin_as_fallback`.
- `<dialog>` modals, which make everything outside them inert.
- Fixed and sticky headers: Floating UI `flip`, `shift` and `size`.
- Scrolling containers: `autoUpdate`.
- `maxlength`, `pattern`, `min`/`max`, `type=date` (ISO), number fields, select options by value or label, radio groups during whole-form fill.
- Pages that re-render the field: the element reference is re-resolved before insertion.
- Search and chat boxes are skipped, as are tiny fields and fields that are hidden or disabled.
- Service-worker restarts: the port is re-created and the request retried once.
- Provider failures: 401/403 (bad key), 429 (Retry-After and backoff, then the next provider), 5xx, timeouts, CORS, models that ignore JSON mode (falls back to plain text).
- Malformed or partial LLM JSON, code fences, quotes around answers, duplicate suggestions.
- Corrupt or outdated settings: the zod schema falls back field by field.

## 6. Testing strategy
- **Unit (Vitest + happy-dom)**:
  - Label extraction: for/id, wrapping label, aria-labelledby, placeholder, table layouts, nearby text.
  - Classification and sensitive-field detection.
  - Fill events and maxlength clamping.
  - Select matching.
  - Chunker, BM25 retrieval and RRF.
  - Facts matching.
  - Prompt builder.
  - Tolerant JSON parser.
  - SSE/NDJSON stream parsers.
  - Provider error mapping with a mocked fetch.
  - Settings defaults and migration.
  - Answer cache and history.
- **E2E (Playwright, real Chromium with the built extension)**:
  - A local fixture form, including React-style controlled inputs, a textarea and a contenteditable.
  - A mock OpenAI-compatible server.
  - Tests: focus → dropdown appears → keyboard select → value inserted → `input` event fired → history learned; then the same question again is served instantly.

## 7. Milestones
1. Core libraries: settings, logger, field context and classification, filler.
2. Providers with streaming, retry and fallback; the suggest engine; caches.
3. Memory: parsers, chunking, BM25 and embeddings, facts extraction.
4. Content dropdown UI with keyboard and accessibility; whole-form fill with undo.
5. Options app (9 sections) and popup.
6. Unit and e2e tests; build and zip; README.

## 8. Future work
- WebLLM (WebGPU in-browser models) as a provider that needs no setup.
- Firefox build: WXT supports it, but there is no Prompt API there.
- Custom ARIA comboboxes, i.e. listbox widgets that need simulated clicks.
- An eval harness on AutoFormBench (arXiv 2603.29832) to score field labelling.
