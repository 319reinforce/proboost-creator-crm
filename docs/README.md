# Documentation Index

This folder is split into current operating documents and archived planning notes.

## Current Sources of Truth

- `agent-git-workflow.md`: required branch and git workflow before code changes.
- `current-project-overview.md`: detailed current project description, subsystem map, safety rules, verification status, and remaining work.
- `handoff.md`: current implementation status and next engineering steps.
- `send-mail-sqlite-migration-plan.md`: send-mail state migration status. SQLite is now the CRM source of truth for campaigns, batches, task runs, and recovery; manifest files remain compatibility artifacts for the current runner contract.
- `mail-sync-followup-development-plan.md`: current development plan for replied-mail sync, detail opening, API discovery, DB-backed classification, actual-registration import, creator activation management, and DB-backed ready followup.
- `mail-sync-phase4-handoff.md`: implementation handoff for mail-sync phases 0-5, including verification gaps and risks.
- `next-agent-phase-kickoff.md`: start-here execution brief for the next agent that should continue all remaining phases.
- `followup-optimization-plan.md`: historical followup implementation plan with useful context. For new mail-sync work, use `mail-sync-followup-development-plan.md` as the active plan.
- `../src/README.md`: source-tree module map and current code-boundary notes.

## Archived Reference

The files in `archive/` are preserved for background only. They describe earlier project assumptions and should not drive new implementation decisions unless a current source-of-truth document links to them explicitly.

- `archive/development-plan.md`
- `archive/full-development-roadmap.md`
- `archive/send-mail-integration-runbook.md`

## Current Progress Snapshot

### Send-Mail

- Done: SQLite landing zone, batch claims, heartbeat/recovery, failed-batch single retry, runtime SQLite updates, React/Vite asset bundle, and repo-owned split/send runtime entrypoints.
- Compatibility remaining: `manifest.json`, `MANIFEST_PATH`, `BATCH_LIST`, and environment-variable runner options are still used as adapter inputs.
- Next: remove the manifest/env-var compatibility contract from the send runner internals and add headed smoke coverage.

### Ready Followup and Mail Sync

- Done: current `ready-followup` can launch ProBoost, enter the replied-inbox path when the UI cooperates, list rows, open threads, read text, persist threads/messages, classify replies, and dry-run or send with explicit `--send`.
- Done: Phase 0-8 mail-sync/classification/registration foundation. DOM failure JSON now includes visible controls/selects/table headers, `npm run mail-sync` can sync or produce diagnostics without classifying or sending, replied mailbox entry supports multi-strategy status matching/fallback, detail opening reports the successful strategy, `npm run mail-debug` plus `/mail-debug` capture sanitized mail API candidates, mail message writes are idempotent by provider message/body hash, API-backed detail sync is preferred with DOM fallback, `npm run classify-mail` classifies synced inbound messages from SQLite without opening a browser, and `npm run import-registered` imports actual activation state.
- Done: `/followup` has PB browser chrome, faster perceived tab feedback, creator activation management, and selected-creator dry-run second touch.
- Done: selected-target reply automation has been revalidated against the live ProBoost composer. The template radio is verified, the wangEditor/Slate body editor is filled with rendered creator/invite-code text, and `AUTOMATION_DEBUG=1` captures template/editor/confirmation checkpoints under `reports/dom-failures/`.
- Remaining fragile areas: inbox fallback can miss replied rows if reply state is not visible, `ready-followup` still couples sync/classification/sending in the legacy all-in-one path, and a controlled one-handle real-send smoke is still needed to validate the final confirmation chain after the composer fix.
- Next: DB-backed ready-followup execution, web controls for sync/classify/import/preview/send, manual review queue UI, update `scripts/verify-followup.js` to the current runtime layout, and remove send-mail manifest/env-var compatibility.
