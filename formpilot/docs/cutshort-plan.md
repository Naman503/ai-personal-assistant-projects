# Cutshort in the autopilot: plan

Status: plan only. Cutshort is turned **off** in the autopilot until step 1 below is done.

## What we know (read live, 16–17 Nov 2026)

- **Search:** `cutshort.io/search-jobs?free_text=<title>` lists cards: `h3 > a[href*="/job/"]`, "at Company", "1 - 3 yrs", salary, and an **"Apply now"** button.
- **Job page:** has an **"Apply to this job"** button. The "Apply now" buttons further down belong to *similar jobs* and must never be pressed. That's fixed in 1.17.1.
- **What "Apply to this job" does:** it moved the window to `cutshort.io/profile/all-jobs?jobid=<id>`. That page showed "No jobs found" and "Profile matcher is OFF", and no application was made (pending stayed at 168).
  - So Cutshort applies from its own **dashboard job view**, not the public job page.
  - The empty list was probably caused by the profile matcher being off, or by filters.
- **Dashboard** (each number comes before its label): 3 companies interested, 168 applications pending, 3 shortlisted, 18 rejected. Pending stayed at 168 through the wrong clicks, so nothing was sent.
- **Messages:** after you apply, companies send screening questions in **Messages**, and you answer them there.

## Step 1: learn the real apply flow once (needs you, about 5 minutes)

I couldn't open Cutshort's apply form myself; that step was blocked here as a risky action. The safe way to learn it:

1. Turn **Profile matcher ON** in Cutshort (Find jobs → the toggle at the top). The dashboard job list then shows jobs that match you.
2. Apply to **one** job by hand, the normal way.
3. While you do it, FormPilot's recorder (to build: a "record this page" button in the popup) saves each screen's fields and buttons, with no values, to Logs.
4. I build the Cutshort adapter from that recording, then run a dry run on it.

## Step 2: applying from Cutshort's own job list

- **Source:** the dashboard list (`/profile/all-jobs` with the matcher on) instead of public search. It only shows jobs Cutshort thinks fit, similar to Naukri's Recommended page.
- **Per job:**
  1. Open it in the dashboard view.
  2. Press its apply button.
  3. Fill any form with the same answer rules as everywhere else.
  4. Press the final button.
  5. Confirm the job shows as "Applied", or that Pending goes up by one.
- **Filters:** the same job-title phrases, skip words, and maximum years.
- **Limits:** start at 5 a day, then 10–15. Cutshort recruiters read every application, so quality matters more than volume there.
- **Dry run first:** fill everything, close without sending, and log the form.

## Step 3: answering company messages (the new part)

**What happens:** after you apply, a company sends questions in Messages, for example:
- "Notice period?"
- "Current/expected CTC?"
- "Why this role?"
- "Rate yourself in React Native"
- "Are you OK with Pune?"

Fast, correct answers move you forward.

**How FormPilot would handle it:**

1. **Check messages:** every 30–60 minutes (random) while the Mac is awake, the autopilot opens Cutshort Messages in its own window and finds unread threads from companies you applied to.
2. **Read the questions:** it reads the latest company message and splits it into questions. Several numbered questions in one message are common.
3. **Answer:** with the same engine and rules as forms:
   - facts first (CTC, notice, location, years);
   - then your rules: 3 years when unknown; Yes to relocation and shifts; No to non-compete and sponsorship;
   - then the AI for open questions ("why this role"), in your voice, short.
   - Answers are numbered to match the questions.
4. **Send, or ask you first.** This is your choice per platform:
   - **Draft and notify (default):** it types the reply into the box and doesn't send it. A notification says "Cutshort: <Company> asked 3 questions; reply ready". You check it and press Send.
   - **Auto-send (opt-in):** it sends straight away, but only when every answer came from facts, rules or your memory, and nothing below applies.
5. **Always left for you, never auto-sent:**
   - links to tests, assignments, Google Forms or calendars;
   - requests for documents (ID, payslips, offer letters);
   - questions about money beyond your stored CTC;
   - anything it can't answer from your memory.
   It never claims a test or form was done.
6. **Records:** every question and reply is saved to the job tracker under that application, which moves to "In conversation". The Today page shows "replies waiting for you".
7. **Learns:** if you edit a draft before sending, your version is saved, so the next company asking the same thing gets your answer.
8. **Pacing:** at most one reply per thread per check, a random 1–5 minute "reading time" before replying, and nothing between 23:30 and 08:00 even if active hours are off. Replies at 3 am look automated.

**Same pattern elsewhere later:** Naukri recruiter messages, and LinkedIn messages from recruiters about jobs you applied to.

## Build order

| # | What | Done when |
|---|---|---|
| 1 | "Record this page" in the popup; you apply to one Cutshort job by hand | Cutshort's real apply screens are known |
| 2 | Cutshort adapter on the dashboard list, dry run | A dry-run day with no wrong clicks |
| 3 | Cutshort live at 5/day | A week of confirmed applies |
| 4 | Messages watcher, draft-and-notify mode | Drafts appear for real company questions |
| 5 | Auto-send for fact-only replies (opt-in) | You've approved a few days of drafts unchanged |
| 6 | Naukri and LinkedIn recruiter messages | Same flow on both |

## Decisions for you

1. Turn on Cutshort's **profile matcher** and do one manual apply while recording (step 1)?
2. For company messages: **draft and notify** (recommended), or auto-send fact-only replies?
3. Quiet hours for replies: is 23:30–08:00 right?
