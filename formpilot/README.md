# FormPilot: AI form filler for Chrome and Brave

**Developed by Naman Pathak** · [namanpathak503@gmail.com](mailto:namanpathak503@gmail.com)

FormPilot is a browser extension (Manifest V3) that fills web forms with AI, using **your own documents** as its memory. Click into any field and suggestions appear right underneath, the same way Chrome's password manager does. Pick one with ↑ ↓ and press Enter.

It works on ordinary forms, on React/Vue/Angular apps, in rich-text editors, and inside **popup chat questionnaires**, such as Naukri's "answer the recruiter's questions" drawer.

---

## Features

### Suggestions under every field
- A dropdown anchored under the focused field. It flips above the field when there's no room below, and stays above modals and drawers.
- **Several options per field**, each tagged with where it came from: *Memory*, *History*, *AI* or *Cached*.
- **The AI decides the length**: a few words for "City", a paragraph for "Why do you want to join?". It always respects the field's `maxlength`.
- Streaming output, so text appears while it's being written.
- Actions in the dropdown: **Regenerate**, **Shorter**, **Longer**, **Refine…** (free-text instructions) and **Save my answer**.
- **Fill whole form** (Alt+Shift+J) in a single AI request, with **Undo**.

### Memory
- Upload **PDF, DOCX, TXT, MD, CSV, JSON or HTML** files, or write notes. Files are parsed locally in the browser.
- **Key facts** (email, phone, LinkedIn, notice period…) are extracted automatically, and you can edit them.
- **Hybrid retrieval**: BM25 keyword search, plus optional Gemini embeddings, combined with reciprocal-rank fusion. If all your documents fit in the context budget, they're sent in full.
- **Learns from your corrections.** Type the right answer yourself and FormPilot offers to remember it. Next time that exact question gets your answer instantly, with no AI call.

### Speed on repeated questions
| Layer | What it does | Typical latency |
|---|---|---|
| Key facts | `Email` → your saved email | < 30 ms, no network |
| Saved answers / history | Same question on any site → your previous answer | < 30 ms, no network |
| Response cache | Identical question + context + model | ≈ 1 ms |
| AI | Streams through the provider chain | depends on the provider |

### AI providers (free options included)
Providers are tried in your order, with **automatic fallback**, retries and backoff:
- **Google Gemini**: a free API key from AI Studio.
- **Chrome built-in AI** (Gemini Nano, on-device): Chrome 138+ only, not Brave. It's skipped automatically when unavailable.
- **OpenRouter** free models (`openrouter/free` auto-router, `:free` models).
- **Groq** free tier.
- **Ollama** (local). FormPilot strips the extension's Origin header for you, so you don't need to set `OLLAMA_ORIGINS`.
- **LM Studio**, or **any OpenAI-compatible** endpoint.

The **model picker** lists every model your key can use, live from the provider. It shows context window, price per 1M tokens, free badges, parameters, quantization and size. The **Local Models** page lists the models installed in Ollama and a catalog of open models with specs and RAM needs, and installs or deletes them with one click.

### Popups and chat questionnaires
- The dropdown renders in the browser's **top layer**, so it sits above any overlay whatever its z-index.
- When a field is inside a popup or drawer, the dropdown is **mounted inside that popup**. The site's "click outside closes the popup" logic then counts clicks on FormPilot as inside.
- **Chat questionnaire sites** (default: `naukri.com`, editable in settings): suggestions open the moment the chat box gets focus, with no click needed. The bot's latest question is read using three methods:
  1. the site's own message markup (on Naukri, the last visible `.botMsg`; the greeting is skipped);
  2. what is **visually above** the input, found with `elementsFromPoint`;
  3. a backwards scan through the page's HTML.
- After each reply, suggestions refresh for the next question.

### Privacy and safety
- FormPilot **never reads, sends or fills** passwords, card numbers, CVV, OTP/2FA codes, CAPTCHAs, PINs, government IDs or bank details.
- Secrets are redacted before anything is sent: Luhn-checked card numbers, IBANs, API keys and `password: …` lines.
- **Local-only mode** restricts it to on-device providers.
- API keys stay in local extension storage. They are never synced, and only ever sent to their own provider.
- Per-site blocklist or allowlist, plus a one-click **pause on this site**.
- Forms are never submitted automatically, and consent checkboxes are never ticked.

---

## Install

You need **Node 20+** and **pnpm**.

```bash
cd formpilot
pnpm install
pnpm build
```

Then:
1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** and click **Load unpacked**.
3. Select `formpilot/.output/chrome-mv3`.

`.output` is a hidden folder. In the file picker on macOS, press **⌘ + Shift + .** to show it.

The settings page opens on first install. The quickest free setup is to paste a Gemini key from <https://aistudio.google.com/app/apikey> under **AI Providers**, then click **Test connection**.

### After changing code

| How you run it | What to do |
|---|---|
| `pnpm dev` (recommended) | Nothing. WXT rebuilds, reloads the extension and refreshes open tabs. It launches its own Chrome window with the extension loaded and a demo form. |
| `pnpm build` + Load unpacked | Run `pnpm build`, click **↻** on FormPilot in `chrome://extensions`, then **refresh the web page**. |

If you reload the extension without refreshing an open page, the dropdown says "FormPilot was updated. Refresh this page."

---

## Using it

| Action | How |
|---|---|
| Show suggestions | Click into a field, press **Alt+J**, or right-click → *FormPilot: suggest* |
| Navigate / insert / close | **↑ ↓** / **Enter** / **Esc** |
| Fill the whole form | **Alt+Shift+J**, the ☑ icon in the dropdown, or the toolbar popup |
| Teach the right answer | Type it yourself and choose **Remember**, or use **Save my answer** / right-click → *remember my answer* |
| Pause on a site | ⏸ in the dropdown, or the toolbar popup |

You can change the shortcuts at `chrome://extensions/shortcuts`.

---

## Settings overview

| Page | Highlights |
|---|---|
| Overview | Status, setup checklist, stats, shortcuts |
| AI Providers | Provider order, fallback, keys, live model picker, test connection, local-only mode |
| Local Models | Ollama status, installed models, catalog with specs, one-click install/delete |
| Memory | Upload documents, notes, key facts, retrieval playground, chunking, embeddings |
| Generation | Suggestions per field, length, tone, language, grounding (strict/balanced/creative), persona, custom instructions, page context, temperature, thinking level, streaming, timeout, retries |
| Behavior | When the dropdown opens (focus / icon / shortcut), field types, insert mode, chat questionnaire sites, site rules |
| Speed & History | Learning from corrections (ask / auto / off), instant facts, history threshold, response cache, learned answers |
| Privacy & Data | Redaction, local-only mode, export/import backup, delete everything |
| Appearance | Theme, accent colour, density, dropdown width, reduced motion |
| Logs & Diagnostics | Live log viewer, log level, copy diagnostics (API keys excluded) |

---

## Debugging

Every step is logged with a **FormPilot** prefix:
- **The website's DevTools console** (filter `FormPilot`): field detection, why a field was skipped, the chat question found and how, the insert method.
- **The service worker console** (`chrome://extensions` → FormPilot → *service worker*): retrieval, provider calls, timings and fallbacks.
- **Settings → Logs & Diagnostics**: a live log viewer that also includes warnings forwarded from web pages.

On chat-questionnaire sites, a `chat field diagnostics` line shows the detected question, what each detection method found, and where the dropdown was mounted.

---

## Development

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm dev:brave` | Dev mode with auto-reload, plus the demo form at <http://localhost:4173/form.html> |
| `pnpm build` / `pnpm zip` | Production build / zip for the Chrome Web Store |
| `pnpm compile` | Type-check |
| `pnpm test` | Unit tests (Vitest + happy-dom) |
| `pnpm test:e2e` | Builds, then runs Playwright against real Chromium with the extension loaded |
| `node scripts/fixture-server.mjs` | Demo/test pages on :4173 and a mock OpenAI-compatible LLM on :4174 |
| `pnpm icons` | Regenerate the extension icons |

The end-to-end tests cover:
- streaming suggestions;
- keyboard navigation;
- React-controlled inputs;
- instant facts;
- sensitive-field protection;
- whole-form fill;
- rich-text editors;
- provider errors;
- modals with focus traps;
- drawers with capture-phase click-outside handlers;
- a copy of Naukri's drawer structure;
- chats whose messages are visually above the input but later in the HTML;
- learning from corrections.

Before the first e2e run, install the browser with `npx playwright install chromium`.

### Tech stack
[WXT](https://wxt.dev) (MV3, Vite) · React 19 · TypeScript · Tailwind CSS v4 · Radix UI · Floating UI · Dexie (IndexedDB) · MiniSearch (BM25) · pdf.js · mammoth · zod · Vitest · Playwright

### Project structure
```
formpilot/
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts        # service worker: suggestion engine, providers, RPC, commands, context menu
│  │  ├─ content/             # in-page dropdown (closed shadow root, top layer), field watcher, filler
│  │  ├─ options/             # settings app (10 pages)
│  │  ├─ popup/               # toolbar popup
│  │  └─ offscreen/           # hosts Chrome's on-device model (the Prompt API is window-only)
│  ├─ lib/
│  │  ├─ fields/              # field context & labels, classification, eligibility, insertion
│  │  ├─ engine/              # suggest engine, prompts, tolerant JSON parsing, cache, history, redaction
│  │  ├─ llm/                 # Gemini, OpenAI-compatible, Ollama, Chrome AI, provider chain, model catalog
│  │  ├─ memory/              # IndexedDB schema, parsers, chunker, hybrid retrieval, facts
│  │  ├─ settings*.ts         # zod schema (validated) + zod-free defaults for the content script
│  │  └─ logger.ts            # namespaced logger + ring buffer
│  └─ components/             # UI kit, model picker
├─ tests/
│  ├─ unit/                   # Vitest
│  ├─ e2e/                    # Playwright (real Chromium + extension)
│  └─ fixtures/               # demo form, modal, drawer and chatbot test pages
├─ scripts/                   # fixture server + mock LLM, icon generator
└─ PLAN.md                    # research summary, architecture, edge cases, test strategy
```

See **[PLAN.md](PLAN.md)** for the research behind the design (form-filling and retrieval papers, similar projects), the architecture diagram, the performance budget and the full list of edge cases.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Invalid or missing API key" | Settings → AI Providers → fix the key → **Test connection** |
| Rate limited | Free tiers have per-minute limits; add a second provider so fallback kicks in |
| Ollama 403 | Reload the extension once after adding Ollama (the Origin-fix rule is installed on load) |
| "Chrome AI not available" | Needs Chrome 138+ on desktop with enough disk/RAM; Brave doesn't ship it. It's skipped automatically. |
| Dropdown doesn't open on a chat popup | Add the site under Settings → Behavior → *Chat questionnaire sites*, refresh the page, and check the `chat field diagnostics` console line |
| Nothing happens on a page | Refresh the page after installing or reloading the extension |
| Old errors on the extension's Errors page | They persist until you click **Clear all** there |

---

## Author

**Naman Pathak**, [namanpathak503@gmail.com](mailto:namanpathak503@gmail.com)

Questions, bugs and ideas are welcome: open an issue or send an email.
