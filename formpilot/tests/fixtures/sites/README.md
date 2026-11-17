# ATS application-page reference + offline fixtures

Research date: 2026-11-17. Sources: read-only GETs of public job pages and public board APIs
(plus Ashby's public `ApiJobPosting` GraphQL read query), and the production JS bundles those pages
load. Nothing was submitted. Where a detail could not be observed live it is marked **(inferred)**.

Each fixture in this folder is self-contained (no network), mirrors the live class names / roles /
names / nesting, shows the system's confirmation in place on success (plus a `location.hash`
change), and exposes `window.__submitted` (object of submitted values; `undefined` before success).
All fixtures use the placeholder company "Acme Labs" and role "Senior React Native Engineer".

| Fixture | System | Success signal (fixture) | Hash |
|---|---|---|---|
| `greenhouse.html` | Greenhouse new board (React/Remix) | `h1` "Thank you for applying." in `.confirmation` | `#confirmation` |
| `greenhouse-classic.html` | Greenhouse classic (Rails/jQuery) | `#application_confirmation` "Thank you for applying." | `#confirmation` |
| `lever.html` | Lever | `h3[data-qa=msg-submit-success]` "Application submitted!" | `#thanks` |
| `ashby.html` | Ashby | `.ashby-application-form-success-container` "Success" | `#submitted` |
| `google-form.html` | Google Forms, 2 pages | `.vHW8K` "Your response has been recorded." | `#formResponse` |
| `workable.html` | Workable | "Thank you!" / "Your application has been submitted successfully." | `#success` |
| `generic-career.html` | Hand-made 3-step company form | "Thank you for applying!" | `#applied` |

General rule for React-based ATSs (Greenhouse new, Ashby, Workable, SmartRecruiters): inputs are
controlled. Set the value with the native setter
(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)`) and then
dispatch `input` (bubbling), then `change`/`blur`. Setting `.value` alone is lost on submit. The
fixtures emulate this: their state only updates from `input` events.

---

## 1. Greenhouse (new boards), `greenhouse.html`

**Detect**
- `https://job-boards.greenhouse.io/<board>/jobs/<id>` (also `job-boards.eu.greenhouse.io`).
- Embed: `https://job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>` inside
  `iframe#grnhse_iframe` (container `div#grnhse_app`), on company sites whose URL has `?gh_jid=<id>`.
  The loader is `boards.greenhouse.io/embed/job_board/js?for=<board>`. The extension must run in
  `all_frames` on `job-boards.greenhouse.io` to reach the embedded form.
- **All `boards.greenhouse.io/<board>/jobs/<id>` and `boards.greenhouse.io/embed/job_app` URLs now
  301 to `job-boards.greenhouse.io`** (verified on 10 boards).
- Many big companies (Stripe, Airbnb, Databricks) redirect to their own careers page with
  `?gh_jid=`, which then holds the embed iframe.
- Public API: `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true` gives
  `questions[]` (field `name` = DOM id, `type` = `input_text | input_file | textarea |
  multi_value_single_select | multi_value_multi_select | input_hidden`), `location_questions`,
  `compliance` (eeoc) and `demographic_questions`.

**Form structure** (server-rendered, then hydrated)
- `form#application-form.application--form` (method `get`, so React does the submit) inside
  `.application--container`. Header: `.application--header` "Apply for this job".
- Text field: `.field-wrapper > .text-input-wrapper > .input-wrapper > label#<id>-label[for=<id>].label`
  + `input#<id>.input.input__single-line[aria-required][aria-errormessage=<id>-error]`. Textarea:
  `textarea.input.input__multi-line`. **Inputs have no `name` attribute**; key on `id`
  (`first_name`, `last_name`, `preferred_name`, `email`, `phone`, `question_<n>`, `resume_text`).
- Required marker: `<span aria-hidden="true">*</span>` inside the label, plus `aria-required="true"`.
- Phone: `fieldset.phone-input` > `.phone-input__country` (react-select `#country`, options like
  "India +91") + `.phone-input__phone input#phone[type=tel]`.
- Location: `#candidate-location` is an **async** react-select. It needs typing, then options load
  from Greenhouse's geocoder. There is also a "Locate me" button and hidden lat/long.
- Single select (`multi_value_single_select`, EEOC, phone country, education): **react-select**
  (classNamePrefix `select`): `.select > .select__container > label.select__label` + `.select-shell`
  > `.select__control` > `.select__value-container` > (`.select__placeholder` or
  `.select__single-value`) + `input.select__input#<id>[role=combobox][aria-expanded]`, and a hidden
  `input.remix-css-…-requiredInput[required]`, which drives the native required bubble.
  **Driving it:** `mousedown` on `.select__control` (or focus the input and press ArrowDown) opens
  `.select__menu > .select__menu-list[role=listbox] > .select__option[role=option]#react-select-<id>-option-<n>`.
  Click an option, or type to filter and press Enter. `.value=` on the combobox does nothing.
- Multi select: `fieldset.checkbox#question_<n>[]` > `legend.checkbox__description` +
  `.checkbox__wrapper > .checkbox__input > input[type=checkbox][name="question_<n>[]"][value=<optionId>]`
  + `label[for]`. Every box has `required` until one is checked.
- Yes/No questions are react-selects with options "Yes"/"No" (no buttons).
- EEOC (`.eeoc__container`, `.eeoc__question__wrapper`): react-selects `#gender`,
  `#hispanic_ethnicity`, `#race` (shown only when Hispanic = No), `#veteran_status`,
  `#disability_status`. The decline options are "Decline To Self Identify" for gender and
  ethnicity, "I don't wish to answer" for veteran, and "I do not want to answer" for disability.
  Some boards instead have a `#demographic-section.demographic--container` with numeric ids and
  multi react-selects.
- Education (optional): react-selects `#school--0`, `#degree--0`, `#discipline--0` + "Add another".

**Resume**: `.file-upload[role=group]` > `.file-upload__wrapper` > buttons "Attach" / "Dropbox" /
"Google Drive" / "Enter manually". The real input is `input#resume.visually-hidden[type=file]
[accept=".pdf,.doc,.docx,.txt,.rtf"]`, so call `setInputFiles`/DataTransfer on `#resume`. The
filename then shows in `.file-upload__filename` with a "Remove file" button. "Enter manually" swaps
in `textarea#resume_text`. Same for `#cover_letter`. **Uploading a resume does not autofill**; the
autofill comes from "MyGreenhouse" (job-seeker login) and Apply with SEEK.

**Submit / success / errors**: `.application--submit button[type=submit]` "Submit application".
Errors are `p#<id>-error.helper-text.helper-text--error[aria-live=polite]` with
`aria-invalid="true"` on the input, and `select__control--error` / `select__label--error` on selects.
Success navigates to `/<board>/jobs/<id>/confirmation` (`.confirmation h1` "Thank you for
applying." by default; the text can be customised). **Anti-bot:** invisible reCAPTCHA (Enterprise)
key in the page config (`GOOGLE_RECAPTCHA_INVISIBLE_KEY`), with no visible widget. **Login:** none.

## 2. Greenhouse classic, `greenhouse-classic.html`

Legacy: classic pages now redirect to the new board, but cached and self-hosted copies exist.
The markup comes from an archived live page (2023).
- `form#application_form[enctype=multipart/form-data]` > `#main_fields` (`.field > label[for] + input`),
  names `job_application[first_name|last_name|email|phone|location|resume_text]`, honeypot
  `#dev-fields input[name=dev_field_1]` (**never fill**).
- Custom questions in `#custom_fields .field > label` (the label wraps the control). The names are
  `job_application[answers_attributes][N][text_value]`, `[N][boolean_value]` (select `--`/Yes=1/No=0),
  `[N][answer_selected_options_attributes][M][question_option_id]` (select or checkboxes), plus
  hidden `[N][question_id]` / `[N][priority]`. Required = `span.asterisk` + `aria-required="true"`.
  Plain native controls (`.value` + `change` works).
- EEOC `#eeoc_fields`: `select#job_application_gender|hispanic_ethnicity|race|veteran_status|disability_status`.
  The decline options are "Decline To Self Identify" and "I don't wish to answer".
- Resume: `.attach-or-paste[data-field=resume]` with an "Attach" button. The file input is created
  by JS inside `.s3-upload-form` (`input#s3_upload_for_resume`). Then `#resume_chosen` /
  `#resume_filename`, and "or enter manually" reveals `textarea#resume_text`. No parsing.
- Submit: `input[type=button]#submit_app` "Submit Application" (not a submit button; `form.submit()`
  skips the validation). `#captcha_container` holds reCAPTCHA. Errors: `#error_message`
  and per-field highlight **(inferred: `.field-error` / `.field-error-msg`)**. Success: confirmation
  page "Thank you for applying." **(inferred id `#application_confirmation`)**.

## 3. Lever, `lever.html`

**Detect**: `jobs.lever.co/<company>/<uuid>/apply` (also `jobs.eu.lever.co`). Posting
`jobs.lever.co/<company>/<uuid>`, success `…/<uuid>/thanks`. API
`api.lever.co/v0/postings/<company>?mode=json` (`applyUrl`). Some companies embed the Lever postings
list on their site with apply links that go to jobs.lever.co (no iframe).

**Form** (server-rendered jQuery, `form#application-form[enctype=multipart/form-data]`):
- Sections `.section.application-form` with `h4`. Base fields are
  `li.application-question > label > .application-label (+ span.required "✱") + .application-field > input`:
  `name` (full name, a single field), `email`, `phone`, `location` (`#location-input.location-input`),
  `org`, `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Twitter]`, `urls[Other]`. `data-qa`
  hooks: `name-input`, `email-input`, `phone-input`, `location-input`, `org-input`, `input-resume`, `btn-submit`.
- Custom cards: `div[data-qa=additional-cards]` with `h4[data-qa=card-name]`, hidden
  `cards[<cardId>][baseTemplate]` (JSON with all field definitions and options). Questions are
  `li.application-question.custom-question` with `.application-label.full-width.<type>` where type is
  `text | textarea | dropdown | multiple-choice | multiple-select`, and the required ones are inside
  `.application-field.required-field`. Names are `cards[<cardId>][field<N>]`. Radios are
  `ul[data-qa=multiple-choice] li label input[type=radio][value=<option text>]`. Checkboxes are
  `ul[data-qa=checkboxes] ... input[type=checkbox]` with the same name repeated. Dropdowns are
  native `select` (first option "Select ..."). Textareas are `textarea.card-field-input`.
- "Additional information" is `textarea#additional-information[name=comments]` (cover letter).
- EEO (`.eeo-section[data-qa=eeo-section]`, US postings only): native `select[name="eeo[gender]"]`,
  `eeo[race]`, `eeo[veteran]`, optionally `eeo[disability]` (`#disabilitySelectElement`) with signature
  fields `eeo[disabilitySignature]`, `eeo[disabilitySignatureDate]`. Decline value =
  **"Decline to self-identify"** (disability: "I do not want to answer").
- **Location quirk:** suggestions are fetched on **keydown** (500 ms debounce) from
  `/searchLocations` and rendered as `.dropdown-results > .dropdown-location`. You must pick one
  (`mousedown` on the item, or ArrowDown + Enter). That fills hidden `#selected-location` (JSON).
  **Blurring without picking clears the input.**
- Required checkbox groups: `requiredCheckboxGroups.js` keeps `required` on every box until one is
  checked.

**Resume**: `#resume-upload-input.application-file-input.invisible-resume-upload[name=resume]`
(opacity-0 overlay inside `a.visible-resume-upload`, which has the text "ATTACH RESUME/CV"). On
change it POSTs to `/parseResume` and shows "Analyzing resume..." then "Success!" or "Couldn't
auto-read resume.". It then **overwrites name, email, phone, org, location and urls[*] unless that
field was "touched"**, and a field only counts as touched after a `change` or `paste` event. So
either upload the resume first, or dispatch `change` after filling each field. Max 100 MB, any
type.

**Submit**: `#btn-submit[type=button][data-qa=btn-submit]` "Submit application". It runs
**hCaptcha** (invisible, `#h-captcha.h-captcha`, token goes into hidden `h-captcha-response`), then
clicks hidden `#hcaptchaSubmitBtn[type=submit]`, so native HTML5 `required` validation shows browser
bubbles. Success is a full navigation to `/thanks` with `h3[data-qa=msg-submit-success]`
"Application submitted!". A server-side failure re-renders with `.error-message`. hCaptcha may show
a visual challenge, and the extension must stop and let the user solve it. **Login:** none.

## 4. Ashby, `ashby.html`

**Detect**: `jobs.ashbyhq.com/<org>/<postingUuid>` (Overview tab) and `…/<postingUuid>/application`
(Application tab), plus embeds via `jobs.ashbyhq.com/<org>/embed?...` (iframe) on company sites.
Public API `api.ashbyhq.com/posting-api/job-board/<org>`. The full form schema comes from POST
`jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` (read-only query): `applicationForm` +
`surveyForms`, with sections, `fieldEntries[{id, isRequired, field{path,title,type,selectableValues}}]`.
Types: `String, Email, Phone, Location, File, LongText, Boolean, ValueSelect, MultiValueSelect,
Number, Date, Score, RichText, SocialLink`. `window.__appData` in the HTML only has posting metadata.

**Form**: client-rendered SPA. **No `<form>` element.** Use the stable public classes
(`ashby-*`), and avoid the hashed `_fieldEntry_1e3gg_28` style classes, which change per deploy.
- `.ashby-application-form-container` > `.ashby-application-form-section-container`
  (optional `.ashby-application-form-section-header-title`) > entries
  `div.ashby-application-form-field-entry[data-field-path=<path>][data-field-entry-id=<id>]`
  > `label.ashby-application-form-question-title[for=<path>]`, with the required asterisk drawn by
  CSS `::after` on a hashed `_required_` class. So **"required" is not in the text**: use the input's
  `required` attribute or the GraphQL schema.
- Text, email, phone (`type=tel`, placeholder "1-415-555-1234...") and number:
  `input.ashby-application-form-input-text#<path>[name=<path>]`. Textarea:
  `textarea.ashby-application-form-input-textarea`. System paths: `_systemfield_name`,
  `_systemfield_email`, `_systemfield_location`, `_systemfield_resume`. Custom fields use a uuid
  path, and so does Phone. Every change is saved to the server (debounced 500 ms, and on blur).
- **Boolean** = `.ashby-application-form-input-yesno` > two
  `button.ashby-application-form-input-yesno-option[data-option=yes|no][aria-pressed]` + hidden
  checkbox. **Click the button.**
- **ValueSelect, 8 options or fewer** = `fieldset.ashby-application-form-input-radio-group`
  > `.ashby-application-form-input-radio-group-option` > `input[type=radio]#<entryId>-labeled-radio-<n>`
  + `label.ashby-application-form-input-radio-group-option-label`. **More than 8 options** = an
  autocomplete combobox (see Location). **MultiValueSelect** =
  `fieldset.ashby-application-form-input-checkbox-group` with
  `input[type=checkbox]#<entryId>-labeled-checkbox-<n>`. These two are **not** wrapped in
  `.ashby-application-form-field-entry`, only in `div[data-field-path]`, and the label is inside the
  fieldset.
- **Location** (and big selects) = `input.ashby-application-form-input-autocomplete`
  (placeholder "Start typing...", `aria-autocomplete=list`, no id, so `label[for]` does not resolve).
  Type, then wait for the popup, which is **rendered in a portal at the end of `<body>`**:
  `.ashby-application-form-input-autocomplete-popup` >
  `[role=option].ashby-application-form-input-autocomplete-popup-result`. Click it, or press Enter
  on the first (active) one. Blur without picking reverts the text.
- EEOC survey is a second container inside `.ashby-survey-form-container`. Paths are
  `_systemfield_eeoc_gender|race|veteran_status` (radio groups), and the decline options are
  "Decline to self-identify" / "I decline to self-identify for protected veteran status".

**Resume**: `.ashby-application-form-input-file` (react-dropzone root, `noClick`) contains a hidden
`input[type=file]#_systemfield_resume` (display:none) plus a
`.ashby-application-form-input-file-dropzone-upload` button ("Upload File", later "Replace") and
"or drag and drop here". Use `setInputFiles` on the hidden input, or synthesise a `drop`. Uploaded
items show as `.ashby-application-form-input-file-item(-name|-delete)`. Max ~6 MB. Separately,
**`.ashby-application-form-autofill-uploader` ("Autofill from resume", "Upload file")** has its own
hidden file input. It parses the file ("Parsing your resume. Autofilling key fields...") and
autofills key fields (name, email, phone, links, resume). On failure it shows "Oops! Some fields
couldn't be filled automatically."

**Submit**: `button.ashby-application-form-submit-button` "Submit Application". It is blocked while
uploads or value-saves are pending ("We're updating your forms..."). Server validation shows a top
alert "Your form needs corrections" with a list of field links. Success replaces the form with
`.ashby-application-form-success-container[role=status]`: "Success" + "Your application was
successfully submitted. We'll contact you if there are next steps." (customisable). Failure shows
`.ashby-application-form-failure-container` "We couldn't submit your application" (also used for
spam flags: VPN, extensions). **Anti-bot:** reCAPTCHA v3 (invisible score) + device fingerprint,
no checkbox. **Login:** none.

## 5. Google Forms, `google-form.html`

**Detect**: `docs.google.com/forms/d/e/<publishedId>/viewform` (also `/forms/d/<id>/viewform`,
short links `forms.gle/<x>`, embedded `iframe[src*="docs.google.com/forms"]` with `embedded=true`).
Submits to `…/formResponse`.
- Model: `var FB_PUBLIC_LOAD_DATA_ = [...]` in an inline script. `data[1][1]` = items
  `[itemId, title, description, type, [[entryId, options[[label],...], required, validation...]]]`.
  Types: 0 short answer, 1 paragraph, 2 multiple choice, 3 dropdown, 4 checkboxes, 5 linear scale,
  7 grid, 8 page break / section, 9 date, 10 time, 6 text-only, 11 image, 12 video, 13 file upload.
  Each question div also carries `data-params="%.@.[itemId,"Title",null,type,[[entryId,...]]..."`.
- Markup: `form#mG61Hd[action=…/formResponse]` > `div[role=list]` >
  `div.Qr7Oae[role=listitem]` > `div[jsmodel][data-params]` > title `div[role=heading] > span.M7eMe`
  + required `span.vnumgf[aria-label="Required question"]` " *". The required legend is
  "* Indicates required question".
- Short answer: `input.whsOnd[type=text]` (date: `type=date`). Paragraph: `textarea.KHxj8b`.
  **There is no `name` attribute**. Label association is via `aria-labelledby` = heading id. Google
  JS writes the answers into hidden `input[name="entry.<entryId>"]` (and
  `entry.<id>_sentinel` for choice questions). Prefer typing (input events) into the visible field.
- Multiple choice: `div[role=radiogroup] div[role=radio][data-value][aria-checked]` inside
  `label.docssharedWizToggleLabeledContainer`. Checkboxes: `div[role=list] div[role=checkbox]
  [data-answer-value][aria-checked]`. "Other:" uses `data-value="__other_option__"` + a text input
  (`entry.<id>.other_option_response`). Dropdown: `div[role=listbox][aria-expanded]` with
  `div[role=option][data-value]` (the first is "Choose", `data-value=""`). Click it to open a popup,
  then click the option. **None of these are form controls; drive them with clicks (or
  Space/Enter on the focused role element).**
- Pages: page breaks are separate server pages. Nav buttons are `div[role=button]` with inner text
  "Next" / "Back" / "Submit" (Submit has `aria-label="Submit"`), plus "Clear form". Progress is
  `div[role=progressbar]` + "Page X of N". Hidden `pageHistory` = "0,1". **Only the current page's
  questions are in the DOM.**
- Validation: text "This is a required question" in the question's `div[role=alert]` (`.SL4Sz`).
  Custom validation messages come from the item's validation spec.
- Success: `/formResponse` page with "Your response has been recorded." (customisable) and
  "Submit another response".
- **File-upload questions and "collect verified email" forms require Google sign-in.** One of the
  four live forms tested returned 401, which means login is required. CAPTCHA: none normally
  (`data-should-execute-invisible-captcha-on-form-submit` can enable it).

## 6. Workable, `workable.html`

**Detect**: `apply.workable.com/<account>/j/<SHORTCODE>/` (posting) and `…/j/<SHORTCODE>/apply/`
(form), legacy `<account>.workable.com/jobs/<id>`. Embedded career widgets link to
apply.workable.com. Public APIs: `apply.workable.com/api/v1/widget/accounts/<account>` (jobs),
`apply.workable.com/api/v1/jobs/<SHORTCODE>/form` (**full form schema**: sections with fields
`{id,label,required,type,options,maxLength,supportedFileTypes}`; types
`text|email|phone|file|paragraph|dropdown|boolean|multiple|group|date|number`).
- Client-rendered React. Use `form[data-ui="application-form"]`, `section[data-ui="section"]`
  (h2 "Personal information" / "Profile" / "Details"), and **every control wrapper has
  `data-ui="<field id>"`**. Field ids: `firstname`, `lastname`, `email`, `headline`, `phone`,
  `address`, `resume`, `cover_letter`, `summary`, `education`/`experience` (repeatable groups with
  "+ Add", `data-ui=add-section|save-section`), `CA_<n>` (account-level questions), `QA_<n>`
  (job questions), `gdpr` (consent; only `true` is allowed).
- Boolean = segmented "Input.YesNo": `div[role=radio][id=wrapper_<…>][aria-checked]` wrapping a
  hidden `input[type=radio][value=true|false]`. Click the wrapper. Dropdown = Workable design-system
  Select, a custom listbox: click the control, then pick the option **(inferred markup)**. Multiple =
  checkbox list. Phone = country-code picker (defaults to the GeoIP country) + tel input.
- Exact inner markup of the design-system controls is **(inferred)**. Select on `[data-ui]` and on
  `input[name|id=<field id>]`.
- Resume: file dropzone (`data-ui="resume"`, hidden file input; pdf/doc/docx/odt/rtf, 12 MB). There
  is also an **"Autofill application" box** with `input#file-upload[data-ui=autofill-computer]
  [type=file][hidden]` (and Dropbox / Google Drive). It parses the resume and fills
  name/email/phone/education/experience: "Autofill completed! Please review the information we have
  filled in below."
- Submit `button[type=submit][data-ui=apply-button]` "Submit application" ("Submitting…").
  Per-field errors ("This field is required.", "This must be a valid email.", phone
  "The phone number is too short.") + banner "There are some issues with your application. Please
  revisit your data and try again." Success: "Thank you!" / "Your application has been submitted
  successfully." It may be followed by an optional EEO survey (`data-ui=eeoc-form`,
  `skip-eeoc`, `submit-eeoc`).
- **Anti-bot:** Cloudflare **Turnstile** (`isTurnstileEnabled`, hidden container), and reCAPTCHA
  strings are present too. **Login:** none.

## 7. Generic careers form, `generic-career.html`

Hand-made 3-step wizard (only the active `section.form-step` is visible), with native controls,
`label[for]`, `aria-describedby` → `span.error-message[role=alert]`, a country-code `<select>`
next to `input[type=tel]`, a resume file input hidden inside a `[role=button]` drop zone, radios,
a review step, a **required** privacy consent (`#privacyConsent`) and an **optional marketing
opt-in** (`#marketingOptIn`, which must stay unticked). It tests step navigation ("Next"/"Back"),
validation-gated steps and "don't tick optional consents".

---

## Other systems (no fixtures)

**SmartRecruiters**
- Posting: `jobs.smartrecruiters.com/<Company>/<postingId>-<slug>` (button "I'm interested").
- Apply: `jobs.smartrecruiters.com/oneclick-ui/company/<Company>/publication/<uuid>?dcr_ci=<Company>`.
  Careers: `careers.smartrecruiters.com/<Company>`. API: `api.smartrecruiters.com/v1/companies/<Company>/postings`
  (`applyUrl`).
- The apply app is an Angular SPA built from SmartRecruiters "spl-*" web components (shadow DOM:
  inputs, selects, autocomplete, phone and dropzone live inside shadow roots) **(inferred, the page
  blocked our request)**.
- Resume upload parses and prefills. Apply with LinkedIn / Indeed / SEEK.
- **Anti-bot: DataDome**. A plain GET of the apply URL returned 403 with `captcha-delivery.com`, so
  expect bot challenges.
- **Login:** none required (optional SmartProfile).

**Zoho Recruit**
- Career sites: `<company>.zohorecruit.com/jobs/Careers` or `.in` / `.eu` / `.com.au`, custom domains,
  and the `careers.zohorecruit.com/careers` portal. Job URLs are `/jobs/Careers/<numericId>/<slug>`,
  and the apply form is reached from "I'm interested" / "Apply" **(inferred path)**.
- It is a client-rendered SPA (only the HTML shell was observed).
- Resume parsing prefill, LinkedIn/Indeed import. reCAPTCHA is commonly enabled.
- **Login:** none for most portals. A "Candidate Portal" sign-in is optional, but some tenants
  force sign-in to apply.

**Keka Hire** (verified live, server-rendered)
- `<tenant>.keka.com/careers/` (list), `/careers/jobdetails/<id>` (`#apply-job` button),
  `/careers/applyjob/<id>` (form).
- Form: `form#jobApplicationForm[novalidate]` with native inputs `#firstName`, `#middleName`,
  `#lastName`, `#email`, `select#mobilePhone.countryCode` + `#mobilePhone.number`, `select#gender`,
  `currentSalary.currency` / `.amount`, `expectedSalary.currency` / `.amount`,
  `standardFields.availability.answer` (notice period in days), `standardFields.currentLocation.answer`,
  `standardFields.locationPreference.answer` (select), and `standardFields.<guid>.answer` for custom
  fields (date pickers are `readonly`, so set the value and fire `change`). Required marker is
  `span.text-danger "*"`, and errors go in `label.error`.
- Resume: `#resume-droppable` with `input#resume-upload.resume-upload[type=file]`. "This will
  auto-fill the fields below" (resume parsing).
- Consent `#candidateConsent` checkbox.
- **Image text CAPTCHA** (`img#imgCaptcha` + `input#captcha`, required). The extension must hand
  this to the user.
- Submit `#jobApplicationSubmitButton` "Apply Now" (disabled until valid).
- **Login:** none.

**Darwinbox**
- `<tenant>.darwinbox.in/ms/candidate/careers` (and `/ms/candidate/careers/<jobId>`), sometimes
  `.darwinbox.com`. Client-rendered SPA. The shell includes Cloudflare **Turnstile**.
- The apply flow usually asks for candidate sign-up / email OTP before the application form
  **(inferred)**. Treat it as login/OTP-gated.

**Freshteam**
- `<company>.freshteam.com/jobs` and `/jobs/<id>/<slug>`, with the apply form on the same page or
  under `/applicants/new`. Simple server-rendered form with resume upload and parsing, reCAPTCHA.
  **(inferred, the live probe returned 503; Freshteam is being wound down by Freshworks.)**
- **Login:** none.

**Login / account required (classify only, no fixtures)**
- **Workday** (`*.myworkdayjobs.com`, `wd1-5.myworkdaysite.com`): "Create Account / Sign In" before
  the multi-step wizard (some tenants allow "Apply Manually" but still require an account).
  Widgets use `data-automation-id`.
- **Oracle Taleo** (`*.taleo.net/careersection/...`): account required.
- **Oracle Recruiting Cloud** (`*.oraclecloud.com/hcmUI/CandidateExperience`): email + OTP.
- **SAP SuccessFactors** (`career*.successfactors.com`, `jobs.sap.com`-style RMK sites): candidate
  profile / account required.
- **iCIMS** (`careers-<co>.icims.com/jobs/<id>/.../login`): login or account (email-first) gate.
  The form is in an iframe.
- **Darwinbox** (OTP / sign-up, see above).
- **Google Forms** with file upload or verified-email collection (Google sign-in).

Login-free: Greenhouse (new and classic), Lever, Ashby, Workable, SmartRecruiters, Keka,
Freshteam, most Zoho Recruit portals, Google Forms without file upload.

## CAPTCHA summary

| System | Mechanism | Visible? |
|---|---|---|
| Greenhouse | reCAPTCHA Enterprise, invisible | rarely |
| Lever | hCaptcha, invisible, run on submit | can escalate to a challenge |
| Ashby | reCAPTCHA v3 score + fingerprint | no, but can hard-block the submit |
| Workable | Cloudflare Turnstile (+ reCAPTCHA) | sometimes |
| SmartRecruiters | DataDome bot protection | yes, on suspicion |
| Keka | image text CAPTCHA | **always** |
| Darwinbox | Cloudflare Turnstile | sometimes |
| Google Forms | none by default | no |
