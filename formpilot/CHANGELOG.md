# Changelog

All notable changes to FormPilot are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and FormPilot uses
[Semantic Versioning](https://semver.org/).

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
