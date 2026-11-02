**October feedback implementation plan — A04, 27 October 2026**

This document records the October 14, 20 and 21 feedback audit and the implementation approved on 27 October, including the later decision to resolve the CK IDs and integrate the supplied content into new-study defaults. Application changes are in the local working tree. Existing uncommitted work was preserved. Verification used disposable Postgres databases and Chromium; no deployed application or existing study's participant data or instrument ordering was changed.

The supplied CSV is the content snapshot used here. The linked Google Sheet could not be read through the available web tool, so differences from the live sheet remain unverified. Statements in the CSV are instrument requirements to reconcile with the user's request, not instructions to execute independently.

**Implementation status — 27 October**

| Area | Result in the working tree |
| --- | --- |
| Questionnaire engine | Existing controls extended with the five-entry cap, compound debugging answers, ranking, multiple-answer checkboxes (`multi_select`), exact blank lines and multiple code files. Existing single-choice answers retain their semantics. Matching frontend/backend definition and answer validation. |
| Admin editing | Existing page editor supports editing, preview, section function and intro text; pre-test case intro has separate editable wording. Structural/answer-semantic edits are blocked after a run starts. |
| CK flow | Persisted seven-minute deadline, supervisor-only progression convention, Ctrl/Cmd+Alt+Shift+N confirmation, partial save, atomic answer-and-progress writes, retry recovery and original timing preserved during review. No automatic redirect at zero. |
| Timing and exports | Section attempts and page visits persisted; original submission snapshots and review flags retained. Existing responses/sections exports extended; skipped tasks have no fabricated visits or answers. |
| Source content | CK IDs are approved: later CSV rows 25/26 become ck_pre_08/ck_pre_10; the first 12/13 and source order remain. New-study defaults include the thirteen tasks with the supplied CK intro and the shared PCK example. The guarded CK import uses this mapping by default, accepts an optional explicit override and refuses started studies. Existing studies are unchanged. All 24 default questionnaire pages are verified against the real API in Chromium. |
| Layout | All 24 default pre-test pages and the full participant walkthrough fit the tested 1920×1080 viewport, including five CK entries and conditional demographic fields. Existing demographic/matrix and post-case pages use compact/wider layouts without new page boundaries or reordered questions. Smaller lab viewports remain to be confirmed. |
| Downloads | Native stimulus and raw screen-recording downloads in the admin, with short-lived scoped local tokens or GCS attachment URLs and explicit missing-file errors. |
| Operations | Backup uses the actual Compose media mount and fails when expected media is absent; supervisor/timing/import guidance added to the existing operations docs. |
| Existing gaze, AOIs, Statistics Details and capture | Existing implementations retained; regression/browser verification extended rather than adding parallel implementations. |

The CK ID decision and integration of the supplied PCK example are no longer blocked on researcher input. PCK wording/code remain verbatim; source notes about a closing brace and the referenced pupil explanation are retained for author review without blocking loading. Still pending are any additional PCK items or intro wording, the actual monitor/scaling/zoom, hosting/storage capacity and a lab-hardware rehearsal. Existing self-assessment variable IDs are retained; no historical response keys were renamed. The reported historical Study 8 / TN-4P7VW recording still needs inspection in the deployed storage; passing current export tests does not recover or establish the existence of missing historical samples.

Local rollout: the local development database was backed up and migration `d9f1a3b5c7e2` applied. Created inactive **study 5, “A04 Oktober 2026 – Entwurf”**, containing 24 pre-test questionnaires, two section intros and the existing diagnosis/outro batteries. It has no participant runs. Its video cases and SoSci links still need study setup before activation. The existing pilot's 14 questionnaire rows, 11 session pointers and 119 responses matched their pre-migration snapshots. No hosted deployment was changed.

The baseline gap analysis and work packages below explain the scope and decisions. Their “present/missing” labels describe the pre-implementation audit; the table above records the implemented state.

**Verification completed locally after content integration**

These checks include the approved mapping, new-study defaults, import idempotence, started-study protection, multiple-answer questions and the real-browser default-study flow.

- Backend: **613 tests verified**, **78.52% coverage** against disposable Postgres. The full run passed 612; one old fixture inserted an unrelated page into the newly populated CK block. After moving that fixture outside the block, all 16 tests in its admin module passed. Ruff, format and mypy passed. Fresh migration application and `alembic check` passed; the backed-up local database also matches the models. The suite's Python 3.11 Google SDK retirement notice has a narrow warning filter; other warnings still fail tests.
- Frontend: **292 unit/component tests passed**. Typecheck and build passed. ESLint has zero errors and the existing two Fast Refresh warnings; Vite reports a large-bundle advisory.
- Chromium: **21 feedback browser tests plus 5 real-backend E2E tests passed**. Every CK page checks the exact code and displayed line numbers, five-field cap, visible Continue control and lack of viewport/code overflow. All 24 default pre-test pages, including supplied PCK and conditional demographics, and a complete two-case participant run were captured and inspected. Unanswered and answered post-case forms are both checked. Admin editing/previews, multiple-answer and single-choice controls, intro overrides, downloads and Statistics Details are exercised. The real response export preserves distinct numeric/string choices as `[1, "1"]`.
- Timing/recovery: real Postgres/browser checks verify the persisted deadline after reload, partial supervisor exit, PCK ranking and exported timestamps/answers; skipped pages are absent. Browser failure injection verifies immutable finish retries, recovery after three lost answer acknowledgements and mutual exclusion of supervisor dialogs.
- AOIs/capture: new CK code/answer/timer rectangles match uploaded geometry, adding/removing fields preserves historical layouts, and supervisor dialogs exclude underlying AOIs. Existing real MediaRecorder encoding with a synthetic display stream and concurrent gaze passes. These tests do not establish physical Tobii accuracy or OS display-picker permissions.
- Backup: four isolated source-selection/failure tests and shell syntax check passed. This does not replace a restore rehearsal against the selected deployment.

Browser screenshots and geometry artifacts are under `frontend/test-results/feedback/` and `frontend/test-results/session-e2e/` (generated, not committed). Repeat with `npm run test:browser` and `npm run e2e`; see [`frontend/e2e/README.md`](../frontend/e2e/README.md) for the separate database and admin setup. No new npm or Python package was required for this implementation.

**Agreed direction and open decisions**

The user confirmed a **seven-minute timer with supervisor-controlled progression**. Reaching zero must not automatically redirect the participant. The proposed shortcut is Ctrl+Alt+Shift+N, with the same platform handling as the existing back shortcut; verify the chord on the actual lab machines.

The user confirmed **a maximum of five error-line entries per new CK debugging task**. This decision supersedes the earlier unlimited-entry request and the audit's recommendation to leave the cap unresolved. Reuse the existing line-number control, set max_entries to 5 for these tasks, prevent a sixth field and enforce the same cap on the backend. Keep unrelated existing questions and historical responses compatible; never truncate saved answers silently.

Preserve all thirteen CK task rows and their source order. The user approved retaining the first ck_pre_12 and ck_pre_13 (CSV rows 15 and 16) and mapping the later duplicates on rows 25 and 26 to ck_pre_08 and ck_pre_10. The resulting task order is 01,12,13,07,02,03,04,05,06,09,11,08,10. Store that explicit decision in the manifest while retaining original row/variable provenance; do not sort, merge or discard tasks. This changes the new instrument's identities, not historical response keys.

| Decision still needed | Why it affects implementation | Proposed handling |
| --- | --- | --- |
| CK response/export shape and self-assessment IDs | CSV combines line array, explanation and timestamps under one variable, and renames existing self-assessment variables | Approve a versioned data dictionary; preserve historical keys |
| PCK author notes and future content | One code brace and the referenced pupil explanation appear missing; more items were promised | Load the supplied example verbatim now; retain author-review notes and add later supplied items through the admin |
| Target display | “No scrolling” depends on usable viewport, scaling and content | Obtain resolution, OS scaling, browser zoom, fullscreen policy and display arrangement from Vivian/Viviane |
| Recording/download scope | “Videos” may mean stimuli, captured screens, or replay with gaze overlay | Plan stimulus and raw screen downloads; confirm any audio, whole-session capture or rendered gaze-overlay requirement |
| Hosting and ownership | Actual LRZ quota, free space, bandwidth and backup setup are unknown | Select and rehearse one supported deployment before the pilot |

**What is already implemented**

“Present” means source and relevant tests exist; tests were not run in this planning audit, and deployed behavior still needs verification.

| Feedback | Current state | Remaining action |
| --- | --- | --- |
| Statistics → participant Details does not work | Present: panel scroll/focus behavior handles opening, repeated selection and loading | Run existing regression and check the deployed build |
| Gaze CSV contains only six rows | Present: gaze.csv now streams raw samples; gaze_recordings.csv holds recording metadata | Investigate study 8 / TN-4P7VW against the deployed version, counts and actual raw chunks |
| AOIs must appear in gaze.csv | Present: raw samples include geometry references, derived coordinates, AOI and mapping status | Validate with real lab data and preserve unmapped historical samples |
| AOIs are static | Present: timestamped geometry observes layout, visibility, resize, scroll and modal changes | Extend coverage for new questionnaire controls and changed layouts |
| Laptop screen recording alongside the task | Present for case-video screens, independent of gaze, using bridge or browser capture | Rehearse actual laptop/browser/hosting path; broader recording scope is unconfirmed |
| Add another error-line field with a plus button | Present, including removal, validation and restoration; currently unlimited | Extend the existing control/validators with the confirmed five-entry cap for new CK tasks |
| Page and whole-section timing | Partial: page-entry/submission events and submitted-response duration totals exist | Add forced exits, persistent section timing and reliable visit semantics |
| Editable pre-test video introduction | Partial: title/body are editable, but shared across all case phases | Add a pre-test-specific override with existing generic fallback |
| Editable introduction before each pre-test section | Missing as a distinct page type; empty questionnaires are skipped | Add explicit section intro steps |
| CK task content | None of the thirteen supplied tasks is seeded | Import approved content with exact code layout |
| PCK example and future items | Empty placeholder; ratings/free text/single-choice exist | Add example, ranking support and full admin editing |
| Admin video download | Missing as an explicit action | Add stimulus and screen-recording downloads |
| No participant scrolling | Not generally satisfied; code, side panels and long forms can scroll | Validate and adapt the actual content to the agreed viewport |
| Maintenance documentation | Substantial deployment/operations baseline exists | Complete a tested, host-specific handover and repair backup handling |

Evidence: [raw export](../backend/app/api/admin/exports.py), [raw gaze reader](../backend/app/services/gaze_export.py), [AOI collection](../frontend/src/lib/aoi.ts), [statistics panel](../frontend/src/components/admin/StatsSection.tsx), [screen capture](../frontend/src/hooks/useScreenRecording.ts), [questionnaire renderer](../frontend/src/components/session/QuestionnaireRenderer.tsx).

**Implementation boundaries — extend existing paths once**

Before each package, recheck the current code and selected study configuration. Treat existing regression tests as the baseline; implement only a demonstrated gap. An old feedback item does not authorize rebuilding a feature already present. A failed deployment check first needs diagnosis: it may require deploying existing code or applying an existing migration rather than writing another implementation.

| Area | Work classification and boundary |
| --- | --- |
| Raw gaze CSV, AOI export/geometry, Statistics Details, per-case laptop capture | Verification only unless a reproducible defect is found; reuse current exports, geometry pipeline, panel and recorders |
| Error-line input | Extend existing component/validators with max_entries=5 for new CK tasks; retain existing plus/removal/focus/range/restoration logic |
| Questionnaire types/admin editor | Reuse existing renderer, PATCH endpoints and preview; add only missing answer shapes/types and existing-page editing controls |
| Page events, response durations and section export | Extend existing timing/outbox/export paths for timed CK and forced exit; no parallel event logger or duplicate CSV implementation |
| Case introductions | Extend existing StudyTexts and case-intro screen with a pre-test override; create explicit steps only for currently missing section intros |
| Maintenance and hosting | Extend existing runbooks/storage paths; add LRZ production support only if that route is selected |

Package 3 owns the persisted CK deadline, finish endpoint and transition. Package 4 owns visit timing and reporting and integrates with that same endpoint; it must not introduce a second timer or skip workflow. Package 5 owns layout adaptations; the AOI checks in package 6 verify the existing geometry collector against them.

**Work package 1 — Reconcile the instrument and define a safe update path**

Owner: researchers for content approval; developer for manifest, validation and import.

The CSV contains nine CK self-assessment variables, thirteen debugging task rows, and three PCK subquestions belonging to one shared example. Its MSK heading supplies no replacement instrument; retain the existing seven MSK scenarios and demographics unless a replacement is approved.

The target section sequence is supported by two independent pieces of supplied feedback: the explicit request to jump from CK to the start of PCK, and the CSV headings numbered 1 CK self-assessment, 2 CK tasks, 3 PCK, 4 MSK. This supports the relative section order; it does not authorize sorting individual CK tasks by ID.

The original defaults seeded demographics → empty PCK placeholder → CK self-assessment → CK debugging self-assessment → MSK, with PCK skipped. The approved new-study defaults replace that placeholder workflow with the complete supplied content. Actual existing studies continue to use their stored questionnaire order_index and ID. Do not apply a blanket reorder or content migration to existing studies or started runs.

New-study instrument sequence: demographics → the two existing CK self-assessment pages → supplied CK debugging intro → thirteen CK task pages in source order → editable PCK intro → shared PCK example → seven existing MSK pages → existing SoSci handoff and case flow. This is 24 populated pre-test questionnaire pages plus two intros. The initial PCK intro reuses the existing generic “Bitte beantworten Sie die folgenden Fragen.” wording; researchers can replace it and add future PCK pages or other section intros. No missing instrument content is invented. Preserve the order of questions within existing batteries. The seven-minute limit applies to the debugging tasks only, excluding self-assessment and intro reading.

Source decisions and retained author notes:

| CSV evidence | Interpretation and required action |
| --- | --- |
| Row 15: ck_pre_12, x/y assignment, 8 code lines, expected error line 6; row 25: ck_pre_12, outputs 10/21, 20 lines, expected error line 18 | Resolved: keep row 15 as ck_pre_12 and map row 25 to ck_pre_08 |
| Row 16: ck_pre_13, cinema ticket, expected line 11; row 26: ck_pre_13, superheroes, expected line 7 | Resolved: keep row 16 as ck_pre_13 and map row 26 to ck_pre_10 |
| No ck_pre_08 or ck_pre_10 in the original CSV; source order is 01,12,13,07,02,03,04,05,06,09,11,12,13 | Apply the approved row mapping without changing source order; retain original variables as provenance |
| All thirteen rows say “1–5 numbers,” “max. 5 entries,” and “bis zu fünf Zeilenangaben” | Resolved by the user: enforce maximum five answer entries per new CK task, independently of code length |
| Self-assessment IDs change from ck_pre_* to ck_pre_self_* | Retain the established self-assessment IDs; a future analysis dictionary can document aliases without rewriting answers |
| Self-assessment rows reference external CK option sheets and call the type “Boolean” | Retain the existing seven-level single-choice scales; do not reinterpret them as Boolean questions |
| ck_pre_07 starts with an intentionally empty line 1 | Preserve it; the implemented source-block renderer retains blank edges and line references |
| ck_pre_09 contains Königsland.java and Drache.java | Show two labeled code blocks, numbered 1–14 and 15–29 |
| pck_pre_01a–c share a stimulus; part b is ordering | Preserve their explicit subquestion IDs on one questionnaire page by default. Entry timing appears on part a and exit timing on part c; use one visit interval. Splitting the page needs researcher agreement |
| PCK code appears to lack a closing class brace; part a refers to an absent pupil explanation | Keep the supplied example verbatim under pck_example; retain these as nonblocking author-review notes without inventing text or correcting code |
| CK columns 12–14 contain expected line, solution and rationale | Keep researcher-only material out of participant payloads; automated scoring is not requested |

Create a checked content manifest that separates participant stimulus/response definitions from researcher answer keys. Normalize CSV line-break encoding to plain text, preserving blank lines, indentation, Unicode and intentional bugs. Validate unique item identities, page order and displayed line bounds.

Implemented CK answer contract: the approved ck_pre_XX variable holds a compound answer containing a line-number array and explanation. Page visits/timestamps are associated metadata, not guessed question-ID suffixes. The compound question reuses the line-number input and text field. Normal submission validates both required components; a nonempty object alone is not a complete answer. Supervisor exit preserves incomplete components with explicit partial status, validating supplied values. The existing responses export carries this structured value; the analyst-facing dictionary should document the approved IDs and this shape.

Changing study_content.py does not update existing studies. seed_batteries skips the entire pre-test placement when any pre-test page already exists. The guarded CK importer previews by default, uses the approved mapping unless explicitly overridden, and reports conflicts. It requires a selected nonempty PCK page after self-assessment and inserts the CK block before it; it does not replace PCK or overwrite researcher edits. Ordinary new-study creation supplies the full instrument and does not need this import step.

For the immediate rollout, use a new study version or an explicitly selected study with no started sessions. Add transactional guards against structural and answer-semantic changes to studies with started runs: page insertion/deletion/reordering, empty-to-nonempty transitions, question IDs/types/membership, option meanings and code content/line numbering. Coordinate with the study-row lock used by first-login assignment, then recheck started runs to prevent a login/import race. Scripts currently reread live questionnaires, so structural changes can move saved pointers; semantic changes can invalidate older answers even without moving a pointer. A later requirement to make these changes within the same running study needs instrument versioning or an explicit data/pointer migration. Preserve established live wording corrections, assigned video sequences and pinned training batching.

Acceptance: all approved tasks import once; no participant receives answer keys; duplicate mappings fail clearly; repeat import does not duplicate pages; existing answers and session pointers remain intact.

Touchpoints: [standard content](../backend/app/services/study_content.py), [admin questionnaire API](../backend/app/api/admin/questionnaires.py), [session script](../backend/app/services/session_script.py), Alembic for any new persisted fields/tables.

**Work package 2 — Complete the questionnaire engine and admin editing**

Owner: developer; researchers review the participant previews.

Reuse the current ratings, free text, line-number input and single-choice controls. The existing type named multiple_choice renders radio buttons: it does not provide true multi-select or ordering.

Implement:

- A compound CK debugging question as described above, using existing controls and consistent frontend/backend validation.
- Explicit code stimulus blocks with optional filenames/start lines and preserved blank lines. Avoid altering historical code rendering/numbering unintentionally.
- Ranking for pck_pre_01b with stable option IDs, stored as an ordered array. Validate a complete permutation with no duplicates or unknown options. Provide keyboard-operable move controls and distinguish an untouched initial list from a submitted ranking.
- A separate multi-select type if the forthcoming PCK questions require selecting several answers; do not change existing radio semantics.
- Add optional max_entries to the existing line-number contract and set it to 5 on every new CK task. Disable/hide addition at five fields, allow removal/re-addition, and reject more than five entries in both existing validators. Existing min/max still bound the line numbers, not the entry count. Retain legacy scalar-answer compatibility and unchanged behavior for unrelated questions without max_entries. Do not build a second plus-button component.
- A complete editor for existing page title, description, content, order and section, with preview and validation. Existing API patches already support these fields; the UI currently offers creation/deletion, section edits and limited code-question conversion.
- Researcher-friendly presets for debugging, ranking, text, single/multi-select and ratings. Reuse the current JSON/preview infrastructure rather than building a new form-builder platform.
- Safe add/remove/reorder behavior for future PCK pages, constrained by the started-run protection from package 1. Deleting response-bearing content must not be the ordinary “edit” workflow.
- Participant-scoped draft restoration for new CK/PCK controls, with correct cache/draft clearing on submission and participant handover.

Acceptance: researchers can add the forthcoming PCK questions and edit an existing example without a deploy. Preview matches participant rendering. Responses survive reload/back/resubmission. Each new CK task accepts up to five error-line entries, cannot add a sixth, and rejects a forged six-entry request; removing one permits adding another. Blank line 1 and both file boundaries are exact. Existing question types, conditional visibility, uncapped unrelated questions and scalar line answers remain compatible.

Touchpoints: [question contracts](../frontend/src/lib/questionnaire.ts), [backend validation](../backend/app/services/questionnaires.py), [admin schemas](../backend/app/schemas/admin.py), [renderer](../frontend/src/components/session/QuestionnaireRenderer.tsx), [code normalization](../frontend/src/lib/code.ts), [admin editor](../frontend/src/components/admin/QuestionnairesSection.tsx).

**Work package 3 — Add editable intros, CK timer and supervisor finish**

Owner: developer; researchers approve instrument order and intro wording.

Add a stable machine identifier for the timed CK task section, separate from the editable section label. Existing CK self-assessment pages already share “CK-Pretest”; do not identify timed pages by that label or by title text.

Represent section introductions explicitly in study configuration and the server step script. Empty unfinished questionnaires must continue to be skipped. Update build_steps, count_steps, frontend SessionStep types, screen switching, progress descriptions and admin counts together.

Seed this supplied CK introduction as editable study-owned text:

> Im folgenden Abschnitt bearbeiten Sie verschiedene Debugging-Aufgaben. Auf jeder Seite sehen Sie ein Programm mit einem Fehler. Geben Sie an, in welcher Zeile sich der Fehler befindet, und beschreiben Sie kurz, worin der Fehler besteht. Klicken Sie anschließend auf „Weiter“, um zur nächsten Aufgabe zu gelangen.
>
> Für diesen Abschnitt haben Sie **7 Minuten Zeit**. Es gibt bewusst mehr Aufgaben, als Sie in dieser Zeit voraussichtlich bearbeiten können. Sie müssen also nicht alle Aufgaben lösen. Wir möchten einen Eindruck davon gewinnen, wie Sie Fehler in Programmen erkennen und beschreiben. Bearbeiten Sie die Aufgaben daher in Ihrem eigenen Tempo und so sorgfältig wie möglich.
>
> Sobald die 7 Minuten abgelaufen sind, geben wir Ihnen Bescheid und leiten Sie zum nächsten Abschnitt weiter.

The final paragraph describes the supervisor's intervention under the confirmed manual policy. Make that operation clear in the supervisor runbook. The current StudyText renderer does not parse inline bold; implement safe emphasis or an explicit time-limit callout so literal asterisks do not appear.

Timer and transition behavior:

- Begin one persisted 420-second deadline when the first CK task starts; intro reading is excluded.
- Restore the same deadline after refresh/reconnect or stepping back within CK. Display remaining time; at zero indicate expiry without automatic navigation.
- Record actual exit time, including any supervisor delay beyond 420 seconds. Do not clamp measured duration to seven minutes or claim automatic enforcement.
- Ctrl+Alt+Shift+N opens a confirmation naming CK and the target PCK intro/first page. It operates from CK task pages only and does nothing outside that section.
- Add a separate participant-authenticated endpoint following the existing supervisor-back convention. It validates the current timed section and resolves the next PCK step server-side. A missing destination produces a configuration error, not an arbitrary jump.
- This mirrors the existing hidden supervisor control; a key combination is not proof of administrator identity. A separate admin credential/PIN gate would be additional scope if required.
- Save the current page's partial answer and exit timing even when its normal required fields are incomplete. Close its gaze capture and move the pointer only after a successful transition.
- Lock/check the current session and expected visit/step, and make repeated finish requests idempotent. Handle a simultaneous normal submission and supervisor finish without double advancement.
- Unvisited CK pages receive no responses, entry/exit events or fabricated timestamps. A section-finish event may list skipped IDs; reporting must not confuse “pointer passed this page” with “answered.”
- Completing all CK tasks early advances naturally into PCK. Proposed policy for supervisor back into a finished CK section: allow review/restoration without resetting its deadline or silently starting a second timed attempt. Freeze the original attempt's start, deadline, exit and overrun; record later visits as post-completion review. Any answer replacement must remain auditable and must not change the original timed duration.

Also add editable intro title/body per pre-test section and a pre-test-case override for the existing case-intro screen shown in the screenshot. Use the existing generic title/body as fallback for training/post-test and studies without overrides. Preserve researcher-authored German wording; translate interface controls in de.json and en.json.

Acceptance: finish works from every CK task and nowhere else; zero never auto-advances; reload/back does not reset time; early completion works; stale/repeated requests do not skip PCK; failure retains drafts; intro counts match the real script.

Touchpoints: [participant flow](../backend/app/api/participant.py), [session script](../backend/app/services/session_script.py), [SessionPage](../frontend/src/pages/SessionPage.tsx), participant API/hooks, StudyTexts schema and admin Details editor.

**Work package 4 — Make page/section timing trustworthy and exportable**

Owner: developer; analyst approves definitions.

Current page-enter and page-submitted events use the browser clock. Current sections.csv and admin statistics sum saved response durations. Those totals omit an interrupted unanswered page, and replacement submissions overwrite stored response time. Response created_at is not the latest visit's entry/exit time.

Persist section timing state and page-visit identity with client entry/exit epoch milliseconds, exit reason, questionnaire/item identity and step identity. Keep this change focused on the new pre-test flow; reconstructing historical or application-wide visits is not a rollout dependency. Keep the timer deadline separate from the browser-clock evidence used for research alignment. An incomplete visit must remain visibly incomplete rather than acquire an invented close time.

Define and expose separately: actual CK section elapsed time; accumulated visited-page time; per-visit entry/exit and exit reason; answered/visited counts; and deadline overrun. A revisit should retain its visit history even when the latest answer replaces the prior answer.

Keep interaction logging on the existing participant outbox path. Persist the critical forced-exit state, partial answer and pointer atomically; identify retries so response/visit writes cannot duplicate. Record unload/reload transitions best-effort and document missing exit evidence, rather than treating database insertion time as the participant's action time.

Extend events.csv, sections.csv, responses.csv metadata and corresponding statistics as needed while preserving existing column meanings. Do not silently redefine the current sum of response durations as wall-clock elapsed time. Add columns or explicitly version the export contract. Historical records get unknown/null for unavailable timing, not reconstructed precision.

Acceptance: a timed run that answers two tasks, partially attempts a third, then skips has visits for exactly those three tasks; later tasks have none. The third task contributes observed time, revisits remain distinguishable, and current answers/export variables remain correct. Cover failed saves, lost acknowledgements, reloads and handover.

**Work package 5 — Meet the no-scroll requirement on the actual study setup**

Owner: developer and lab team.

Obtain physical display arrangement, resolution, OS scaling, browser version/zoom, fullscreen policy and usable CSS viewport. Screen dimensions alone are insufficient. Clarify whether “no scroll” includes code panes, dialogs and the external SoSci pages; plan for all A04 task content and controls to fit without required scrolling on the agreed setup.

Audit every participant screen with real content, including the nine-item self-assessment, existing MSK pages, PCK shared stimulus and all subquestions, 29-line two-file CK task, long code lines, added error-line fields, validation messages, diagnosis, dialogs and browser sharing UI.

Use available horizontal space, paired code/answer regions, compact but readable spacing, and side-by-side files where appropriate. Do not hide overflow, remove content or shrink text until it becomes hard to read. Splitting an instrument page changes timing and presentation, so obtain research agreement before changing page boundaries. Test the CK layout with all five allowed error-line fields visible alongside the explanation, code and validation messages.

If a laptop's viewport cannot fit the approved instrument, identify it as unsupported for that protocol or approve an alternative layout. Treat SoSci layout as a separate configured survey that must also be rehearsed.

Add browser checks for content and control visibility, horizontal/vertical overflow, focus visibility and modal states at supported viewports. Verify AOI geometry after every layout change; do not substitute static rectangles.

Acceptance: a supervisor completes the real study flow on the intended display without scrolling to reach required content or controls. Synthetic screenshots/DOM assertions supplement this manual rehearsal.

**Work package 6 — Add downloads and verify existing fixes**

Owner: developer and lab operator.

The implementation work here is the missing download actions and their delivery endpoints. Gaze export, AOI collection, Statistics Details and screen capture already exist: the checks below validate them and trigger targeted fixes only for reproduced failures. Do not recreate those features or duplicate their test suites.

For study 8 / TN-4P7VW, inspect the deployed revision, relevant migration, recording sample counters and all available raw chunks, then re-export with the participant filter. Compare actual exported rows with committed sample counts. Six recording-metadata rows are a plausible explanation of the old complaint, not an established diagnosis. Missing original data cannot be recreated.

Validate existing gaze export behavior: complete native samples, per-recording storage mode, chunk continuity/count checks, correct filtering, and explicit failure for missing storage. Historical samples without layout references must stay unmapped. Preserve UTF-8 BOM, formula escaping, filename behavior and bounded streaming. Confirm migration c8e2f4a6b9d1 is applied to the selected environment.

Run the existing statistics Details regression and verify it with a long participant roster in the deployed UI. Validate dynamic AOIs against a real tracker/display, including modals and new fields. DOM overlay checks establish geometry collection, not physical eye-tracker accuracy.

Add “Stimulus herunterladen” to the study's video table and “Bildschirmaufnahme herunterladen” to recording/participant details reachable from the study overview. Authenticate with the existing admin dependency and resolve the exact selected artifact, including repeated recordings of a case.

Serve local files as streamed attachments or provide signed storage downloads with safe filenames/disposition. Do not buffer an entire recording in application or browser memory. Handle unavailable/incomplete recordings explicitly.

A downloaded raw screen recording will not contain the gaze dot currently drawn by the replay viewer. A rendered gaze-overlay video is a separate processing feature and must be requested explicitly. A screen-recording CSV manifest would be useful for offline linkage but is an optional follow-up; it would extend today's ten-export contract and must update backend/frontend lists, descriptions, filters and tests together.

Rehearse capture independently of gaze: real bridge, bridge without tracker, browser fallback, denied permission, interrupted sharing, upload failure, and next-case browser fallback after bridge capture failure. Current capture is per case-video, without audio; whole-session/think-aloud audio or a second simultaneous recorder is additional scope.

Browser display capture requires a secure context and user interaction; permission cannot simply be persisted for a new capture request. Verify it on the actual deployed origin. [MDN getDisplayMedia documentation](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

Acceptance: exact selected videos download and play for both storage paths; repeated cases select the correct capture; large files remain streamed; failed capture leaves the documented stimulus replay fallback; exported gaze reconciles with stored data.

**Work package 7 — Hosting, capacity and maintenance handover**

Owner: deployment operator with developer support.

Choose one route for the pilot and a supported route for live studies. The code supports local and GCS storage, but its production guard currently requires GCS. Do not disable production safeguards merely to run LRZ local disks.

| Route | Required work |
| --- | --- |
| Existing GCS-backed deployment | Configure and rehearse the existing production path, database, origins, signed media access, upload limits, backups and monitoring |
| Local supervised pilot | Use persistent database/media storage and verified backups; rehearse browser permissions and participant-machine access |
| LRZ VM with durable mounted storage | Add an explicit supported production storage policy, persistent mount validation, permissions, backup/restore and capacity checks |
| Another object store | Treat as a storage-adapter project; a bucket URL alone does not make it compatible with GCS code |

Do not assume how other projects deploy or that the assigned LRZ machine has sufficient capacity. Obtain the actual allocated/free space, participant count, concurrent sittings, network throughput and retention/backup expectations. LRZ's public Compute Cloud documentation lists a default 200 GB Ceph quota and says LRZ does not back up these volumes; neither statement establishes this project's quota or free space. [LRZ Compute Cloud](https://www.lrz.de/en/service-center/alle-lrz-services/virtual-infrastructure-services/compute-cloud)

Measure one representative full session for bridge and browser capture. Size shared stimuli plus per-participant screen video, raw gaze, database growth, temporary/retry files and backups, with explicit free-space headroom. The repository's 1–1.5 GB/participant is a planning estimate, not a measured guarantee. Browser capture targets 2.5 Mbps; bridge capture uses variable bitrate, so duration/content matter.

Fix the concrete backup mismatch: Compose stores uploads in a named volume, while scripts/backup.sh defaults to host backend/uploads and currently skips it if missing. Make backup behavior storage-aware and fail clearly when expected media is absent. Prove database plus stimulus, gaze chunks and screen video restore into an isolated environment.

Extend existing DEPLOY.md and OPERATIONS.md after implementation, preserving current uncommitted work. Include the actual host/configuration and responsible operator; daily start/preflight and end-of-session checks; tracker/capture recovery; pending writes/uploads; disk and backup alerts; tested restore procedure; update/TLS/dependency maintenance; migration, rollback and incident steps; retention decision and data removal responsibilities. Remove stale claims about missing content, capture fallback and test counts only after checking the final source.

Acceptance: another operator can start the system, run a complete test participant, retrieve all data, handle a failed capture/upload, and restore database plus media by following the runbook.

**Delivery order and October testing**

| Order | Deliverable | Dependency / release condition |
| --- | --- | --- |
| 1 | Approved item manifest and display/hosting facts | Researcher input; can proceed alongside engine work |
| 2 | Engine/admin editing and safe study-update rules | Required for CK/PCK import and subsequent researcher additions |
| 3 | Content, section intros, manual timer/finish and timing exports | Must be tested as one instrument flow before measured sessions |
| 4 | Actual viewport and capture rehearsal | Uses real final content and chosen host |
| 5 | Downloads and verified maintenance handover | Can proceed in parallel with packages 2–4 |
| 6 | Deployed regressions, historical gaze investigation and full pilot | Required before closing the corresponding feedback |
| 7 | Pilot feedback fixes and live-study release | Only after remaining instrument/data-integrity blockers close |

October 27–28: resolve content ambiguities, freeze a test instrument, choose host/display and prepare the pilot build. The quoted October 21 request places the additional PCK content around October 28; verify its availability instead of inventing those items.

October 29–30: supervised usability/technical testing on the selected environment, with an explicit list of any unavailable or provisional instrument items. If the full flow is not ready, limit the session to a technical pilot rather than treating provisional answers as final study data.

Use the following week, approximately through November 6, for feedback, fixes and repeat checks. This is a proposed sequence, not a promise that all packages fit before October 29. Live studies start after the final instrument, timing/export behavior, real display/capture setup and backup restore pass acceptance.

**Verification and completion criteria**

Follow the repository's current CI gates: backend Ruff/format/mypy, real disposable PostgreSQL tests, migrations and Alembic consistency, coverage floor; frontend tests/typecheck/lint/build; participant end-to-end tests; browser feedback tests; bridge tests where recording behavior changes. Never run destructive test fixtures against a study database.

Add focused regressions for compound/debugging and ranking validation; exact blank/multifile line numbers; the five-entry CK cap and compatibility of existing uncapped questions; admin edit/import round trips; intro step counts; persisted deadline; manual skip and partial-answer save; no timestamps or response rows for unvisited pages; retry/race behavior; reload/revisit timing; started-run edit protection; and both download storage paths. Run existing raw export, stats, capture and AOI tests; extend them only for new behavior or a reproduced gap.

Before live use, independently complete one representative run and verify answers, all available exports, page/section times, raw sample counts, capture replay/download and restored backup media. Test the real Tobii hardware and actual browser permissions; synthetic tests cannot establish physical calibration, mapping accuracy or display permissions.

This planning audit read source and existing tests, parsed every CSV row, checked the duplicate IDs and five-entry wording twice, and consulted browser/LRZ primary documentation. It did not execute automated test suites, inspect the live study database, verify deployment state or test hardware.

