# Site Pilot: applying on company websites with a local model

Site Pilot is a second, separate pilot. The **Autopilot** applies inside LinkedIn and Naukri, with Gemini first and the local model as a fallback. **Site Pilot** applies on company career sites and Google Forms, and only ever uses the local model. The two run at the same time, each in its own Brave window.

| | Autopilot | Site Pilot |
|---|---|---|
| Where | LinkedIn Easy Apply, Naukri apply + chatbot | Company career sites (Greenhouse, Lever, Ashby, Workable, …), Google Forms, any other application form |
| AI | Gemini, then local fallback | Local model only (gemma4:12b by default), never a cloud model |
| Limits | Per-platform daily limits | No daily limit. At most 2 applications per company per 30 days |
| Window, state, alarms | Its own | Its own (`fpSitePilot`, `fp-sp-*`, a second window) |
| Shared | Your memory: resume, facts, saved answers, answer rules, job tracker | Same |

## Where jobs come from

1. **Naukri "Apply on company site" jobs.** The Autopilot used to skip these. Now it hands them to Site Pilot's queue.
   - Site Pilot opens the Naukri job in its own window and presses "Apply on company site".
   - A small page hook catches the company link Naukri opens.
2. **Outside forms from Naukri's recruiter chatbot** ("fill this Google Form"). The link and the job go to the queue.
3. **You:**
   - the popup's **Apply with Site Pilot** button on any job or career page;
   - a paste box on the Site Pilot page for many links at once.
4. **LinkedIn jobs that apply on the company site:** open the company page, then use the popup button.
   - LinkedIn only reveals that link through a real click or its private API, so it isn't harvested automatically.

## What happens for each job

1. **Open** the link in Site Pilot's window, then follow redirects. For Naukri jobs, press "Apply on company site" first.
2. **Check before doing anything** (no AI). It stops on any of these:
   - **Already applied:** the same job, or 2 applications to this company in 30 days. The job is skipped.
   - **The job is closed:** "no longer accepting applications" and similar. Skipped.
   - **Needs you:** a login or account wall (Workday, Taleo, SuccessFactors, iCIMS), a CAPTCHA, a test or assessment, or a payment. The job goes to **Needs you**.
3. **Find the form.** On a job description page it presses "Apply" or "Apply for this job" and waits for the form.
4. **Fill, one page at a time:**
   - **Resume:** uploaded into the file field or dropped on the uploader. Sites that read the resume fill some fields themselves; those are left as the site filled them.
   - **Answers:** each field goes through the same order as everywhere else:
     1. your saved answer;
     2. facts;
     3. rules (3 years of experience when unknown; Yes to relocation; No to sponsorship; start date);
     4. the local model, with your resume and memory.
   - **Custom controls:**
     - Google Forms options and dropdowns (`role=radio`, `role=checkbox`, `role=listbox`);
     - type-and-pick dropdowns (react-select);
     - Yes/No buttons (Ashby);
     - location autocompletes.
   - **Consent:**
     - a required privacy or data-processing box is ticked;
     - marketing or newsletter boxes never are.
   - **Demographic and EEO questions:** "Decline to self-identify" or the nearest option.
   - **Cover letter or "Why us":** 2–3 sentences from the job description and your resume. It names the role and a real overlap, never a template.
5. **Look and check (the model sees the page):** after the fill, Site Pilot takes a screenshot of its window and lists:
   - the visible fields and buttons, each with an id;
   - their values;
   - any errors.

   The local model gets both and returns one action at a time:

   ```json
   {"do":"fill","id":"f7","value":"30 days"}   {"do":"choose","id":"f9","option":"Yes"}
   {"do":"click","id":"b3"}   {"do":"upload","id":"f2"}   {"do":"next"}   {"do":"submit"}
   {"do":"stop","why":"asks to create an account"}
   ```

   Site Pilot carries out the action, waits for the page to settle, and looks again. This handles fields the fill missed, errors the site shows, "Next" pages, and forms nobody wrote an adapter for.
6. **Before Submit,** all three must hold:
   - every required field is filled;
   - no error is showing;
   - the model agrees the form is complete.

   The filled form is screenshotted.
   - **Dry run:** stop here and record "ready".
   - **Live:** press Submit once.
7. **Confirm.** A job counts as sent only with one of these:
   - a "thank you / application received" message;
   - a confirmation URL;
   - the model reading the screenshot as a confirmation.

   Otherwise it is "unsure" and goes to Needs you with the screenshot.
8. **Record.** In Site Pilot's records:
   - the job and its link;
   - the system (ATS);
   - every question with its answer and where the answer came from;
   - the steps taken;
   - screenshots (form, before submit, confirmation);
   - the outcome.

   Sent jobs also go to your job tracker.

## Safety rails

- It never types a password, creates an account, solves a CAPTCHA, takes a test, uploads anything except your resume, or pays.
- It presses Submit at most once per job, and only after the checks above.
- Each job is limited to 30 actions, 15 minutes and 3 visits to the same page. Then it moves on and the job goes to Needs you.
- It skips jobs that have:
  - your skip words;
  - more experience than your maximum;
  - a duplicate (same link, or the same company and title).
- **Dry run is on at first.** Go live per system once its dry runs look right: Google Forms, Greenhouse, Lever, Ashby, Workable, other sites.

## Local model: speed vs. your Mac

Measured on this Mac (M4, 16 GB):
- **gemma4:12b** scored 15/15 on real application questions. It reads a form screenshot correctly in about 14 s once loaded; loading takes about 25 s.
- **CPU-only mode was unusable** (over 10 minutes per answer), so the model always uses the GPU. What can be tuned is *when* and *how often* it runs, and how much memory it holds.

These settings sit on the Site Pilot page and apply to every local-model call, including the Gemini fallback.

| Setting | Choices (default first) | Effect |
|---|---|---|
| While you're using the Mac | **Go slow** / Pause / Full speed | **Go slow:** at most 2 model calls per minute and the model unloads after each job. **Pause:** waits until you've been idle. |
| You count as away after | **3 min** idle (1–30) | Uses Chrome's idle detection (keyboard and mouse) |
| Keep the model loaded | **5 min** / unload after each call / 30 min | Frees about 8 GB of memory between jobs |
| Context size | **8k** / 4k / 16k | Smaller uses less memory; 8k fits a full form with your resume |
| Light model while you work (optional) | none / **gemma4:e4b** if installed | Smaller and faster while you're active; the 12b is used when you're away |
| Model calls per minute when away | **6** (1–30) | Spaces calls out so the GPU isn't busy all the time |
| Pause between jobs | **1–4 min** random | Also where the model unloads |

## Build order

1. Settings, local-model controls (Ollama: images, `think:false`, options, idle gate, pacing).
2. Site Pilot database (queue and records), runner (own window, alarms, state), popup button and paste box, Options page.
3. Content side:
   - page snapshot;
   - fill through the local engine;
   - custom controls;
   - resume upload;
   - consent;
   - Submit and confirmation.
4. The see-and-act agent with screenshots.
5. Sources: Autopilot company-site skips and chatbot outside-form links into the queue; Naukri click-through with the page hook.
6. Fixtures for each common system, e2e tests with a fake local model, then a dry run on real jobs.
