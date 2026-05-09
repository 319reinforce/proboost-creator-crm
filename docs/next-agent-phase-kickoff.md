# Next Agent Phase Kickoff

Status as of 2026-05-09.

This is the start-here document for the next coding agent. Its job is to continue all remaining phases without rediscovering the project shape from scratch.

## First Read

Read these in order before editing:

1. `docs/agent-git-workflow.md`
2. `docs/README.md`
3. `docs/current-project-overview.md`
4. `docs/handoff.md`
5. `docs/mail-sync-phase4-handoff.md`
6. `docs/mail-sync-followup-development-plan.md`
7. `docs/send-mail-sqlite-migration-plan.md`

Create a new branch before changes. The current Phase 5 PR is based on `codex/frontend-ui-modernization`, not `main`, because the GitHub repo currently has no `main` branch.

## Current Baseline

Mail sync Phase 0-5 is implemented:

- Phase 0 diagnostics: richer DOM failure JSON/screenshots.
- Phase 1 standalone `npm run mail-sync`.
- Phase 2 multi-strategy replied mailbox entry.
- Phase 3 hardened detail opening with named `openStrategy`.
- Phase 4 sanitized `npm run mail-debug` and `/mail-debug`.
- Phase 5 DB idempotency: `sync_status`, `last_sync_error`, `last_open_strategy`, `raw_snapshot_path`, `provider_message_id`, `body_hash`, `sync_run_id`, and unique indexes.
- Phase 6 API-backed detail sync: `mail-sync` prefers ProBoost receive list/detail APIs and falls back to DOM detail opening.
- Phase 7 standalone classification: `npm run classify-mail` classifies synced inbound messages from SQLite without opening a browser or sending.
- Reply composer stabilization: selected-target `remind` now verifies the chosen template radio, fills the current ProBoost wangEditor/Slate body editor with rendered dynamic text, and captures debug checkpoints with `AUTOMATION_DEBUG=1`.

Send-mail state migration is also advanced:

- SQLite owns campaigns, batches, task claims, heartbeats, stale recovery, and CRM-visible send-work-order surfaces.
- Hard failed batches can be retried one by one through `/batch/send`; this is compatible with the claim model.
- Bulk pending sends still claim only `pending`, so failed batches are never retried accidentally.
- `success-toast-not-found` / `send-confirmed-verify-missed` must not be auto-retried because the send may already have succeeded.

## Completed Phase 6-7 Boundary

Phase 6-7 has been executed for the mail-sync/followup plan. Do not restart it unless validating or fixing a bug.

What landed:

- `src/automation/mailApiClient.js` defaults to `POST /api/v1/email/receive/list` and `POST /api/v1/email/receive/detail`.
- `src/automation/mailSyncRunner.js` uses API detail sync in `auto` mode and keeps DOM fallback; `--detail-source dom` forces DOM, and `--detail-source api` disables DOM fallback.
- API reads persist stable ids as `api:email/receive:<id>`.
- `src/automation/classificationRunner.js` and `npm run classify-mail` classify synced inbound messages, skip existing analyses for the same prompt version, persist `analysis_results`, and create `manual_review_items` where needed.
- `classify-mail` must remain browser-free and must not write `send_logs`.
- Phase 6-7 UI/review cleanup is also complete: PB favicon, tab latency
  feedback, followup summary metrics, zero-send duplicate cleanup, richer mail
  detail diagnostics, API/DOM merge mismatch warnings, and `/followup` creator
  activation management.
- Post-review automation cleanup is partially complete: template selection and
  editor fill are dry-run verified. The final confirmation chain still needs one
  safe real-send smoke.

## Completed Phase 8 Boundary

Actual registration import has landed:

- `npm run import-registered -- --file /path/to/registered.xlsx --campaign <name>`
  imports actual registered/activated lists.
- Matching prefers invite code, then handle/name/email when a unique invite row
  can be found.
- Matched rows update `creators.status = 'registered'` and
  `invite_codes.status = 'used'`, preserving existing `registered_at`.
- Each matched row writes a `creator_activation_events` audit row with
  `source = activation-import` by default.
- Unmatched and ambiguous rows are returned in CLI JSON output.

Still do not:

- Refactor `ready-followup` into a DB-backed sender; that comes after classification and actual-registration import.
- Loosen send-mail retry rules or touch verification-missed retry behavior.
- Commit `reports/mail-debug/`, local SQLite DBs, browser profiles, screenshots, or raw API payloads.
- Start a real send path. Sync work must not write `send_logs`.
- Run a real selected-target send without explicit operator approval for the
  target handle.

If API sync needs validation, run headed `npm run mail-sync -- --mailbox replied --max-pages 1 --limit 1 --detail-source auto` after confirming login/profile safety. Keep raw capture behind `MAIL_DEBUG_RAW=1` only when absolutely needed.

## Compatibility Judgment

The failed work-order resend feature is compatible with Phase 5:

- It operates on `send_mail_campaigns` / `send_mail_batches`, while mail-sync Phase 5 operates on `mail_threads` / `mail_messages`.
- `claimSendMailBatch()` explicitly allows `pending` and hard `failed`; this enables operator-driven single retry.
- `claimSendMailBatch()` excludes `failed` rows with `reason = 'success-toast-not-found'`, so direct POSTs cannot bypass the UI guard for verification-missed sends.
- `claimPendingSendMailBatches()` still selects only `pending`; this preserves bulk-send safety.
- UI retry is gated to hard `failed` rows and excludes `success-toast-not-found`.
- No schema names conflict with mail-sync Phase 5 columns or indexes.

Do not broaden retry semantics without adding sent-mail verification. The next safe improvement is tests and typed task inputs, not looser retry.

## Local Data Note

Phase 4 captured inbox data was cross-checked locally:

- `reports/mail-debug/<run-id>/responses.json` included `api/v1/email/receive/list` and `api/v1/email/receive/detail`.
- The captured list contained ProBoost-native ids for the 10 local inbox messages.
- Those ids are better than DOM row hashes.
- The local ignored SQLite DB was backfilled with API ids/body hashes for operator continuity.
- The local DB backup/report artifacts are not committed and should not be assumed present in a fresh clone.

If similar artifacts exist in a workspace, use them as validation data only. Do not commit `reports/mail-debug/` or local SQLite backups unless the user explicitly asks.

## Remaining Phase Order

### Phase 9: DB-Backed Ready Followup

Goal: stop the default `ready-followup` flow from syncing, classifying, and sending in one browser pass.

Precondition: selected-target reply template selection and editor fill are now
dry-run verified. If this phase touches final send behavior, first run a
single-handle headed `--send` smoke only after the operator confirms the target
is safe.

Recommended scope:

- Query from SQLite:
  - synced inbound messages
  - latest `analysis_results`
  - hard `not registered`
  - no previous send log for that action/message
  - not manual review
- Browser opens only when preparing/sending a selected action.
- Keep old all-in-one flow behind an explicit option such as `--sync-first`.
- Keep all real sends opt-in with `--send`.

Acceptance:

- Dry-run preview works with browser closed.
- Real send is headed and explicit.
- Every prepared/sent followup references `thread_id`, `message_id`, and `analysis_id`.

### Phase 10: Web Console Split Controls

Goal: make the operator UI reflect the pipeline.

Current partial implementation:

- `/followup` now includes `达人管理`, pending/activated panes, search, campaign
  filtering, manual activation, and selected dry-run second touch.

Recommended controls:

- Sync mail
- Classify mail
- Import registered list in web UI, building on `npm run import-registered`
- Preview second-touch candidates
- Send selected second-touch followups

Acceptance:

- Sync/classification/import can be run independently.
- The UI shows stage-specific failures.
- Manual review items are visible before sending.

### Phase 11: Send-Mail Compatibility Cleanup

Goal: remove remaining manifest/env-var runner coupling.

Recommended scope:

- Replace `MANIFEST_PATH` / `BATCH_LIST` with typed task inputs.
- Keep failed-batch retry semantics exactly as currently documented.
- Add smoke coverage for:
  - split
  - claim pending
  - claim failed single retry
  - heartbeat
  - stale recovery
  - zero selected rows
  - headed dry-run send

Acceptance:

- CRM-owned send surfaces no longer need manifest files for normal operation.
- The runtime still updates SQLite terminal statuses correctly.
- No auto-retry for verification-missed sends.

### Phase 12: Verification Harness Cleanup

Goal: align local verification scripts with the current repo-owned runtime
layout.

Known issue:

- `npm run verify:followup` fails because `scripts/verify-followup.js` imports
  `../src/sendMailBridge/paths`, which no longer exists.

Recommended scope:

- Replace the old paths dependency with current modules under
  `src/sendMailBridge/`.
- Add a smoke assertion for selected-target dry-run that checks
  `templateStrategy` and rendered editor content when `AUTOMATION_DEBUG=1`
  artifacts are present.
- Keep the verifier dry-run only.

## Verification To Run Before PR

At minimum:

```bash
node -c src/db/schema.js
node -c src/db/index.js
node -c src/automation/mailSyncPersistence.js
node -c src/automation/mailSyncRunner.js
node -c src/automation/mailApiDiscovery.js
node -c src/automation/mailApiClient.js
node -c src/automation/reminderRunner.js
node -c src/cli/index.js
node -c src/web/server.js
npm run mail-sync -- --help
npm run mail-debug -- --help
```

For reply-composer work, also run:

```bash
node --check src/automation/mailClient.js
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles <safe-handle> --force-ambiguous
```

The debug JSON should show the target template checked and rendered dynamic
body text in `editorPreviews`.

For send-mail changes, also run focused SQLite smoke checks against a temporary DB:

- pending batch claim succeeds once
- duplicate claim is rejected
- failed batch single retry claim succeeds
- `success-toast-not-found` is not surfaced as retryable in UI payloads
- stale active batch recovery marks rows failed

For browser work:

- Do not run more than one headed Edge automation with the same profile.
- Prefer dry-run/headed smoke first.
- Do not kill the user's normal browser processes.

## PR Expectations

Use GitHub remote `github`. Push a new `codex/<task>` branch and open a PR against the active integration branch. Include:

- Summary by phase.
- Verification commands and results.
- Any headed smoke not run.
- Any local data artifacts used but intentionally not committed.
