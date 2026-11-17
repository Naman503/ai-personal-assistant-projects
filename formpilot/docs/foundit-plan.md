# Foundit in the autopilot: plan

Status (17 Nov 2026):
- Steps 1–3 are built (FormPilot 1.22.0).
- Foundit is **on in dry run**.
- Step 4 (going live) waits for one recorded manual Quick Apply.

## What we know (read live on 17 Nov 2026, signed in as you)

**Search page:** `foundit.in/srp/results?query=<title>&locations=India`.
- Each result is a `div.cardContainer` whose `id` is the job id. Inside it:
  - `#jobCardTitle` (title)
  - `.companyName` (company)
  - `.details` ("5 - 10 Years")
  - `.details.location`
  - "Posted 3 hours ago"
- Some cards are tagged **Quick Apply** (`.cardApplyLabel`) and have a tick box for multi-apply ("up to 15 Quick Apply jobs").
- Others say "Early Applicant" and have no tick box.

**Job page:** `foundit.in/job/<id>`.
- The real apply button sits in the page header: `#jdPageHeader #applyBtn`.
- **"Quick Apply"** applies on Foundit itself.
- **"Apply Now"** means the job comes from somewhere else. One we saw links to its LinkedIn post, so the application is on another site.
- Further down the page, every *similar job* has its own `#applyBtn` "Apply Now". Those must never be pressed. Cutshort had the same trap.

**Still unknown:** what happens after Quick Apply. It may apply at once, or show recruiter questions, possibly over several steps. Your one manual apply (below) shows it.

## How the autopilot handles Foundit

1. **Turn order:** LinkedIn → Naukri → **Foundit** → Cutshort. Each portal has its own daily limit (Foundit: 15 a day to start).
2. **Search:** one job title per batch, India-wide, using the same titles as the other portals.
3. **Filter the list:**
   - Quick Apply jobs only.
   - Your job-title phrases.
   - Your skip words.
   - At most 5 years asked.
   - Not already applied.
   - Not tried today, matched on the same company + title as Naukri.
4. **Per job:**
   1. Open its page.
   2. Read it for a few seconds.
   3. Check the header button:
      - "Applied": skip.
      - "Apply Now": skip, it applies elsewhere.
      - "Quick Apply": continue.
5. **Quick Apply:**
   - **Dry run:** stop here and record "would apply". One click can send, so dry run never presses it.
   - **Live:**
     1. Press the header button.
     2. If recruiter questions pop up, answer them with your usual rules: saved answers, facts, keep-in rules, then the AI.
     3. Press Submit or Next, up to 6 steps.
     4. "Applied" on the button, or a success message, counts as sent.
     5. An unanswerable required question closes the pop-up and skips the job.
6. **Records:**
   - Each application goes to the job tracker, with its questions and answers.
   - The autopilot history shows "Foundit · Applied: <title> · <company>".
   - Every questions pop-up is logged, to tune the answers.
7. **Safety:**
   - Foundit asking you to sign in, a CAPTCHA, or "limit reached" stops Foundit for the day.
   - Pause/Resume works the same as the other portals.

## Build order

| # | What | Status |
|---|---|---|
| 1 | Search link, reading the cards, Quick Apply filter | Done (1.22.0) |
| 2 | Job page: header button only, Applied / Apply Now / Quick Apply | Done (1.22.0) |
| 3 | Questions pop-up: answer, Submit/Next, confirmation; dry run stops before Quick Apply | Done for a generic pop-up (1.22.0) |
| 4 | **Your one manual Quick Apply, recorded**: check the real pop-up against step 3 and adjust | **Needs you** |
| 5 | Live at 5 a day for two days, then 15 | After step 4 |
| 6 | Multi-apply: tick up to 15 Quick Apply jobs on the search page and apply once (like Naukri's Recommended jobs) | Later, once single applies are proven |
| 7 | "Apply Now" jobs handed to Site Pilot (the company-site applier) | Later; needs the outside link captured |
| 8 | Recruiter messages on Foundit answered like the Cutshort plan's step 3 | Later |

## Things to watch

- **Seniority:** many Foundit results ask 5–10 years. The 5-year limit removes those; widen it only if you want senior roles.
- **Profile match:** Foundit shows "80% of the skills match your profile". Showing that score in the tracker could help ranking later.
- **Duplicates:** the same job is often on Naukri and LinkedIn as well. Company + title keeps one try per job per day across a portal's searches, but not yet across portals.
