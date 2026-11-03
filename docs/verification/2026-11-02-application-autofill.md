# Application autofill verification — 2 November 2026

The Infosys failure was traced to the application's saved run errors and the live survey DOM. The supplied message contained several concatenated URLs; the ten additional links were separated before inspection.

## Fixes

- Target the actual input when a survey repeats its numeric ID on a wrapper.
- Handle photo uploads that open an editor with a hidden file input and a Done button; keep the native resume upload separate.
- Read non-editable Material dropdowns and scope their options to the opened dropdown. An empty Post Office dropdown must not inherit the passport YES/NO chips.
- Read Microsoft Forms question headings and required markers, and Cisco radio-group labels, instead of option text or hidden helper instructions.
- Choose the primary Apply entry before related-job Apply links.
- Fill known answers before pausing for missing personal details; rescan conditional questions and pincode-dependent dropdowns before advancing. Avoid repeating unchanged uploads during rescans.
- Prefer unambiguous ISO dates and restore readonly on date-picker controls so they retain their identity when the form is reread.
- Refresh obsolete profile-derived answers and reject reuse when a question changes. Compare conformed option values so an approved YES/NO answer does not become perpetually new.
- Distinguish country phone codes, national phone inputs and alternate contacts. Do not copy the primary number into an unknown alternate-contact field.

## Live inspection

| Site / supplied job | Observed result | Verification extent |
| --- | --- | --- |
| [Infosys registration](https://surveys.infosysapps.com/r/a/SPDSEoffcampusregistration) | Privacy declaration, name/email screen, then an 89-question application | Opened the personal-details screen with synthetic data and outbound POSTs blocked. Name, email, phone, DOB, citizenship and address filled without fill errors; pincode populated state/district/city. Inspected the real photo editor. Later fresh-browser attempts redirected to the site homepage, so the final live submission was not verified. |
| [Amazon 10541345](https://www.amazon.jobs/en/jobs/10541345/sde-i-intern-amazon-university-talent-acquisition) | Active job page; Apply leads to Amazon Passport | Login/account creation required; inspected without signing in. |
| [Zelis JR111894](https://careers.zelis.com/us/en/job/ZOBZDHUSJR111894EXTERNALENUS/Associate-Software-Engineer) | HTTP 410; page says the job has been filled | No application form available. |
| [EY Yello](https://eyglobal.yello.co/jobs/yZimmWg4kDLz6r3kMgWfWw?job_board_id=c1riT--B2O-KySgYWsZO1Q) | Associate Analyst posting; Apply opens Create Account or Login | Inspected account page; no account created. |
| [Google Form](https://docs.google.com/forms/d/e/1FAIpQLScozpPy2RAvyLIKQ0Fa_Un-R7uINAlowipQg2NlNurx7yvc_g/viewform) | Redirects to Google sign-in | Questions behind login were not inspected. |
| [UnitedHealth Group](https://careers.unitedhealthgroup.com/job/-/-/34088/102486143680) | Software Engineer 2391178; Apply opens Taleo login | Login required; no credentials entered. |
| [Canonical Greenhouse 8249005](https://job-boards.greenhouse.io/canonical/jobs/8249005) | Active Graduate Software Engineer application | Read visible application fields, choices and native resume control; no answers submitted. |
| [Salesforce JR356515](https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/India---Hyderabad/Associate-Technical-Support-Engineer_JR356515) | Workday says the page does not exist | No application form available at this URL. |
| [Cisco 2015025](https://careers.cisco.com/global/en/job/CISCISGLOBAL2015025EXTERNALENGLOBAL/Software-Engineer) | Active job and personal-information application screen | Inspected resume, name, address, phone, prior-employment radio and consent controls. Related-job selection and label regressions reproduced in local browser tests. |
| [Amazon 10454438](https://www.amazon.jobs/en/jobs/10454438/software-dev-engineer-i-amazon-university-talent-acquisition) | Active job page with Amazon application entry | Same Amazon Passport login boundary; no sign-in performed. |
| [Revature Junior Trainer](https://www.revature.com/revature-junior-trainer-candidature-confirmation-form) | Embedded Microsoft Form, six required questions | Opened the embedded form directly and inspected text/radio controls. Heading and required-radio extraction covered by browser regression tests. |

These are observations from this session, not a guarantee that external vacancies or forms remain available. No final application was sent. Unknown personal facts, login/OTP, and employer-side upload/submission validation still require the candidate or a subsequent authenticated run.

## Checks

Browser regressions run against local controlled forms in installed Chrome, including a complete local multi-page fill/submit round trip. Live inspection is separate from these automated regression tests.

Initial results: **13 test files passed, 207 tests passed** with two workers; all workspace TypeScript checks passed; ESLint passed for `apps/worker/src/apply`.

```powershell
npm test --script-shell=C:\Windows\System32\cmd.exe '--' --maxWorkers=2
npm run typecheck --script-shell=C:\Windows\System32\cmd.exe
node node_modules/eslint/bin/eslint.js apps/worker/src/apply
```

Independent review found an approval-loop regression in raw-versus-conformed profile-answer comparisons. It was reproduced with a failing test and fixed before final validation.

Earlier verification runs exposed timing limits: the new native-upload browser test exceeded Vitest's default five-second timeout, and Chrome shutdown exceeded the default hook timeout while browser suites overlapped. Those browser operations now have explicit bounded timeouts. A later unrestricted parallel full-suite run timed out in the unchanged `gmailApiIdFromImap` test (`converts IMAP X-GM-MSGID (decimal) to the Gmail API id (hex)`) during its asynchronous module import. The final full-suite command limits workers to two; Gmail production/test code was not changed.

To retry a previously failed application, use **Applications → Start again** after the worker has reloaded. Newly detected required questions such as Post Office must be answered when prompted.

## Follow-up: second-page stall

The user reported that the form still stopped after page two. The latest stored run showed `The form kept changing while filling`, rather than a failed Next click.

After the user explicitly authorized transmitting the saved application details, photo and resume to Infosys for a test without final submission, a live diagnostic reproduced the cause:

1. Selecting a gender changed its icon. The icon-based scanner dropped the selected option on its next pass.
2. Substring option matching treated `MALE` as matching `FEMALE` (and the reverse).
3. Subsequent scans alternated the selected answer until the five-pass stability limit stopped the form.

Choice extraction now uses the structural option containers, preserves selected choices, and matches complete option phrases. Derived saved answers are checked against their current canonical saved fact so an old incorrect match is not replayed. Temporary search inputs inside dropdown panels are excluded from application questions.

The repaired live diagnostic **advanced from the personal-details page to page three, Education**, then stopped for missing academic answers. A real worker retry also reached page three and exposed a separate already-open Degree dropdown being toggled closed. Dropdown reading/filling now respects `aria-expanded`, and the reader closes non-editable panels after inspection. This behavior has a browser regression test.

Further live retries exposed virtualized dropdown windows: a currently rendered sample could omit an existing saved Post Office, state, board or branch. Searchable panels are now identified explicitly; the candidate value is typed into the panel's own search field using keyboard events, and selection waits for the exact filtered result. The search row itself is excluded from selectable options. Changing rendered samples do not count as new application questions. Searchable answers retain their full text instead of being shortened to a different degree in the initial sample. Country-code lookup searches the country name while verifying the full displayed code label, and already-correct selections are left unchanged.

No final application was submitted. Third-page academic information still needs the candidate's review and any missing facts; reaching that page does not establish completion of the entire 89-question application.

## Follow-up: education page (page 3)

The user reported the Infosys form still did not fill. The stored run stopped on page 3 with `option "University Institute of Technology, Sample University, Indore" not found`. Live inspection of the page (filled, never submitted) showed:

1. Questions repeat per section (X/SSLC, XII Standard, Graduation, Post Graduation) and nothing recorded the section, so X received XII marks, Post Graduation received graduation data, and the graduation University was a guessed sample option.
2. The X "Degree" radio inside a multi-question card, and the "XII Standard / Diploma" multi-select list, were not extracted.
3. Material dropdown labels included their own selected value (Country read as "India").
4. Infosys names options differently from the profile: `University Institute Of Technology, Sample University`, `Computer Science Engineering`, `Bachelor of Technology` (a "B.Tech" search returns nothing), `Madhya Pradesh Board` (an "MP" search returns unrelated boards).
5. The month-year picker accepts only `MM/YYYY`. Other formats display `01/2026`, or `01/2006` for `01/06/2019`, and the old check accepted any non-empty value.
6. In a real worker run, typing one search letter at a time let a late result for an earlier prefix reuse list elements, and a different college was clicked.

## Fixes

- Fields carry their section heading. Remembered answers in education sections are keyed by section, and the dashboard shows the section.
- X / XII / graduation questions are answered from the profile's education entries (`level`, `board`, `university`, `state`, `country`, `end` as `YYYY` or `YYYY-MM`). A section the profile lacks stays empty; missing facts are asked, not guessed.
- Option matching normalises abbreviations and wording, and accepts an option only when it clearly beats the alternatives. Searchable dropdowns try narrower queries, send each query as one search, click the matched option in one in-page step, and check that the Material select shows it, choosing again otherwise.
- Date pickers accept month-year answers and must show the requested date.

The real worker prepare run (`submit: false`) now fills page 3 and stops with `needs_input` for seven facts absent from the profile: X specialization, XII stream, three passing months, active backlogs and education gaps. No application was submitted. Pages after page 3 were not reached, since they require those answers.

Checks: 14 test files, 257 tests passed (`--maxWorkers=2`); TypeScript passed for all workspaces; ESLint passed for the changed paths.
