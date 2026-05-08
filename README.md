# ProBoost Creator CRM

`proboost-creator-crm` is the next-stage CRM project for ProBoost creator operations.

Agent handoff rule: future coding agents must read `docs/agent-git-workflow.md` before editing. Use GitHub as the remote and create a new working branch before every code change. Start with `docs/README.md` for the current documentation map. For followup automation work, read `docs/mail-sync-followup-development-plan.md`; `docs/followup-optimization-plan.md` is retained as historical context.
For send-mail batch-state migration work, read `docs/send-mail-sqlite-migration-plan.md`.
For continuing the next implementation phases, start with `docs/next-agent-phase-kickoff.md`.

It turns one-off reminder scripts into a structured workflow:

1. Import pushed invite-code lists.
2. Import ready/registered lists.
3. Maintain creator and invite-code state in SQLite.
4. List creators who have not used their invite codes.
5. Render reminder templates with invite-code variables.
6. Generate daily audit reports.
7. Later: sync inbox replies, classify intent, and send reminders through ProBoost automation.

## Quick Start

Install dependencies:

```bash
npm install
```

Initialize the database:

```bash
npm run init
```

Import push and ready files:

```bash
npm run import -- --push /Users/depp/proboost-ready-reminder/push/0428list --ready /Users/depp/proboost-ready-reminder/ready/0428ready --campaign 2026-04-28
```

List unused invite codes:

```bash
npm run list:unused -- --campaign 2026-04-28
```

Render reminder templates:

```bash
npm run render -- --campaign 2026-04-28 --limit 5
```

Generate report:

```bash
npm run report -- --campaign 2026-04-28
```

## Current Layer

The project is now beyond the first CLI layer. It has a SQLite-backed operations ledger, browser automation adapters, a local web console, and repo-owned batch split/send runtime code. Real sends remain explicit and headed.

Implemented:

- SQLite schema
- push/ready import from text or CSV-style files
- `.xlsx` upload and split for send-mail batches
- creator and invite-code upsert
- unused invite query
- template variable rendering
- report export
- headed ProBoost browser session
- ProBoost inbox search by handle
- reminder dry-run / send CLI
- ready-reply classification and second-touch follow-up CLI
- send log persistence
- SQLite-backed send-mail campaigns and batches
- atomic batch claims, runner heartbeat, and stale-run recovery
- explicit retry for hard-failed send-mail batches from the SQLite-backed work-order UI
- React/Vite operator assets for dashboard and send-work-order views
- project-owned send-mail split logic and ProBoost runtime script under `src/sendMailBridge/`

Current gaps:

- `ready-followup` still syncs, classifies, and prepares/sends in one live browser pass.
- Standalone `mail-sync` exists for browser-backed body sync into SQLite.
- Standalone `mail-debug` and the `/mail-debug` acceptance page exist for sanitized ProBoost mail API discovery.
- Mail sync DB idempotency exists: repeated syncs dedupe `mail_messages` by generated provider message id or body hash, and thread sync status/errors are queryable.
- Phase 4 captured inbox rows were cross-checked locally against Phase 5 identity rules; API message ids are better than DOM row hashes.
- Actual registered-list import needs its own recurring operator flow; the existing initial `--ready` import is not enough for the real second-touch funnel.
- DB-backed `classify-mail` is still planned.
- Send-mail still writes compatibility manifests and passes runner options through environment variables.

## Automation Commands

Open headed browser and save login state:

```bash
npm run login
```

Search inbox by handle:

```bash
npm run search -- --handle jay.alexaa
```

Dry-run reminder for selected handles. This opens the browser, searches matching inbox threads, opens reply, selects/fills the template, and writes send logs without clicking the final send:

```bash
npm run remind -- --campaign 2026-04-28 --handles melmel_6_ --limit 1
```

Actually send. This must be explicit:

```bash
npm run remind -- --campaign 2026-04-28 --handles melmel_6_ --send
```

Dry-run ready-reply second touch from the replied inbox. This scans replied mail, opens each thread, checks for `ready`, extracts phone/contact and invite codes, then selects the WhatsApp follow-up template when contact is present or the registration reminder template when it is not:

```bash
npm run ready-followup -- --max-pages 1 --limit 5
```

Actually send ready-reply follow-ups. This must be explicit:

```bash
npm run ready-followup -- --max-pages 1 --limit 5 --send
```

Multiple exact matches are not sent by default. To force the first result:

```bash
npm run remind -- --campaign 2026-04-28 --handles melmel_6_ --send --force-ambiguous
```

## Safety

Automation defaults to dry-run. Real sending only happens with `--send`.

The runner skips real sending when:

- no inbox result is found
- multiple results are found and `--force-ambiguous` is not set
- template variables are missing
- reply form or template selection fails
- a ready-reply sender is already registered in CRM or passed through `--registered-names`

Every attempt writes a row to `send_logs`.

## Send-Mail Review UI

The project includes a repo-owned batch-send workflow derived from the mature `/Users/depp/send-mail` scripts. Treat `/Users/depp/send-mail` as read-only reference unless explicitly asked otherwise.

Start the local review UI:

```bash
npm run web
```

Open:

```text
http://127.0.0.1:8787
```

Workflow:

1. Select one or more local `.xlsx` creator files.
2. Choose a batch size.
3. Upload and split into batch files.
4. Review generated batches in the page. The CRM stores campaigns and batches in SQLite.
5. Fill the ProBoost template name for the batch.
6. Click `有头发送` for a single batch, or `连续有头发送 pending` for all pending batches.

Notes:

- All ProBoost publishing uses headed Microsoft Edge through the project-owned runtime in `src/sendMailBridge/runtime/`.
- Template names are passed through to ProBoost as `TEMPLATE_NAME`. Common values are `0414新规模板` and `0421三图模板`, and the field also accepts custom template names.
- Batch send status is stored in SQLite. Terminal results are also synced into CRM-visible logs where available.
- The ProBoost sent-mail page is only used by the underlying browser workflow when verification is explicitly enabled.
- Compatibility `manifest.json` files may still be generated for the current runner contract, but they are not the CRM source of truth.
- The remaining migration work is tracked in `docs/send-mail-sqlite-migration-plan.md`.
