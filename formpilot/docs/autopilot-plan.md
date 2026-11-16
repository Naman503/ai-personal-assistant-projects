# FormPilot Autopilot: plan

Goal: one unattended session that works through your job titles on LinkedIn (Easy Apply), Naukri and Cutshort in small rotating batches, up to a daily limit per platform. You don't watch it. It tells you what it did and stops when something looks wrong.

Status: plan only, nothing built yet. Today's queue (LinkedIn list → fill → walk → optional auto-submit) is the base it reuses.

---

## 1. Can it run "without looking at the browser"?

Yes, but not in a minimised or hidden window. Chromium (Brave included) slows down pages you can't see:

| Window state | What happens | Works? |
|---|---|---|
| Visible, even if behind other windows on another monitor/Space | Normal speed | ✅ |
| Minimised, or fully covered (macOS "occluded") | Timers run once a minute after 5 min, animation frames stop, lazy lists don't load | ❌ stalls |
| Laptop asleep / lid closed | Nothing runs | ❌ |
| Background tab in a visible window | Throttled like hidden | ❌ |

**So it needs a dedicated runner:**
- **Recommended:** the MacBook Air or the Windows laptop.
  - A separate Brave profile, signed in to LinkedIn, Naukri and Cutshort, with FormPilot loaded.
  - Brave started with `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`.
  - The display kept awake (`caffeinate -d` on the Mac, the power plan on Windows). The Brave window open on its own and never minimised.
- **Not this Mac.** It's a company device, and you didn't want the job hunt visible to your company admin.
- I can check on the runner from here over Tailscale (`ssh air` / `ssh winpc`): logs, screenshots, stop.

## 2. How it flows

```
for each round (every 20–40 min, inside active hours):
  platform = next in rotation (LinkedIn → Naukri → Cutshort → LinkedIn …), skipping any at its daily cap
  title    = next job title for that platform (your list, round-robin)
  open the platform's search for that title (last 24 h, Easy Apply / quick apply only)
  apply to a BATCH of 3–5 jobs (filters below), each:
      read the job → filter → open apply → fill → walk to Submit → quality gate → submit (or leave for you)
      record in the tracker → pause 40–120 s
  close the tab, rest until the next round
stop for the day when every platform has reached its daily cap, or at the end of active hours
```

The orchestrator lives in FormPilot's background worker as a saved state machine (`chrome.storage.local` + `chrome.alarms`), so it survives Brave restarts and the worker going to sleep. The per-site work stays in the content scripts that already exist (queue/walk/fill).

## 3. Settings

| Setting | Default | Note |
|---|---|---|
| Job titles | your list, e.g. React Native Developer, Mobile Engineer, Full Stack (React/Node) | One search per title per platform per day |
| Daily limit per platform | LinkedIn 25 · Naukri 30 · Cutshort 10 | LinkedIn checks accounts above ~50/day; Naukri has its own daily apply limit |
| Daily limit per title | 10 | Stops one title eating the whole day |
| Batch size | 3–5 (random) | Small batches, as you suggested |
| Gap between batches | 20–40 min (random) | |
| Pause between jobs | 40–120 s (random) | Plus 2–5 s "reading" before opening each job |
| Active hours | 10:00–19:30 IST, Mon–Sat | Nothing at night |
| Mode | **Dry run** for the first 2–3 days | Fills to Submit, records "would apply", you review in the tracker |
| Minimum fit | tracker `minFit` | Uses the Job Search Desk fit score |
| Skip titles / companies | your lists | e.g. Engineering Manager, Director, iOS-only |

## 4. Gate before every Submit (auto mode)

It submits only when **all** of these hold. Otherwise the job is left open on the Submit step for you, or skipped, and flagged:

1. No required field is empty, and no field shows an error.
2. Every answer came from a fact, a rule or your own past answer, **or** from the AI with the question type known (no "unnamed field").
3. The answers agree with your profile:
   - salary in a sane range (current about 10.75 L, expected about 15 L);
   - notice 30 days;
   - years of experience ≤ what the resume supports;
   - "willing to relocate", "sponsorship" and "authorised to work" match the brief.
4. "Please respond truthfully" questions and knockout questions were answered from facts, not guesses. Otherwise it's left for you.
5. Not applied before on any platform. The tracker is checked by company + title, so the same job seen on LinkedIn and Naukri isn't applied to twice.
6. The job is still open ("No longer accepting applications" means skip).

## 5. Edge cases and what it does

**Session and account**

| Situation | Action |
|---|---|
| Logged out, or a login wall | Stop this platform for the day and alert you |
| CAPTCHA, "verify you're human", security checkpoint, phone or email verification | **Stop everything** and alert you. Never solve or bypass it |
| "You've reached the limit", or an "unusual activity" warning | Stop this platform for 24 h and alert you |
| 2FA prompt | Stop and alert you |

**Job and form**

| Situation | Action |
|---|---|
| Apply goes to an external company site, not Easy Apply / Naukri apply | Skip and save it to the tracker as "apply on site" for you |
| Resume step | Pick the latest resume (Naman_Pathak_Resume) and never upload a different file |
| Cover letter required | Use the tracker's drafted cover note if there is one; otherwise leave it for you |
| A file asked for (portfolio PDF, certificate) | Leave it for you |
| Assessment, test link or video question | Skip and flag |
| Employment dates missing a month | Use remembered months; otherwise leave it for you |
| Unknown step layout (LinkedIn changed its markup) | Stop, save a DOM snapshot and the logs, alert you |
| Same job fails twice | Add to a skip list and move on |
| "Save this application?" on close | Discard |
| Naukri recruiter chatbot | Answer through FormPilot's chat mode, with the same gate |
| Cutshort cover-note / "why you" box | Short answer drafted from the job + resume, with the same gate |

**Runner**

| Situation | Action |
|---|---|
| Network error, page didn't load | Retry once after 30 s, then skip the job |
| Gemini error, 429 or quota | Pause 10 min; after 3 in a row, pause the day and alert you |
| Brave crash or restart, laptop slept | Resume from the saved state; never re-submit a job already recorded |
| Window minimised or hidden (timers throttled) | Detect via `document.visibilityState`, pause and alert you |
| Daily limit reached mid-batch | Finish the current job, then stop that platform |

**Counting** (today's bug)
- One applied count, kept by the tracker in **India time**.
- A job is counted only when the site confirms it ("Application sent", Naukri's "Applied", Cutshort's confirmation). Never on pressing Submit alone.
- Every night it checks the tracker against LinkedIn's own Applied list and fixes any differences.

## 6. Reporting and control

- **Live:** the tracker's Today page shows each platform's count against its limit, the current state ("LinkedIn · React Native Developer · job 3/5"), and a log of skips and stops.
- **Alerts** (Telegram, once the bot token is set) when it:
  - stops for you, hits a checkpoint or CAPTCHA, reaches its limits, or finishes the day;
  - also sends an evening summary with the count, skips and anything waiting for you.
- **Kill switch:** Stop in the FormPilot popup, a toggle in the tracker (checked before every job), or `/stop` on Telegram.
- **Review:** the tracker keeps each submitted application's questions and answers, so you can spot-check them.

## 7. Risks

- **Platform rules.** LinkedIn's and Naukri's terms don't allow automated use. Pacing, small batches and stopping on any warning lower the chance of a restriction, but can't remove it. The account at risk is your main profile.
- **Answer quality.** Unattended answers can be wrong. That's why it starts in dry-run mode, why the Section 4 gate exists, and why truthful/knockout questions stay with you unless a fact answers them.
- **Naukri.** You earlier chose to press Naukri's Apply yourself ("No, I'll click"). Auto-applying there changes that decision, so please confirm it.

## 8. Build order (each phase ships and runs for a few days before the next)

| Phase | What | Outcome |
|---|---|---|
| 0 | Counting fixed: tracker dedupe by job id, India-time dates, title kept whole (in progress) | Counts match LinkedIn |
| 1 | Runner set up (Air or Windows): Brave profile, flags, keep-awake, FormPilot synced from GitHub releases; remote check over Tailscale | Runs while you're away |
| 2 | LinkedIn search from your titles + small batches + active hours + daily limits, **dry run** | Several days of "would apply" to review |
| 3 | Section 4 gate + auto-submit on LinkedIn, plus Telegram alerts and the kill switch | Unattended LinkedIn |
| 4 | Orchestrator rotating between platforms; Naukri search + apply + chatbot (after you confirm) | LinkedIn ↔ Naukri |
| 5 | Cutshort | Three platforms |
| 6 | Nightly count check, weekly report (applies → replies → interviews per platform/title) | Shows which titles and platforms work |

## 9. Decisions needed from you

1. ~~Runner~~ **Decided: this M4 Mac**, in the normal Brave profile (FormPilot's memory lives there). Brave is relaunched once with the anti-throttling flags; the autopilot window stays visible (not minimised, can sit on a second display or Space); the display is kept awake while it runs (`caffeinate -d`, started and stopped by the autopilot); on power, lid open.
2. **Naukri:** may it press Apply for you (this reverses "No, I'll click")?
3. **"Profile" in "applies of each profile each day":** your job titles, or separate accounts?
4. **Your title list and daily limits,** or keep the defaults above.
5. **Dry run first** (recommended), or auto-submit from day one?
