# Current Project Overview

Status date: 2026-05-09

This document is the current detailed description of `proboost-creator-crm`.
It summarizes what the project does, how the main modules fit together, what is
safe to run, and which areas remain unfinished.

## Purpose

`proboost-creator-crm` is the operational CRM for ProBoost creator outreach. It
replaces several one-off scripts with one SQLite-backed workflow for:

- importing creator invite-code lists
- tracking invite-code and activation state
- sending batch outreach through ProBoost mail
- syncing and classifying inbound replies
- preparing second-touch followups
- recording all operational attempts and task runs

The system is intentionally local-first. SQLite is the durable ledger, headed
Microsoft Edge is used for ProBoost actions that still require the UI/login
session, and real sends remain explicit.

## Current Architecture

```text
Operator CLI / Web UI
  -> Express orchestration and APIs
  -> SQLite CRM state
  -> Importers, classifiers, and reporting
  -> Playwright ProBoost automation
  -> Send-mail runtime bridge
```

### Durable State

The primary database is configured by `CRM_DB_PATH` and defaults to:

```text
data/proboost-creator-crm.sqlite
```

Core tables:

- `campaigns`, `creators`, `invite_codes`
- `creator_activation_events`
- `templates`
- `send_logs`
- `send_mail_campaigns`, `send_mail_batches`
- `mail_threads`, `mail_messages`
- `analysis_results`, `manual_review_items`
- `task_runs`

SQLite is the source of truth for CRM state. Send-mail `manifest.json` files may
still be produced, but they are compatibility artifacts for the current runner
contract and should not be treated as durable state.

### CLI Layer

The CLI entrypoint is `src/cli/index.js`.

Important commands:

- `npm run init`: initialize/migrate SQLite.
- `npm run import`: import pushed invite-code lists and optional initial ready lists.
- `npm run import-registered`: import actual activated/registered creator lists.
- `npm run list:unused`: list unused invite-code creators.
- `npm run render`: render reminder template previews.
- `npm run report`: export campaign reports.
- `npm run login`: open headed ProBoost and save login state.
- `npm run search`: search ProBoost inbox by handle.
- `npm run remind`: selected-target reminder dry-run/send.
- `npm run ready-followup`: legacy all-in-one replied-mail scan/classify/followup path.
- `npm run mail-sync`: sync ProBoost mail bodies into SQLite without sending.
- `npm run classify-mail`: classify already-synced messages without opening the browser.
- `npm run mail-debug`: capture sanitized ProBoost mail API request/response artifacts.
- `npm run web`: run the local operator UI.

### Web UI

The Express server is `src/web/server.js`.

Main routes:

- `/dashboard`: summary dashboard backed by JSON APIs and React/Vite assets.
- `/send`: send-mail work orders and batch status.
- `/followup`: replied-mail sync/classification controls and creator activation management.
- `/mail-debug`: API discovery acceptance page.
- `/logs`: task and runtime log access.

Main APIs:

- `GET /api/dashboard`
- `GET /api/send-work-orders`
- `GET /api/followup-summary`
- `GET /api/followup/creators`
- `POST /api/followup/creators/activate`
- `POST /api/followup/creators/second-touch`
- `GET /api/mail-debug-summary`

The frontend is mixed while migration continues:

- React/Vite assets exist for dashboard and send-work-order views.
- `/followup` and `/mail-debug` still use server-rendered surfaces plus
  `src/web/public/app.js`.

## Major Subsystems

### Import and Activation State

Files:

- `src/importer/importCampaign.js`
- `src/importer/importRegistered.js`
- `src/importer/queries.js`

The campaign importer loads pushed invite-code creators. The registration
importer loads actual activation/registered lists from `.xlsx`, `.xls`, `.csv`,
`.tsv`, or text. Matching prefers invite code, then unique handle/name/email
matches. Matched rows update creator/invite status and write activation audit
events.

### Template Rendering

Files:

- `src/templates/render.js`
- `src/db/schema.js`

Templates use `${variable}` placeholders. Missing variables block send attempts.
The default active reminder template is `督促产品使用`.

### Browser Automation

Files:

- `src/automation/session.js`
- `src/automation/mailClient.js`
- `src/automation/domActions.js`
- `src/automation/selectors.js`
- `src/automation/reminderRunner.js`

The automation layer owns ProBoost mailbox navigation, inbox search, reply
opening, template selection, editor filling, send confirmation handling, and
sent-mail verification.

Current verified behavior as of 2026-05-09:

- selected-target `remind` dry-run can open a real thread
- the target template radio is selected and verified
- the wangEditor/Slate reply editor is filled with rendered creator/invite-code text
- debug checkpoints can capture template state, subject, editor preview, buttons, and dialogs

Use `AUTOMATION_DEBUG=1` to capture checkpoints under:

```text
reports/dom-failures/
```

Example verified dry-run:

```bash
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
```

The latest dry-run produced `status: dry-run` and confirmed the editor contained
`Hi ambernicole_finds!` plus `Your invite code is: ZKCW45`.

### Mail Sync and Classification

Files:

- `src/automation/mailSyncRunner.js`
- `src/automation/mailSyncPersistence.js`
- `src/automation/mailApiClient.js`
- `src/automation/mailApiDiscovery.js`
- `src/automation/classificationRunner.js`
- `src/classifier/inboxRules.js`
- `src/classifier/llmClassifier.js`

`mail-sync` writes inbound message bodies to SQLite and never sends. It prefers
ProBoost receive list/detail APIs and falls back to DOM detail opening.

`classify-mail` reads synced messages from SQLite, writes `analysis_results`,
and can create `manual_review_items`. It does not open a browser and does not
write send logs.

### Send-Mail Work Orders

Files:

- `src/sendMailBridge/engine.js`
- `src/sendMailBridge/splitCreators.js`
- `src/sendMailBridge/runtime/`
- `src/sendMailBridge/runtimeSqliteBridge.js`
- `src/sendMailBridge/syncToCrm.js`

The send-mail subsystem imports/splits `.xlsx` creator files into batches,
stores campaigns/batches in SQLite, claims work atomically, runs headed ProBoost
automation, heartbeats active batches, recovers stale claims, and syncs terminal
state back to SQLite.

Current state:

- SQLite owns campaign/batch/task state.
- Hard failed batches can be retried individually.
- `success-toast-not-found` / `send-confirmed-verify-missed` are not auto-retryable.
- The runtime is repo-owned, but manifest/env-var compatibility remains inside
  the runner contract.

## Safety Rules

- Automation defaults to dry-run.
- Real sends require explicit `--send`.
- Do not run two headed Edge automations with the same profile at once.
- Do not retry verification-missed sends without manual review.
- Do not commit local SQLite databases, browser profiles, `reports/mail-debug/`,
  raw API captures, or screenshots unless explicitly requested.
- Treat `/Users/depp/send-mail` and `/Users/depp/proboost-ready-reminder` as
  read-only references unless the user explicitly asks to modify them.

## Current Verification

Recently verified:

```bash
node --check src/automation/mailClient.js
node -e "require('./src/automation/mailClient')"
npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
```

Known blocked check:

```bash
npm run verify:followup
```

It currently fails because `scripts/verify-followup.js` requires the missing
module `../src/sendMailBridge/paths`. That verifier needs to be updated to the
repo-owned send-mail runtime layout.

## Remaining Work

High-priority remaining work:

1. Run a controlled one-handle `--send` smoke after the operator confirms the target is safe.
2. Refactor `ready-followup` to consume synced/classified DB rows by default.
3. Add web split controls for sync, classify, import registered list, preview candidates, and send selected followups.
4. Build the manual review queue UI.
5. Remove remaining send-mail manifest/env-var compatibility from runner internals.
6. Update or replace `scripts/verify-followup.js`.

