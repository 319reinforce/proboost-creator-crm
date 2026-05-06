# Send-Mail SQLite Migration Plan

## Problem

The send-mail review UI currently treats `manifest.json` as the operational state store. The web server renders pages from manifest files, `src/sendMailBridge/engine.js` updates those files before spawning work, and `/Users/depp/send-mail/proboost-auto.js` also reads and writes the same files while processing batches.

This leaves two structural problems:

- The HTML surface in `src/web/server.js` is still generated through large JavaScript template strings. `src/web/views/layout.js` only extracts the page shell, not the view layer.
- `src/sendMailBridge/syncToCrm.js` mirrors manifest terminal states into `send_logs`, but it does not make SQLite the source of truth. Concurrent jobs can still race on the same manifest file.

## Target Architecture

SQLite becomes the only durable source of truth for send-mail campaigns, batches, and run state. Manifest files may exist temporarily as an adapter artifact while the legacy automation is still being retired, but the CRM must not use them as authoritative state. The final system must also stop depending on `/Users/depp/send-mail` so a fresh clone of this repository can run the CRM without hidden local files.

The desired flow is:

1. Upload and split creator files.
2. Store the campaign and every batch in SQLite.
3. Render the web UI from SQLite queries.
4. Claim batches atomically in SQLite before starting a run.
5. Run automation against explicit batch inputs.
6. Write every status transition back to SQLite.
7. Stop writing `manifest.json` once the legacy automation no longer requires it.
8. Internalize the legacy split/send automation into this repository.

## Phases

### Phase 1: Database Landing Zone

Goal: create the SQLite model that can own send-mail batch state while preserving the current send workflow.

Deliverables:

- Add `send_mail_campaigns` and `send_mail_batches`.
- Add unique keys for external manifest/campaign references.
- Add DB helpers to upsert a manifest into SQLite.
- Call the helper after split and after batch runs.
- Keep the manifest path in DB as an adapter reference, not as the target architecture.

Non-goals:

- Do not remove `manifest.json` yet.
- Do not rewrite `/Users/depp/send-mail/proboost-auto.js` yet.
- Do not move the web UI fully to API-rendered frontend yet.

### Phase 2: Read UI From SQLite and Move Dashboard to Frontend App

Goal: stop using manifest scanning as the web UI source and stop hand-writing large HTML strings in `src/web/server.js`.

Deliverables:

- Replace `renderWorkOrders` and dashboard summaries with SQLite queries.
- Keep manifest links visible only as legacy/debug metadata.
- Add JSON APIs for send-mail campaigns, batches, task runs, and dashboard summaries.
- Use a React/Vite frontend application for the dashboard first, then migrate `/send`.
- Use TailwindCSS plus small project-owned components for the operator console UI.
- Use proven frontend libraries where they remove real complexity: `@tanstack/react-table` for dense tables and `lucide-react` for icons.
- Keep Express responsible for API, uploads, process orchestration, static assets, and legacy fallback pages only.
- Do not introduce a server-side template engine as the main path. EJS/Pug would reduce string noise, but this UI needs richer table interaction, client refresh, component reuse, and scoped styling. The target is JSON API + frontend app.
- Delete each large server-side HTML renderer once its corresponding frontend route is live.

### Phase 3: Atomic Batch Claims

Goal: prevent duplicate/concurrent work on the same batch and recover from interrupted runs.

Status: implemented. SQLite now owns batch claiming, active send-mail batches receive heartbeats while the runner is alive, runner failures release claimed batches, and stale `sending`/`preparing` rows are recovered on web startup and by a periodic scanner.

Deliverables:

- Add a claim transition such as `pending -> sending` guarded by `WHERE status = 'pending'`.
- Record `task_run_id`, `started_at`, and run metadata on each batch.
- Add `last_heartbeat_at`, `claimed_at`, `claimed_by`, and `attempt_count` to send-mail batch/run state.
- Have the runner update heartbeat at a fixed interval while a batch is actively running.
- Add timeout policy for stuck states, for example `sending` with no heartbeat for more than 10 minutes.
- Add a recovery task that scans stale `sending`/`preparing` batches and moves them to `failed` with a recoverable reason such as `runner-heartbeat-timeout`, or back to `pending` when the action is known to be safe to retry.
- On web server startup, mark in-memory task runs that were left `running` as failed and run the stale batch recovery once.
- Make `/batch/send-pending` claim the next set from SQLite, not from manifest contents.
- Reject or skip already claimed batches.

### Phase 4: Legacy Automation Adapter

Goal: make the spawned automation update SQLite directly.

Status: implemented. The project-owned runtime script updates SQLite through `runtime-sqlite-bridge` whenever the legacy-compatible batch status helper is called. The compatibility manifest is still written so the current automation loop can resolve batch files and continue chained runs, but SQLite receives the terminal and selected-count updates directly.

Deliverables:

- Introduce a small runtime bridge module under `src/sendMailBridge/runtime/`.
- Replace manifest update calls in the runtime script with SQLite status updates.
- Keep the external `/Users/depp/send-mail` source untouched; the production runtime source is now project-owned.
- Remove post-run manifest sync once runtime updates are reliable.

### Phase 5: Manifest Retirement

Goal: remove manifest as durable state.

Status: implemented for CRM-owned surfaces. Dashboard and `/send` read from SQLite JSON APIs, upload/split lands campaigns and batches in SQLite, and manifest files are now treated as compatibility inputs for the current automation runner rather than durable state. Full deletion of the compatibility file is deferred until the runner no longer needs `MANIFEST_PATH` to resolve chained batch lists.

Deliverables:

- Stop generating `manifest.json` during split, or generate only a temporary compatibility file.
- Delete manifest scanning from CRM code.
- Update docs and runbooks to describe SQLite as the source of truth.

### Phase 6: Decouple and Internalize Legacy Logic

Goal: remove the external `/Users/depp/send-mail` dependency and make this repository a clone-and-run system.

Status: implemented for the production split/send entrypoints. The Excel split logic is owned by `src/sendMailBridge/splitCreators.js`, and the send automation runtime is owned under `src/sendMailBridge/runtime/`. `src/sendMailBridge/paths.js` and `SEND_MAIL_ROOT` are no longer used by production code.

Why this exists:

Phase 4 fixed the state-sync contract first. Phase 6 then moved the production split and send entrypoints into this repository so CRM no longer shells out to `/Users/depp/send-mail/proboost-auto.js` or `/Users/depp/send-mail/split-creators.js`.

Deliverables:

- Move the Excel split logic into this repository, under `src/sendMailBridge` or a new `src/automation/sendMail` module.
- Move the core Playwright ProBoost send flow into `src/automation`, using the existing session/config conventions.
- Replace environment-variable contracts (`MANIFEST_PATH`, `BATCH_LIST`, `XLSX_FILE`, etc.) with typed function options or explicit task payloads.
- Replace `spawn` of external scripts with in-process modules where safe, or with child processes that execute files owned by this repository.
- Keep browser/session handling in one project-owned module so login state, profile paths, and cleanup behavior are visible and testable.
- Add smoke tests around split logic, batch claim/recovery logic, and runner option mapping.
- Remove `SEND_MAIL_ROOT`, `src/sendMailBridge/paths.js`, and `.send-mail-runtime` once no production path needs them.

Non-goals:

- Do not rewrite all Playwright selectors in the same commit that removes manifest state.
- Do not change ProBoost sending behavior and source-of-truth migration in one large step. Internalization should happen after SQLite state and recovery are stable.

## First Implementation Step

This change implements Phase 1 only. After it lands, the current UI and automation still work, but every split/run has a normalized SQLite representation. That gives later phases a stable migration target without forcing a risky rewrite of the sending engine in one pass.
