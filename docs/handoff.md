# ProBoost Creator CRM Handoff

## Required Reading

Before editing code, read these documents in order:

1. `docs/agent-git-workflow.md`
2. `docs/send-mail-sqlite-migration-plan.md`
3. `docs/followup-optimization-plan.md` if touching inbox classification, second-touch follow-up, LLM classification, or mail automation
4. This handoff document

The send-mail migration plan is the source of truth for the manifest-to-SQLite and frontend modernization roadmap. Do not continue send-mail work from memory; re-read the plan first.

## Current Direction

The project is moving away from:

- server-side giant HTML string rendering in `src/web/server.js`
- `manifest.json` as durable batch state
- direct dependence on `/Users/depp/send-mail`

The target is:

- SQLite-owned campaign, batch, run, and send state
- Express as API/orchestration layer
- React/Vite/Tailwind frontend for operator UI
- internal CRM-owned automation code, eventually removing `/Users/depp/send-mail` as a runtime dependency

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
  - runner heartbeat
  - nonzero runner failure release
  - stale `sending/preparing` recovery on web startup and every minute

### In Progress

- Phase 2 frontend modernization
  - React/Vite/Tailwind dashboard skeleton exists in `src/web/client/`
  - `/api/dashboard` exists
  - `/dashboard` has a fallback if the frontend bundle is not built
  - `npm install` was blocked by sandbox network, so dependencies and `package-lock.json` may need attention before build verification

### Not Yet Done

- Phase 4: runtime bridge that lets legacy automation update SQLite directly
- Phase 5: manifest retirement
- Phase 6: internalize `/Users/depp/send-mail` split/send logic into this repo

## Current Important Files

Send-mail state migration:

- `docs/send-mail-sqlite-migration-plan.md`
- `src/db/schema.js`
- `src/db/index.js`
- `src/sendMailBridge/engine.js`
- `src/sendMailBridge/syncToCrm.js`
- `src/sendMailBridge/runtimeScript.js`

Web frontend migration:

- `src/web/server.js`
- `src/web/client/main.jsx`
- `src/web/client/styles.css`
- `vite.config.js`
- `package.json`

Legacy adapters and follow-up work:

- `src/automation/reminderRunner.js`
- `src/automation/mailClient.js`
- `src/automation/domActions.js`
- `src/automation/selectors.js`
- `src/classifier/llmClassifier.js`
- `src/legacyAdapters/proboostReadyReminder.js`

## Legacy Boundaries

Do not modify these external projects directly unless the user explicitly asks:

- `/Users/depp/send-mail`
- `/Users/depp/proboost-ready-reminder`

Treat them as read-only execution engines and reference implementations. New behavior, state interpretation, status mapping, preflight checks, logs, reports, and UI should live in this repo.

The long-term goal is Phase 6: move the relevant split and Playwright send logic into this repo so the CRM is clone-and-run.

## Known Verification Gaps

The following checks passed:

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

The following checks were blocked by sandbox/network restrictions:

```bash
npm install
npm run web:build
npm run web
```

`npm install` failed in sandbox because `registry.npmjs.org` could not resolve. Attempts to request elevated network install timed out. `npm run web` failed in sandbox with `listen EPERM 127.0.0.1:8794`; elevated run also timed out.

Before claiming the frontend migration is complete, install dependencies, build the frontend bundle, start the server, and inspect `/dashboard`.

## Operational Safety

- Never start two headed Edge automation processes with the same profile at once.
- All real sends must remain headed and visible.
- Do not kill the user's normal browser processes.
- If cleanup is needed, stop only the specific legacy automation `node` process.
- If a batch is stuck in `sending` or `preparing`, prefer the SQLite stale recovery path over hand-editing JSON.
- Remember that `manifest.json` is still a compatibility artifact until Phase 5 is complete.

## Suggested Next Step

If continuing the current roadmap, do this next:

1. Resolve frontend dependency installation and lockfile state.
2. Run `npm run web:build`.
3. Start `npm run web`.
4. Verify `/api/dashboard` and `/dashboard`.
5. Continue Phase 2 by moving `/send` work orders from manifest scanning to SQLite-backed JSON APIs and React components.

Do not jump to Phase 4/5 until Phase 2 is stable enough that the operator UI no longer depends on manifest scanning.
