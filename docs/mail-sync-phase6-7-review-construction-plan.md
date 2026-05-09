# Phase 6-7 UI Construction Addendum: PB Icon, Creator Activation Management, and Tab Latency

Status date: 2026-05-09
Request source: product review after follow-up/mail-sync UI testing.
Runtime code status: implemented in the current workspace. This document is now
both the original construction plan and the completion record for the Phase 6-7
UI/review cleanup work.

## Implementation Status

Completed as of 2026-05-09:

- PB favicon is served from `/assets/favicon.svg` and linked from the shared
  layout.
- Top tab clicks receive immediate active-state feedback, static assets have
  low-risk cache headers, and top routes are prefetched.
- `/followup` includes the `达人管理` surface with pending and activated panes,
  search, campaign filtering, row selection, manual activation, and selected
  dry-run second-touch job creation.
- `creator_activation_events` records activation audit rows for manual moves and
  activation imports.
- `GET /api/followup/creators`,
  `POST /api/followup/creators/activate`, and
  `POST /api/followup/creators/second-touch` are implemented.
- `runReminderBatch()` accepts explicit `creatorIds` / `inviteCodeIds`, so the
  selected-target path does not require mailbox scanning first.
- Follow-up automation after product review is stabilized for selected-target
  dry-runs: the target template radio is verified, the current wangEditor/Slate
  composer is filled with rendered dynamic text, and debug checkpoints can be
  captured with `AUTOMATION_DEBUG=1`.

Still pending:

- one controlled real-send smoke for the final confirmation chain
- DB-backed ready-followup execution from synced/classified messages
- manual review queue UI

## Product Goals

This phase should turn the CRM from a set of operational scripts into a clearer
operator console:

- The browser tab and app chrome must look like ProBoost Creator CRM, not a
  default browser page.
- The second-touch page must separate creator state management from mailbox
  scanning: operators should be able to see who received invite codes, who
  actually activated/used them, and push a selected creator into the same
  second-touch path proven by the legacy reminder project.
- Top-level navigation should feel instant enough for repeated operations.
  Current tab switching should be treated as a performance/architecture issue,
  not merely a styling issue.

## 1. Switch Browser Tab Icon to PB

### Current State

`src/web/views/layout.js` sets document title and CSS/script assets, but it does
not declare a favicon. Browsers therefore show the default globe icon in the tab.
The app header already has a PB mark in `.brand-mark`, so the browser chrome is
the inconsistent part.

### Target Behavior

- Browser tab shows a PB icon for every server-rendered page:
  `/send`, `/followup`, `/mail-debug`, `/dashboard`, `/logs`.
- The icon should be served by this app, not inherited from ProBoost mail or the
  browser default.
- The implementation should avoid remote assets and work offline with the local
  quick-start script.

### Implementation Plan

Files:

- `src/web/public/favicon.svg`
- `src/web/views/layout.js`

Work:

1. Add a small SVG favicon under `src/web/public/favicon.svg`.
   - Use the existing brand shape: teal/blue square, rounded 8px or less, white
     `PB` lettering.
   - Keep it simple enough to render at 16px.
   - Use ASCII-only SVG text if possible.
2. Add favicon links to the shared layout head:
   - `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />`
   - Optionally add `<link rel="shortcut icon" href="/assets/favicon.svg" />`
     for older browser fallback.
3. Keep page titles as-is, because they already distinguish the active module.

Verification:

- Restart `8794` or hard-refresh the existing browser tab.
- Open `/dashboard` and confirm the tab icon is PB, not the globe.
- Open `/followup` and confirm the icon persists across all top-level tabs.

Risks:

- Browser favicon caching can be stubborn. If the old globe remains, use a cache
  bust query during verification or hard refresh the tab.

## 2. Add Creator Activation Management to Second Touch

### Current State

The current `/followup` page is centered on mailbox scanning and classification:

- Full historical backfill.
- Incremental new-mail detection.
- Recent classification results and task history.

It does not yet give the operator a clear two-column creator management surface.
The legacy `proboost-ready-reminder` project had the core business mental model:

- Load all pushed invite-code creators.
- Load ready/registered/activated creators.
- Compute pending targets from pushed minus activated/ready.
- Send reminders for selected or filtered pending targets.

Relevant legacy references:

- `/Users/depp/proboost-ready-reminder/unused-invite-reminder.js`
- `/Users/depp/proboost-ready-reminder/proboost-replied.js`
- `/Users/depp/proboost-ready-reminder/docs/creator-mail-ops-development-plan.md`

### Target UX

Add a new "达人管理" section inside the second-touch page.

Layout:

- Left pane: all creators who were sent invite codes.
- Right pane: creators who actually activated/used the invite.
- Center/toolbar actions:
  - `转移到右侧已激活`
  - `推动指定人的二次触达`

The UI should be operational and dense, not a marketing-style card layout.

Left pane should support:

- Search by handle/name/invite code.
- Filter by campaign/import batch.
- Filter pending-only: sent invite but not activated.
- Multi-select rows.
- Columns:
  - handle/name
  - invite code
  - campaign/source
  - sent/imported time
  - last mail/reply status if known
  - last second-touch action

Right pane should support:

- Search by handle/name/invite code.
- Show activation source:
  - imported actual activation list
  - manually transferred by operator
  - inferred from synced mail/classification if supported later
- Columns:
  - handle/name
  - invite code
  - activated/imported time
  - source
  - operator note/audit link

Action behavior:

1. `转移到右侧已激活`
   - Requires one or more selected left-pane creators.
   - Marks the selected creator/invite rows as activated/used.
   - Removes them from pending reminders.
   - Writes an audit event so the manual move is reversible or at least
     traceable.
2. `推动指定人的二次触达`
   - Requires selected left-pane creators.
   - Reuses the reminder-style targeting model:
     selected handles/invite codes become explicit targets.
   - Should dry-run by default.
   - Should use existing template selection and login state.
   - Should not depend on scanning the whole mailbox first.

### Data Model Plan

Use existing tables first:

- `creators`
- `invite_codes`
- `send_logs`
- `task_runs`
- existing campaign/import data

Add only if needed after schema inspection:

- `creator_activation_events`
  - `id`
  - `creator_id`
  - `invite_code_id`
  - `source`: `manual`, `activation-import`, `mail-inferred`
  - `activated_at`
  - `operator_note`
  - `task_run_id`
  - `created_at`
- or, if current schema already supports status/source fields cleanly, prefer
  updating existing creator/invite status and writing the audit into `task_runs`
  or an existing log table.

Important rule:

- Activation state must be based on actual activation/use source of truth, not
  merely on "ready" reply text. A ready reply can guide second-touch; it should
  not automatically mean activated unless the activation source says so.

### Backend API Plan

Add JSON endpoints before UI wiring:

- `GET /api/followup/creators`
  - returns `{ pending, activated, summary, filters }`
  - supports query params:
    - `campaign`
    - `q`
    - `status`
    - `limit`
    - `offset`
- `POST /api/followup/creators/activate`
  - body: `{ creatorIds | inviteCodeIds, note }`
  - marks selected creators/invite codes as activated.
  - returns updated rows and summary.
- `POST /api/followup/creators/second-touch`
  - body: `{ creatorIds | handles | inviteCodeIds, templateName, send }`
  - starts a job equivalent to the legacy reminder selected-target flow.
  - dry-run is default.

### Runner Plan

Reuse existing second-touch primitives where possible:

- Existing `runReminderBatch()` already has a selected-target pattern through
  handles/campaign/limit.
- Existing `runReadyFollowupBatch()` handles mailbox classification; it should
  remain the mailbox-driven flow.

Construction approach:

1. Add a DB query that returns pending invite targets:
   - all sent/imported invite-code creators minus activated/used creators.
2. Add a selected-target runner wrapper:
   - input selected creators or invite codes from the UI.
   - resolve them into handles/codes.
   - invoke reminder-style sending with explicit targets.
3. Preserve the default dry-run path.
4. Record result rows under task history so the UI can show "last pushed".

### Frontend Plan

Files likely touched:

- `src/web/server.js`
- `src/web/public/app.js`
- `src/web/public/app.css`
- optionally React dashboard client files only if this section is moved into
  the React bundle later.

Implementation steps:

1. Add the static server-rendered shell in `renderInboxClassification()` below
   the scan controls:
   - section heading: `达人管理`
   - left table container
   - action toolbar
   - right table container
2. Add `app.js` behavior:
   - fetch creator state from `/api/followup/creators`
   - preserve row selection across refresh where possible
   - post activation action
   - post second-touch action
   - listen to `/events` for job refresh
3. Add CSS:
   - two-pane grid with stable table heights.
   - compact controls.
   - no nested cards.
   - responsive behavior: panes stack on narrow screens; action toolbar remains
     visible above tables.

Verification:

- Seed or use existing DB records with at least:
  - one invited creator not activated
  - one activated creator
- Confirm pending appears left and activated appears right.
- Select one pending creator and move to activated.
- Confirm it disappears from the left pending list and appears on the right.
- Select one pending creator and run dry-run second-touch.
- Confirm a task row appears and no real send happens unless `send=1`.

## 3. Analyze and Fix Slow Top Tab Switching

### Current State

Top tabs in `src/web/views/layout.js` are normal anchor links:

- `/send`
- `/followup`
- `/mail-debug`
- `/dashboard`

Each click is a full document navigation. That means every switch rebuilds:

- HTML document.
- shared CSS.
- `src/web/public/app.js`.
- EventSource `/events` connection.
- page-specific API calls.
- React dashboard/send bundle when `/send` or `/dashboard` is involved.

The visual slowness seen in the screenshot is therefore likely caused by full
page reload and app boot, not by the `.tab` active CSS itself.

Observed contributors:

1. Full-page reload for every tab.
   - Active state is server-rendered, so the new active pill only appears after
     the route returns and the browser repaints.
2. Mixed architecture.
   - `/followup` and `/mail-debug` are mostly server-rendered.
   - `/send` and `/dashboard` may load `/app/assets/main.js`,
     `/app/assets/vendor.js`, and `/app/assets/charts.js`.
   - Switching into React-backed pages costs more work.
3. Repeated live connection setup.
   - `app.js` creates a new `EventSource('/events')` per page load.
4. Fonts and global CSS.
   - `app.css` imports Google fonts. Even when cached, font readiness and style
     recalculation can contribute to perceived tab delay.
5. Server-side rendering work.
   - Some pages compute DB-backed summaries before returning HTML.
   - Dashboard then also fetches `/api/dashboard`.

### Measurement Plan

Before changing behavior, capture timing:

- Browser performance:
  - measure click-to-first-paint for each tab.
  - inspect Network waterfall for HTML, CSS, JS chunks, `/events`, and API.
- Server timing:
  - add temporary request duration logging for `/send`, `/followup`,
    `/mail-debug`, `/dashboard`.
  - identify whether delay is server response or browser boot.
- Client timing:
  - add temporary `performance.mark()` around app initialization if needed.

### Fix Options

Option A: Low-risk prefetch and cache polish.

- Add `<link rel="prefetch">` for likely tab HTML routes or JS chunks.
- Add long cache headers for static assets under `/assets` and `/app`.
- Keep full-page navigation.
- Lowest implementation risk, moderate perceived improvement.

Option B: Make top tabs feel instant with optimistic active state.

- Add a tiny click handler in `app.js`:
  - set clicked tab active immediately.
  - allow normal navigation to continue.
- This improves perceived responsiveness but does not reduce actual load.
- Good quick polish, not a full solution.

Option C: Convert top tabs to an app shell.

- Keep a persistent header and EventSource.
- Use client-side route loading for module content.
- Fetch partial HTML or JSON for tab content without full document reload.
- Bigger change, best user experience for repeated operations.

Recommended path:

1. Implement Option B first for immediate perceived feedback.
2. Add static asset cache headers and preload/prefetch where safe.
3. Measure again.
4. If still slow, plan Option C as a separate app-shell migration.

### Verification

- Compare tab click timings before/after:
  - `/followup` to `/mail-debug`
  - `/mail-debug` to `/dashboard`
  - `/dashboard` to `/send`
- Confirm active tab visual updates immediately.
- Confirm no duplicate EventSource connections remain after navigation.

## Implementation Order for This Addendum

1. PB favicon.
2. Tab latency measurement and low-risk feedback fix.
3. Creator activation data query/API.
4. Creator management UI shell.
5. Manual activation action.
6. Selected-creator second-touch action.
7. Verification against legacy reminder semantics.

## Resolved Questions

- "实际激活使用" now has an explicit import path through
  `npm run import-registered`, plus manual activation from `/followup`.
- Manual activation is auditable through `creator_activation_events`; UI-level
  reversal remains intentionally deferred.
- "推动指定人的二次触达" uses selected invite-code/creator rows as explicit
  targets for `runReminderBatch()` and remains dry-run by default.
- The creator management section currently lives inside `/followup`. A separate
  top-level tab can be considered later if the surface grows.

---

# Mail Sync Phase 6-7 Review Construction Plan

Status date: 2026-05-09
Branch: `codex/mail-sync-phase6-7`

This section records the Phase 6-7 code review verification cleanup. All scoped
items below are implemented in the current workspace unless marked deferred.

## Current Verification Summary

The following findings were verified and then resolved in the current worktree:

- Critical: duplicated `zero-send` handling exists in
  `src/sendMailBridge/runtime/proboost-auto.js`. Resolved.
- Critical: `followupSummaryPayload()` omits `syncMode` and `skippedKnown` from
  the `/api/followup-summary` result payload. Resolved.
- Medium: `runReadyFollowupBatch()` stores `syncMode` as a dynamic property on
  the `results` array. Resolved.
- Medium: the original `mailApiClient` concern is outdated. `getMailDetail()`
  now throws when all detail payload attempts fail, but the thrown message only
  exposes the last HTTP status. Resolved with richer final-attempt context.
- Low: `runClassificationBatch` and `classify-mail` naming is consistent with
  existing runner/CLI style, so no immediate change is planned.
- Low: `mergeApiRowsWithDomFallback()` relies on API and DOM row order matching.
  Resolved with a warning while keeping index-based compatibility.
- Low: `.tabs` and `.tab` include redundant `pointer-events: auto` rules.
  Resolved.

## Construction Scope

### 1. Remove unreachable zero-send duplicate blocks

File: `src/sendMailBridge/runtime/proboost-auto.js`

Work:

- Keep one `zero-send` modal handler inside `tryConfirmSend()`.
- Keep one `confirmed === 'zero-send'` branch in the batch send flow.
- Remove the seven duplicated copies in each location.

Expected behavior:

- A confirmation modal that says the operation will send 0 emails is still
  closed and reported as `zero-send`.
- The current batch is still marked as skipped/sent with
  `reason: 'send-confirm-zero'`.
- Pending batches still continue through `appendPendingBatchesAfterCurrent()`.

Verification:

- Run a syntax check for the touched file.
- Review the diff to confirm only duplicate unreachable branches were removed.

### 2. Restore follow-up summary incremental metrics

File: `src/web/server.js`

Work:

- Add `syncMode` to both populated and empty `result` payloads in
  `followupSummaryPayload()`.
- Add `skippedKnown` to both populated and empty `result` payloads.

Expected behavior:

- `/api/followup-summary` returns the same fields rendered by
  `renderInboxClassification()`.
- Live polling in `src/web/public/app.js` can update `skippedKnown`.
- Existing consumers continue receiving all previous fields.

Verification:

- Run a lightweight server/module syntax check.
- If a local server is already used for this branch, open the page and confirm
  the follow-up metric payload includes the new fields.

### 3. Normalize ready-followup summary metadata

File: `src/automation/reminderRunner.js`

Work:

- Stop relying on `results.syncMode` for summary metadata.
- Pass `syncMode` into `summarizeReadyFollowupRun()` explicitly.
- Keep `skippedKnown` derived from result item statuses.

Expected behavior:

- `results` remains a plain array of row results.
- Summary JSON still includes `syncMode`.
- Incremental stop behavior and progress emission remain unchanged.

Verification:

- Run the CLI in a dry-run/syntax-safe way if browser state allows it.
- Otherwise run a module syntax check and inspect all call sites to ensure
  `syncMode` is supplied consistently.

### 4. Improve mail detail failure diagnostics

File: `src/automation/mailApiClient.js`

Work:

- Preserve the current throwing behavior when all detail payload shapes fail.
- Include clearer final-attempt context in the error message, such as last
  status and whether a payload existed without body text.

Expected behavior:

- Callers can still fall back to DOM sync via existing error handling.
- Logs distinguish transport/API failure from "success response without body".

Verification:

- Run syntax check.
- Review `syncRowWithApi()` behavior to confirm fallback path still catches the
  thrown error.

### 5. Guard API/DOM fallback row merge assumptions

File: `src/automation/mailSyncRunner.js`

Work:

- Add a warning when API rows and first-page DOM fallback rows have different
  lengths.
- Keep index-based merge for now to avoid changing sync semantics.

Expected behavior:

- Current successful sync behavior remains unchanged.
- Future mismatches become visible in logs.

Verification:

- Run syntax check.
- Confirm no new dependency on DOM rows for non-first pages.

### 6. Remove redundant tab pointer-events declarations

File: `src/web/public/app.css`

Work:

- Remove `pointer-events: auto` from `.tabs`.
- Remove `pointer-events: auto` from `.tab`.

Expected behavior:

- No visual or interaction change, because `auto` is the browser default and no
  parent rule requires restoration.

Verification:

- Quick visual smoke check in the browser if the web server is running.

## Deferred / No-Op Items

- `runClassificationBatch` versus `classify-mail` naming will remain unchanged
  for now because it matches the existing `runReadyFollowupBatch` /
  `ready-followup` pattern.
- A larger return-shape refactor from array-plus-summary to
  `{ results, summary }` is deferred unless future DB-backed ready-followup work
  touches the same contract.

## Suggested Implementation Order

1. Apply the two critical fixes first: duplicate zero-send removal and
   follow-up summary payload fields.
2. Apply low-risk cleanup: CSS pointer-events and merge length warning.
3. Apply metadata cleanup in `reminderRunner.js`.
4. Improve `mailApiClient` diagnostics last, because its behavior should remain
   throw-and-fallback compatible.

## Push Status

An initial attempt to push `codex/mail-sync-phase6-7` to the `github` remote was
blocked by expired GitHub credentials in the local keyring. Re-authentication is
required before this branch can be uploaded from this machine.
