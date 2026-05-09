# ProBoost Creator CRM Handoff

## Required Reading

Before editing code, read these documents in order:

1. `docs/agent-git-workflow.md`
2. `docs/README.md`
3. `docs/current-project-overview.md`
4. This handoff document
5. `docs/send-mail-sqlite-migration-plan.md` if touching batch send, SQLite send state, runtime scripts, or frontend send-work-order surfaces
6. `docs/mail-sync-followup-development-plan.md` if touching replied-mail sync, message detail opening, mail API discovery, or DB-backed followup execution
7. `docs/mail-sync-phase4-handoff.md` if continuing mail-sync phase 5+ work
8. `docs/next-agent-phase-kickoff.md` before starting the next implementation phase
9. `docs/followup-optimization-plan.md` only when older followup context is needed

`docs/archive/` contains older roadmaps and runbooks. They are preserved for context only.

## Current Direction

The project is moving away from:

- server-side giant HTML string rendering in `src/web/server.js`
- `manifest.json` as durable batch state
- direct dependence on `/Users/depp/send-mail`

The target is:

- SQLite-owned campaign, batch, run, and send state
- Express as API/orchestration layer
- React/Vite/Tailwind frontend for operator UI
- internal CRM-owned automation code
- DB-backed replied-mail sync and followup actions

## Migration Status

### Completed

- Phase 1: database landing zone
  - `send_mail_campaigns`
  - `send_mail_batches`
  - manifest-to-SQLite upsert helper
  - split/run sync into SQLite

- Phase 3: atomic batch claims and crash recovery
  - `task_run_id`
  - `claimed_at`
  - `claimed_by`
  - `last_heartbeat_at`
  - `attempt_count`
  - atomic `pending -> sending/preparing` claim
  - single-batch retry from hard `failed -> sending/preparing` when the operator explicitly clicks the failed batch action
  - retry guard excludes `success-toast-not-found` at both UI and DB claim layers
  - runner heartbeat
  - nonzero runner failure release
  - stale `sending/preparing` recovery on web startup and every minute

- Phase 4: runtime SQLite adapter
  - project-owned runtime bridge updates `send_mail_batches` directly
  - terminal runtime status updates clear claims in SQLite
  - compatibility manifest writes remain only for current runner inputs

- Phase 5: manifest retired from CRM-owned surfaces
  - dashboard and `/send` read SQLite-backed JSON APIs
  - manifest paths are legacy/debug metadata and runner compatibility inputs
  - failed work-order batches can be retried from the SQLite-backed `/send` surface through `/batch/send`
  - `success-toast-not-found` stays excluded from retry because it means send may have succeeded and only verification missed

- Phase 6: production split/send entrypoints internalized
  - split logic lives in `src/sendMailBridge/splitCreators.js`
  - send runtime lives in `src/sendMailBridge/runtime/`
  - production code no longer uses `SEND_MAIL_ROOT` or `/Users/depp/send-mail`

- Followup persistence foundation
  - `mail_threads`, `mail_messages`, `analysis_results`, and `manual_review_items` exist in schema
  - `ready-followup` persists opened thread text and classification results
  - rule-based classification plus optional LLM wrapper exists
  - `creator_activation_events` records manual and imported activation state
  - `npm run import-registered` imports actual registered/activated lists
  - `/followup` has creator activation management and selected dry-run second touch

- Selected-target reply composer stabilization
  - `replyToOpenedThread()` verifies the target template radio before continuing
  - the current ProBoost wangEditor/Slate composer is filled with rendered body text instead of leaving `${达人名称}` placeholders
  - dynamic rendered content is verified in the editor before dry-run success or real send
  - `AUTOMATION_DEBUG=1` writes reply checkpoints for template selected, template filled, before send click, and unsuccessful confirmation

### In Progress

- Phase 2 frontend modernization hardening
  - React/Vite/Tailwind dashboard and `/send` app exist in `src/web/client/`
  - `/api/dashboard` and `/api/send-work-orders` exist
  - `/dashboard` and `/send` load `/app/assets/main.js` when the frontend bundle is built

- Mail automation stabilization
  - DOM helper files exist
  - failure screenshots/JSON include visible controls, select labels/options, table headers, route/hash, and diagnostic paths in web task errors
  - standalone `mail-sync` exists and writes synced thread bodies into SQLite without classifying or sending
  - replied-mail entry supports exact/fuzzy reply status labels and inbox fallback
  - detail opening tries multiple click/navigation strategies and reports `openStrategy`
  - `mail-debug` records sanitized request/response artifacts under `reports/mail-debug/`
  - `/mail-debug` provides a front-end acceptance surface for API discovery runs
- Phase 5 DB idempotency is implemented: mail sync stores thread sync status/errors/open strategy, generated message identity, body hashes, and run ids; repeated syncs update existing `mail_messages` rows when identity or body hash matches
  - Phase 4 captured inbox data was cross-checked locally against Phase 5 identity rules: ProBoost `email/receive/list` ids were better than DOM row hashes, and the local SQLite DB was backfilled with API ids/body hashes. Those local DB/report artifacts are intentionally not committed.
- Phase 6 API-backed detail sync is implemented: `mail-sync` uses `POST /api/v1/email/receive/list` and `POST /api/v1/email/receive/detail` through browser-context auth when available, persists `api:email/receive:<id>` identities, and keeps DOM detail opening as fallback.
- Phase 7 standalone classification is implemented: `npm run classify-mail` classifies synced inbound `mail_messages` from SQLite, skips messages already analyzed for the same prompt version, persists `analysis_results`, and creates manual-review rows for review cases without opening a browser or writing `send_logs`.
- Phase 8 actual-registration import is implemented: `npm run import-registered` supports `.xlsx`, `.xls`, `.csv`, `.tsv`, and text inputs, matches invite code first, updates creator/invite activation state, writes activation audit rows, and returns unmatched rows.
- Reply send confirmation stabilization is partially verified: selected-target dry-run now proves template selection and editor fill on a live thread; a controlled one-handle `--send` smoke is still needed before marking the full confirmation chain production-ready.

### Not Yet Done

- Remove the compatibility `MANIFEST_PATH` contract from the send runner internals.
- Convert the runtime send flow from environment-variable configuration to direct typed task options.
- Add deeper smoke coverage for headed Playwright sending in a non-production dry-run profile.
- Decouple ready-followup so it consumes synced/classified database rows by default.
- Add a web upload/control for registered-list import; CLI import already exists.
- Update `scripts/verify-followup.js`; it still imports the removed `../src/sendMailBridge/paths` module.
- Build a manual review queue UI for `manual_review_items`.

## Current Important Files

Send-mail state migration:

- `docs/send-mail-sqlite-migration-plan.md`
- `src/db/schema.js`
- `src/db/index.js`
- `src/sendMailBridge/engine.js`
- `src/sendMailBridge/syncToCrm.js`
- `src/sendMailBridge/runtimeScript.js`
- `src/sendMailBridge/runtimeSqliteBridge.js`
- `src/sendMailBridge/splitCreators.js`
- `src/sendMailBridge/runtime/`

Web frontend migration:

- `src/web/server.js`
- `src/web/client/main.jsx`
- `src/web/client/styles.css`
- `vite.config.js`
- `package.json`

Legacy adapters and follow-up work:

- `docs/followup-optimization-plan.md`
- `docs/mail-sync-followup-development-plan.md`
- `docs/mail-sync-phase4-handoff.md`
- `src/automation/reminderRunner.js`
- `src/automation/mailClient.js`
- `src/automation/domActions.js`
- `src/automation/selectors.js`
- `src/automation/mailSyncRunner.js`
- `src/automation/mailApiDiscovery.js`
- `src/automation/mailApiClient.js`
- `src/importer/importRegistered.js`
- `src/classifier/llmClassifier.js`
- `src/legacyAdapters/proboostReadyReminder.js`

## Legacy Boundaries

Do not modify these external projects directly unless the user explicitly asks:

- `/Users/depp/send-mail`
- `/Users/depp/proboost-ready-reminder`

Treat them as read-only reference implementations. Production split/send entrypoints now live in this repo.

The remaining send-mail goal is to remove the compatibility manifest/env-var contract inside the project-owned runtime. The remaining followup goal is to make mail sync and classification database-backed before sending.

## Known Verification Gaps

Previously reported checks passed:

```bash
node -c src/db/index.js
node -c src/db/schema.js
node -c src/sendMailBridge/engine.js
node -c src/web/server.js
```

The Phase 3 DB behavior was verified against a temporary SQLite database:

- duplicate claim is rejected
- pending batch claim succeeds
- heartbeat updates active rows
- runner failure release marks rows failed
- stale recovery marks timed-out rows failed
- stale recovery exposes manifest paths for temporary legacy UI compatibility
- explicit failed-batch retry is compatible with existing claims: `claimSendMailBatch()` accepts `pending` and hard `failed`, while `claimPendingSendMailBatches()` still claims only `pending`; confirmed-but-unverified batches are blocked by the DB claim and are not exposed as retryable.

Previously reported checks were blocked by sandbox/network restrictions:

```bash
npm install
npm run web:build
npm run web
```

The current workspace now contains built frontend assets under `src/web/public/app/assets/`, but headed browser smoke coverage still needs to be rerun before claiming production readiness.

Mail-sync verification gaps are tracked in `docs/mail-sync-phase4-handoff.md`. In short: real headed `/mail-debug` still needs to run after login, and headless Edge failed in this environment. API-backed detail sync is now wired with DOM fallback.

Latest reply-composer verification performed on 2026-05-09:

```bash
node --check src/automation/mailClient.js
node -e "require('./src/automation/mailClient')"
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
```

The dry-run opened a live ProBoost thread, selected `督促产品使用`, and verified
that the editor contained rendered dynamic text including `Hi ambernicole_finds!`
and `Your invite code is: ZKCW45`. Real `--send` was intentionally not run to
avoid duplicate outreach without operator approval.

Known broken verifier:

```bash
npm run verify:followup
```

It fails because `scripts/verify-followup.js` requires
`../src/sendMailBridge/paths`, which no longer exists in the current
repo-owned runtime layout.

## Operational Safety

- Never start two headed Edge automation processes with the same profile at once.
- All real sends must remain headed and visible.
- Do not kill the user's normal browser processes.
- If cleanup is needed, stop only the specific legacy automation `node` process.
- If a batch is stuck in `sending` or `preparing`, prefer the SQLite stale recovery path over hand-editing JSON.
- Retry only hard `failed` batches from the UI. Do not retry `success-toast-not-found` / `send-confirmed-verify-missed` without manual review because the email may already have been sent.
- Remember that `manifest.json` is still a compatibility artifact even though SQLite is the CRM source of truth.
- For mail-sync risks and verification gaps, read `docs/mail-sync-phase4-handoff.md` before changing runner behavior.
- For the next phase sequence, start with `docs/next-agent-phase-kickoff.md`.

## Suggested Next Step

If continuing send-mail work, do this next:

1. Remove the remaining manifest/env-var compatibility contract from `src/sendMailBridge/engine.js` and `src/sendMailBridge/runtime/`.
2. Add headed smoke coverage for a non-production dry-run profile.
3. Verify `/api/dashboard`, `/api/send-work-orders`, `/dashboard`, and `/send`.

If continuing followup work, do this next:

1. Run a controlled one-handle `--send` smoke only after the operator confirms the target is safe.
2. Refactor `ready-followup` so the default path consumes synced/classified database rows.
3. Add web controls for sync, classification, registered-list import, preview, and send.
4. Add manual review queue UI before enabling DB-backed bulk sends.
