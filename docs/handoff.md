# ProBoost Creator CRM Handoff

## Boundaries

Do not modify these legacy projects directly:

- `/Users/depp/send-mail`
- `/Users/depp/proboost-ready-reminder`

Treat them as read-only execution engines and reference implementations. New behavior, state interpretation, status mapping, preflight checks, logs, reports, and UI should live in `proboost-creator-crm`.

## Current Integration

`send-mail` is already wrapped through:

- `src/sendMailBridge/paths.js`
- `src/sendMailBridge/engine.js`
- `src/sendMailBridge/manifest.js`
- `src/web/server.js`

The web review console runs at:

```text
http://127.0.0.1:8787
```

It supports xlsx upload, split manifests, work-order cards, paginated review, background send jobs, and log summaries.

## Legacy Compatibility Plan

`proboost-ready-reminder` should be integrated through a CRM-side adapter, not by editing the legacy scripts.

Legacy entry points:

- `save-proboost-auth.js`: saves ProBoost auth state.
- `unused-invite-reminder.js`: computes pushed invite codes that are not ready/registered, searches inbox, and sends or dry-runs reminder replies.
- `proboost-replied.js`: scans replied mail, detects ready replies, extracts invite code/phone, and sends the appropriate reminder template.

CRM adapter goals:

1. Run legacy scripts from CRM commands.
2. Redirect reports and logs into CRM-owned folders.
3. Keep legacy auth in CRM-owned `.legacy-auth`.
4. Preserve default dry-run safety for unused invite reminders.
5. Require an explicit `--send` flag before running `proboost-replied.js`, because that legacy script sends by design.
6. Normalize legacy output into CRM-readable summaries.

Implemented CRM-side files:

- `src/legacyAdapters/proboostReadyReminder.js`
- `src/cli/index.js` legacy subcommands

Available commands:

```bash
npm run legacy:ready-login
npm run legacy:unused -- --push /path/to/push --ready /path/to/ready --limit 5
npm run legacy:unused -- --push /path/to/push --ready /path/to/ready --send
npm run legacy:replied -- --send --whitelist /path/to/registered.xlsx
```

Safety defaults:

- `legacy unused` runs with `DRY_RUN=1` unless `--send` is explicitly passed.
- `legacy replied` refuses to run unless `--send` is passed, because the legacy script sends by design.
- Both adapters redirect `REPORT_DIR` and `PROBOOST_AUTH_ROOT` into CRM-owned folders.

## CRM-Owned Runtime Locations

Legacy compatibility outputs should stay inside this project:

```text
reports/legacy-runs/
.legacy-auth/
```

The adapter may read source scripts and input files from the legacy project, but should not write generated reports or auth state into the legacy project unless an operator explicitly opts into that later.

## Next Development Steps

1. CRM status interpretation layer
   - Map `success-toast-not-found` to `send-confirmed / verify-missed`.
   - Map import timeouts with empty email columns to `likely-zero-reachable`.
   - Map `ProcessSingleton` to `profile-occupied`.

2. Batch preflight
   - Read each split xlsx in CRM.
   - Compute `rowCount`, `handleCount`, `emailCount`, and `likelyReachable`.
   - Show those values in the work-order UI before sending.

3. Resume controls
   - Send pending.
   - Continue from batch N.
   - Retry non-zero-reachable failed batches.
   - Mark confirmed / skipped / retry-needed.

4. Legacy compatibility UI
   - Add a small legacy jobs panel for `proboost-ready-reminder`.
   - Show latest dry-run/send report summaries.
   - Link to CRM-owned legacy logs.

5. Per-work-order log archive
   - Move from a flat `reports/send-mail-runs/` folder toward:

```text
reports/send-mail-runs/{campaign}/
  split.log
  send.log
  run-summary.json
```

## Operational Notes

- Never start two headed Edge automation processes with the same profile at once.
- If a profile conflict appears, inspect:

```bash
ps -axo pid,ppid,command | rg '/Users/depp/send-mail/proboost-auto.js|send-mail/.proboost-auth/default/edge-profile|proboost-ready-reminder'
```

- If cleanup is needed, only stop the specific legacy automation `node` process. Do not kill the user's normal Edge process.
- All real sends must remain headed and visible.
