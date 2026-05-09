# Next Agent Phase Kickoff

Status as of 2026-05-08.

This is the start-here document for the next coding agent. Its job is to continue all remaining phases without rediscovering the project shape from scratch.

## First Read

Read these in order before editing:

1. `docs/agent-git-workflow.md`
2. `docs/README.md`
3. `docs/handoff.md`
4. `docs/mail-sync-phase4-handoff.md`
5. `docs/mail-sync-followup-development-plan.md`
6. `docs/send-mail-sqlite-migration-plan.md`

Create a new branch before changes. The current Phase 5 PR is based on `codex/frontend-ui-modernization`, not `main`, because the GitHub repo currently has no `main` branch.

## Current Baseline

Mail sync Phase 0-5 is implemented:

- Phase 0 diagnostics: richer DOM failure JSON/screenshots.
- Phase 1 standalone `npm run mail-sync`.
- Phase 2 multi-strategy replied mailbox entry.
- Phase 3 hardened detail opening with named `openStrategy`.
- Phase 4 sanitized `npm run mail-debug` and `/mail-debug`.
- Phase 5 DB idempotency: `sync_status`, `last_sync_error`, `last_open_strategy`, `raw_snapshot_path`, `provider_message_id`, `body_hash`, `sync_run_id`, and unique indexes.

Send-mail state migration is also advanced:

- SQLite owns campaigns, batches, task claims, heartbeats, stale recovery, and CRM-visible send-work-order surfaces.
- Hard failed batches can be retried one by one through `/batch/send`; this is compatible with the claim model.
- Bulk pending sends still claim only `pending`, so failed batches are never retried accidentally.
- `success-toast-not-found` / `send-confirmed-verify-missed` must not be auto-retried because the send may already have succeeded.

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

### Phase 6: API-Backed Detail Sync

Goal: replace `document.body.innerText` as the preferred body source.

Recommended scope:

- Review latest `reports/mail-debug/<run-id>/candidates.json` and `responses.json`.
- Prefer ProBoost endpoints:
  - `POST /api/v1/email/receive/list`
  - `POST /api/v1/email/receive/detail`
- Extend `src/automation/mailApiClient.js` so it can:
  - list mailbox rows through browser-context auth
  - fetch detail by provider message id
  - return normalized row/detail objects
- Update `src/automation/mailSyncRunner.js` to try API detail first, then DOM fallback.
- Persist `provider_message_id = api:email/receive:<id>` and `provider_thread_id = api:email/receive:<id>` when available.
- Keep DOM diagnostics and fallback intact.

Acceptance:

- `mail-sync` can sync a body from API data without opening a row.
- Re-running the same API-backed sync does not duplicate `mail_messages`.
- DOM fallback still works when API extraction fails.
- API payload capture remains sanitized; raw capture stays opt-in.

### Phase 6.5: Actual Registration Import

Goal: make real registration state an explicit source of truth before DB-backed followup sends.

Recommended scope:

- Add a standalone CLI such as:

```bash
npm run import-registered -- --file /path/to/registered.xlsx --campaign 2026-05-06
```

- Support CSV/text first if XLSX parsing is not already easy in the repo runtime.
- Match by invite code first, then handle/email/name when available.
- Update `creators.status = 'registered'` and `invite_codes.status = 'used'`, preserving existing `registered_at` if present.
- Produce unmatched-row reporting.
- Consider audit tables only if the implementation remains small:
  - `registration_imports`
  - `registration_import_rows`

Acceptance:

- Operators can import the latest actual registered list independently from the initial `--ready` import.
- Second-touch candidate queries can reliably filter `not registered`.
- Unmatched rows are visible in CLI/web output.

### Phase 7: Standalone `classify-mail`

Goal: classify already-synced inbound messages with the browser closed.

Recommended scope:

- Add `src/automation/classificationRunner.js`.
- Add CLI:

```bash
npm run classify-mail -- --limit 50
npm run classify-mail -- --thread-id 123
```

- Query `mail_messages` without current classifier results.
- Reuse rule classifier and optional LLM wrapper.
- Persist `analysis_results`.
- Route ambiguous/problem replies to `manual_review_items`.

Acceptance:

- Classification runs with no browser process.
- It never writes `send_logs`.
- Re-running avoids duplicate latest analyses for the same message/classifier version, or has a clear versioning policy.

### Phase 8: DB-Backed Ready Followup

Goal: stop the default `ready-followup` flow from syncing, classifying, and sending in one browser pass.

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

### Phase 9: Web Console Split Controls

Goal: make the operator UI reflect the pipeline.

Recommended controls:

- Sync mail
- Classify mail
- Import registered list
- Preview second-touch candidates
- Send selected second-touch followups

Acceptance:

- Sync/classification/import can be run independently.
- The UI shows stage-specific failures.
- Manual review items are visible before sending.

### Phase 10: Send-Mail Compatibility Cleanup

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
