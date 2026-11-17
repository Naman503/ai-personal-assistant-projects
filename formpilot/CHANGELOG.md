# Changelog

All notable changes to FormPilot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and FormPilot uses
[Semantic Versioning](https://semver.org/).

## [1.19.2] - 2026-11-17

### Fixed
- **Autopilot crawling or stalling while you use other apps.** Brave treats a tab as hidden when its window is behind other windows, even if it's the front tab of that window. A hidden page gets no screen redraws and its timers slow to once a second, then once a minute, so LinkedIn's Easy Apply dialog barely opened (a 12-job batch took 33 minutes for 3 applications) and Naukri jobs sat on one page until the watchdog moved on. FormPilot now turns on Chromium's "emulate a focused page" setting for its own tab only, through the `debugger` permission, so the page runs as if it were in front. It stays on across sites and is switched off when the autopilot stops.

## [1.17.0] - 2026-11-16

### Added
- **LinkedIn outreach** (Settings → Behavior → Job tracker → LinkedIn outreach, off by default). For jobs you applied to, FormPilot asks the job tracker for one task at a time and does it in a quiet window of its own: reads "Meet the hiring team" on the job page, sends each person a connection request with a note written for them (or without a note when LinkedIn has no personalised invites left), checks every couple of days whether they accepted, and then sends a message. The tracker holds the daily limits, sending hours and dry run, and writes each note only right before it is sent. LinkedIn's weekly-limit or security pages pause outreach for 6 hours.

## [1.12.1] - 2026-11-16

### Fixed
- **Wrong company logo in the job tracker.** On LinkedIn's search page FormPilot took the first logo on the page, which belongs to another job in the list. It now takes the image named after this company, then the logo in the job's own header, and sends none rather than a guess when several companies show.

## [1.7.1] - 2026-11-15

### Fixed
- **Apply queue on LinkedIn's live job search.** The job pane takes 5–10 seconds to load and keeps the previous job's Easy Apply button until then, so the queue could press Easy Apply on the wrong job or give up after 12 seconds. It now waits (up to 25 s) until the job id has changed and the pane shows the new job's title, and before filling it checks the dialog says "Apply to <that company>".
- LinkedIn's newer Easy Apply dialog is a plain `<dialog>` and pressing Easy Apply changes the address to `/jobs/view/…`; both are handled, and the popup still offers *Apply to this list* / *Stop* there.

### Added
- Every apply-queue step (job opened, skipped and why, fields filled, where the walk stopped, sent) appears in *Settings → Logs & Diagnostics*. The log now survives the browser stopping the idle background worker, so a run can be read back afterwards.

## [1.7.0] - 2026-11-15

### Added
- **Apply queue for LinkedIn.** On a LinkedIn job search, *Apply to this list* in the toolbar popup works down the list: it opens each Easy Apply job you haven't applied to, fills every step, presses Next, and stops with Submit highlighted. You press Submit; FormPilot records the application, closes LinkedIn's "Application sent" box, pauses a few seconds and opens the next job, then the next page. It never presses Submit. A step that needs you (a blank required field, an error) waits, and once you move past it the queue takes over again. A status message shows progress with **Skip** and **Stop**.
- Settings → Behavior → Job tracker: a daily limit (default 30), the pause between jobs (default 6 s, randomised), and job titles to skip (e.g. "Engineering Manager, Director").

## [1.6.1] - 2026-11-15

### Fixed
- **"Fill this form" from the toolbar did nothing.** The popup takes focus away from the page, and FormPilot only answered in the focused frame, so the command was dropped. The top frame now answers toolbar and right-click fills (or the iframe you were typing in).
- **LinkedIn Easy Apply fields were out of reach.** The dialog lives in a closed shadow root, so FormPilot couldn't see what was focused or clicked inside it and filled nothing. It now follows focus and clicks into closed shadow roots, and when no field is focused (a step with only Yes/No questions) it starts from the open dialog.
- Radio questions on LinkedIn were read twice ("Q? Q? *") because the legend repeats the question for screen readers.

## [1.6.0] - 2026-11-15

### Added
- **A more useful toolbar popup.**
  - On a job page it shows the job (logo, role, company, location) and whether it's already in your job tracker: "Not tracked yet", "Shortlisted", or "Applied 13 Nov", with its fit score and how many people you know there.
  - **Save** and **I applied** work from the popup and update in place; **Open** jumps to the job in the tracker; **Note** copies the LinkedIn connection note the tracker drafted for this job.
  - **Today** from the tracker: jobs to apply to, messages to send, follow-ups due and interviews, each one click away.
  - **Walk to Submit** can be switched on right in the popup.
  - Cleaner layout: one big *Fill this form* button, AI and memory status as small tiles.
- Needs a tracker with `GET /api/lookup` and `GET /api/digest` (Job Search Desk). Older trackers just show "Not tracked yet".

## [1.5.1] - 2026-11-15

### Fixed
- **Yes/No questions on LinkedIn Easy Apply were skipped.** LinkedIn hides the radio input behind a styled label, so FormPilot treated the group as invisible: "Fill this form" left them empty, the walk stopped on that step, and the answers never reached the job tracker. Radios and checkboxes now count as visible when their label is.

## [1.5.0] - 2026-11-15

### Added
- **Walk the form to Submit** (Settings → Behavior → Job tracker, off by default). After "Fill this form" on a multi-step application such as LinkedIn Easy Apply, FormPilot presses Next or Review for you, fills each new step, and stops at the Submit button with it highlighted. It never presses Submit, and it stops as soon as a step needs you: an empty required field, a required checkbox, or a validation error. Answers from every step are still recorded in the job tracker.

### Fixed
- "Fill this form" found no fields in dialogs built inside a shadow root without a `<form>` (LinkedIn Easy Apply). The fill now scopes to the dialog, or to the shadow root itself.
- The fill anchored on the shadow host instead of the focused field inside it when started from the toolbar or shortcut.

## [1.4.1] - 2026-11-14

### Fixed
- LinkedIn applications were recorded with the company as "linkedin.com" after LinkedIn renamed its page classes. FormPilot now also reads the company from the tab title ("Role | Company | LinkedIn") or the company link.

### Added
- The job tracker record includes the company logo from the job page (LinkedIn, Wellfound and careers pages), so the tracker can show it.

## [1.4.0] - 2026-11-13

### Added
- **Answers fit the field.** FormPilot keeps one answer and converts it for each field at insert time, using the field type, `inputmode`, `pattern`, `maxlength`, placeholder and the question's wording:
  - notice period: "30 days" → `30` in a days-only box, `1` when asked in months, `0` for "Immediate";
  - salary: "10,75,000" → `10.75` when asked in lakhs, `1075000` in a numbers-only box, monthly ↔ yearly when the question says so;
  - experience: "3+ years" → `3` in a number box, `42` when asked in months;
  - dates in the format the field asks for (`DDMMYY`, `DD/MM/YYYY`, date pickers), read day-first;
  - phone numbers trimmed to the 10-digit national number when the field only takes 10 digits;
  - percentages and other numbers-only fields lose units and separators.
  Free-text fields without a unit hint keep the answer exactly as written.
- **Dropdowns and radio buttons match ranges**: "30 days" picks "1 Month", "3+ years" picks "3-5 years", "10,75,000" picks "10-15 Lakhs".
- The AI is told the shape a field expects ("whole number only, in days", "amount in lakhs, per year", "date as DD/MM/YYYY").

### Fixed
- **"Can't reach the tracker" in Brave/Chrome with limited site access.** *Test connection* now asks the browser for access to the tracker's address, and the error says how to allow it.
- Short answers were cut to a field's `maxlength` before they were converted (a "+91 …" phone number lost its last digits).

## [1.3.1] - 2026-11-13

### Fixed
- **LinkedIn Easy Apply applications weren't recorded.** LinkedIn shows the Easy Apply dialog inside a shadow root, which FormPilot couldn't read, so it never saw "Application sent". It now reads text inside shadow roots too, and also recognises LinkedIn's "Applied … ago" label.

### Added
- If no confirmation shows up within 30 seconds of pressing Submit, FormPilot asks whether the application went through, with a **Record it** button, so nothing is missed silently.

## [1.3.0] - 2026-11-13

### Added
- **Job tracker** (*Behavior → Job tracker*, off by default). Point FormPilot at a self-hosted [Job Search Desk](https://github.com/Naman503/ai-personal-assistant-projects/tree/main/formpilot#job-tracker) or any server with the same API, and every application is recorded there as **Applied** when the site confirms it ("Your application was sent", "Thank you for applying", thank-you pages). It keeps the job's role, company, location and description, and optionally the questions and answers you gave (passwords and sensitive fields never), including those on earlier steps of multi-page forms such as LinkedIn Easy Apply.
- Toolbar buttons and right-click items: **Save this job** and **I applied**, for sites whose confirmation FormPilot can't see.

### Fixed
- "Expected CTC" questions were classified as *current* salary, so a saved current CTC could be suggested for expected CTC, and the other way round.
- A saved answer to "years of experience in React" was offered for every other skill ("…in Golang", "…in Azure"). Saved answers for these questions now stay with their skill.
- Fields without a real question (e.g. "input id", "rec-form-80644…") no longer become key facts that match unrelated fields on other sites.

## [1.2.0] - 2026-10-26

### Added
- **Richer anonymous usage** (same off switch, still nothing in Local-only mode): suggestions requested / shown / accepted (acceptance rate), how a suggestion was inserted (click, Enter, Tab, Alt+number) and its position, how the popup was opened (on focus, icon, Alt+J, Alt+↓, right-click menu, chat question), Regenerate / Shorter / Longer / Refine and the other popup buttons, keyboard shortcuts and context-menu items, the toolbar popup and settings pages, memory and provider actions, and learn-from-corrections prompts.
- Quality signals: the outcome of every suggestion request (AI, cache, saved answer, fact, empty, error, timeout), AI errors by category (rate limit, auth, timeout, network, locked…), latency buckets, response-cache hits, provider fallbacks, fact extraction and embedding results, provider tests.
- A daily snapshot of on/off settings and preset choices (never sites, prompts, persona text or models), the number of configured providers by type, and memory size buckets.
- Crash capture in the content script, toolbar popup, settings page and offscreen page, forwarded to the background with only the error class and FormPilot's own stack frames.

### Changed
- `popup_opened` now counts each popup open once (it used to count both the instant lookup and the AI request).

## [1.1.0] - 2026-10-25

### Added
- **Share anonymous usage** (*Privacy & Data*), on by default. It shares which features are used, daily counts of filled fields by source (memory, history, AI), setup milestones, the AI provider *type* (Gemini, Groq, Ollama…) and error types, with a random id made on install.
- It never shares field contents, page addresses, memory, provider URLs, headers or keys, and it sends nothing in Local-only mode. Turning it off deletes what was sent.

### Changed
- Asks for the `alarms` permission, used to send usage a few times a day.

## [1.0.0] - 2026-10-23

First public release.

### Added
- **Suggestions under every field:** a dropdown anchored to the focused field, with several options tagged Memory / History / AI / Cached, streaming output, and Regenerate · Shorter · Longer · Refine…
- **The AI decides the answer length** from the question and the field; it always respects `maxlength`.
- **Whole-form fill** in one request (Alt+Shift+J), with Undo. Passwords, cards, OTPs, CAPTCHAs and consent checkboxes are never touched.
- **Memory:** upload PDF, DOCX, TXT, MD, CSV, JSON or HTML (parsed locally), or write notes. Key facts are extracted automatically. Hybrid BM25 + embedding retrieval with reciprocal-rank fusion.
- **Instant answers** from key facts, saved answers and a response cache, with no AI call.
- **Learns from corrections:** type the right answer and FormPilot offers to remember it (Ask me / Save automatically / Off).
- **Providers with automatic fallback:** Google Gemini, Chrome built-in AI (Gemini Nano), OpenRouter free models, Groq, Ollama, LM Studio and any OpenAI-compatible endpoint. Includes a live model picker with context, pricing and size.
- **Local Models page:** one-click install and removal of open models through Ollama, with a catalog of specs and RAM needs.
- **Popups and chat questionnaires:** renders in the browser's top layer and mounts inside modals and drawers. Chat-questionnaire sites (Naukri by default) read the bot's latest question and refresh after each reply.
- **Movable popup:** drag it anywhere, with the position remembered per site or everywhere; reset it from the ⋯ menu or settings. Pin it to keep it on screen. Clicking a field reopens a closed popup. Placement, size, opacity and visible parts are configurable. Alt+1…9 inserts a suggestion directly.
- **Password-protected API keys:** keys are encrypted with AES-256-GCM using a key derived from your password (PBKDF2, 600,000 iterations). A 4-digit PIN is allowed, and wrong attempts are throttled. An optional strict mode locks keys after a browser restart.
- **Privacy:** sensitive fields are never read or filled, secrets are redacted before sending, and there is a local-only mode and per-site rules.
- **Settings app:** 12 pages, light and dark themes, logs and diagnostics, export and import, and an About page.
- **Tests:** 136 unit tests (Vitest) and 23 end-to-end tests (Playwright driving real Chromium with the extension loaded).

[1.1.0]: https://github.com/Naman503/ai-personal-assistant-projects/releases/tag/formpilot-v1.1.0
[1.0.0]: https://github.com/Naman503/ai-personal-assistant-projects/releases/tag/formpilot-v1.0.0
