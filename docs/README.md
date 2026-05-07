# Documentation Index

This folder is split into current operating documents and archived planning notes.

## Current Sources of Truth

- `agent-git-workflow.md`: required branch and git workflow before code changes.
- `handoff.md`: current implementation status and next engineering steps.
- `send-mail-sqlite-migration-plan.md`: send-mail state migration status. SQLite is now the CRM source of truth for campaigns, batches, task runs, and recovery; manifest files remain compatibility artifacts for the current runner contract.
- `mail-sync-followup-development-plan.md`: next development plan for replied-mail sync, detail opening, API discovery, DB-backed classification, and DB-backed ready followup.
- `mail-sync-phase4-handoff.md`: implementation handoff for mail-sync phases 0-4, including verification gaps and risks.
- `followup-optimization-plan.md`: historical followup implementation plan with useful context. For new mail-sync work, use `mail-sync-followup-development-plan.md` as the active plan.

## Archived Reference

The files in `archive/` are preserved for background only. They describe earlier project assumptions and should not drive new implementation decisions unless a current source-of-truth document links to them explicitly.

- `archive/development-plan.md`
- `archive/full-development-roadmap.md`
- `archive/send-mail-integration-runbook.md`

## Current Progress Snapshot

### Send-Mail

- Done: SQLite landing zone, batch claims, heartbeat/recovery, runtime SQLite updates, React/Vite asset bundle, and repo-owned split/send runtime entrypoints.
- Compatibility remaining: `manifest.json`, `MANIFEST_PATH`, `BATCH_LIST`, and environment-variable runner options are still used as adapter inputs.
- Next: remove the manifest/env-var compatibility contract from the send runner internals and add headed smoke coverage.

### Ready Followup and Mail Sync

- Done: current `ready-followup` can launch ProBoost, enter the replied-inbox path when the UI cooperates, list rows, open threads, read text, persist threads/messages, classify replies, and dry-run or send with explicit `--send`.
- Done: Phase 0-5 mail-sync foundation. DOM failure JSON now includes visible controls/selects/table headers, `npm run mail-sync` can sync or produce diagnostics without classifying or sending, replied mailbox entry supports multi-strategy status matching/fallback, detail opening reports the successful strategy, `npm run mail-debug` plus `/mail-debug` capture sanitized mail API candidates, and mail message writes are idempotent by provider message/body hash.
- Blocked/fragile: detail reading still defaults to DOM body extraction until a discovered ProBoost detail API is wired into sync, inbox fallback can miss replied rows if reply state is not visible, and classification/sending are still coupled to live browser navigation.
- Next: wire API-backed detail sync, add independent actual-registration import, then DB-backed `classify-mail`.
