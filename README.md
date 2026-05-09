# ProBoost Creator CRM

`proboost-creator-crm` is the next-stage CRM project for ProBoost creator operations.

Agent handoff rule: future coding agents must read `docs/agent-git-workflow.md` before editing. Use GitHub as the remote and create a new working branch before every code change. Start with `docs/README.md` for the current documentation map, then read `docs/current-project-overview.md` for the detailed current architecture and operating model. For followup automation work, read `docs/mail-sync-followup-development-plan.md`; `docs/followup-optimization-plan.md` is retained as historical context.
For send-mail batch-state migration work, read `docs/send-mail-sqlite-migration-plan.md`.
For continuing the next implementation phases, start with `docs/next-agent-phase-kickoff.md`.

It turns one-off reminder scripts into a structured workflow:

1. Import pushed invite-code lists.
2. Import ready/registered lists and later actual activation lists.
3. Maintain creator and invite-code state in SQLite.
4. List creators who have not used their invite codes.
5. Render reminder templates with invite-code variables.
6. Generate daily audit reports.
7. Sync inbox replies, classify intent, and send reminders through ProBoost automation.

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

Import the latest actual registered/activated list:

```bash
npm run import-registered -- --file /path/to/registered.xlsx --campaign 2026-04-28
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

Status date: 2026-05-09.

The project is now beyond the first CLI layer. It has a SQLite-backed operations ledger, browser automation adapters, a local web console, and repo-owned batch split/send runtime code. Real sends remain explicit and headed.

Implemented:

- SQLite schema
- push/ready import from text or CSV-style files
- actual registered/activated import from `.xlsx`, `.xls`, `.csv`, `.tsv`, or text
- `.xlsx` upload and split for send-mail batches
- creator and invite-code upsert
- unused invite query
- template variable rendering
- report export
- headed ProBoost browser session
- ProBoost inbox search by handle
- reminder dry-run / send CLI
- ready-reply classification and second-touch follow-up CLI
- standalone mail sync from ProBoost into SQLite
- standalone DB-backed classification through `npm run classify-mail`
- actual registered/activated-list import through `npm run import-registered`
- send log persistence
- SQLite-backed send-mail campaigns and batches
- atomic batch claims, runner heartbeat, and stale-run recovery
- explicit retry for hard-failed send-mail batches from the SQLite-backed work-order UI
- React/Vite operator assets for dashboard and send-work-order views
- project-owned send-mail split logic and ProBoost runtime script under `src/sendMailBridge/`
- followup creator management UI for pending/activated invite-code rows
- manual activation marking and selected-creator dry-run second touch
- reply template automation that verifies the chosen template radio, fills the wangEditor/Slate editor with rendered creator/invite-code text, and captures debug checkpoints with `AUTOMATION_DEBUG=1`

Current gaps:

- `ready-followup` still syncs, classifies, and prepares/sends in one live browser pass.
- Standalone `mail-sync` exists for browser-backed body sync into SQLite.
- Standalone `mail-debug` and the `/mail-debug` acceptance page exist for sanitized ProBoost mail API discovery.
- Mail sync DB idempotency exists: repeated syncs dedupe `mail_messages` by generated provider message id or body hash, and thread sync status/errors are queryable.
- Phase 4 captured inbox rows were cross-checked locally against Phase 5 identity rules; API message ids are better than DOM row hashes.
- API-backed mail detail sync is wired as the preferred `mail-sync` path with DOM fallback.
- DB-backed `classify-mail` exists and classifies synced inbound messages without opening the browser or sending.
- Actual registered-list import exists through `npm run import-registered` and writes activation audit rows.
- `/followup` now includes a creator management surface for pending versus activated invite-code rows, manual activation marking, and selected-creator dry-run second touch.
- Selected-target reply dry-run is verified against a live ProBoost thread: template selection and editor fill now work for the current ProBoost editor. A controlled one-handle `--send` smoke still needs operator approval before claiming the final confirmation path fully production-ready.
- Send-mail still writes compatibility manifests and passes runner options through environment variables.
- `npm run verify:followup` currently fails because `scripts/verify-followup.js` still imports the removed `../src/sendMailBridge/paths` module. The verifier needs to be updated to the current repo-owned runtime layout.

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

Debug the live reply composer without sending:

```bash
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles melmel_6_ --force-ambiguous
```

Debug checkpoints are written under `reports/dom-failures/` and include template radio state, subject fields, editor previews, visible buttons, dialogs, and screenshots when Playwright can capture them.

Dry-run ready-reply second touch from the replied inbox. This scans replied mail, opens each thread, checks for `ready`, extracts phone/contact and invite codes, then selects the WhatsApp follow-up template when contact is present or the registration reminder template when it is not:

```bash
npm run ready-followup -- --max-pages 1 --limit 5
```

Actually send ready-reply follow-ups. This must be explicit:

```bash
npm run ready-followup -- --max-pages 1 --limit 5 --send
```

Classify already-synced inbound messages from SQLite without opening a browser:

```bash
npm run classify-mail -- --limit 50
```

Import an actual activation list independently from the initial campaign import:

```bash
npm run import-registered -- --file /path/to/registered.xlsx --campaign 2026-04-28
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
- rendered text cannot be verified in the reply editor
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
http://127.0.0.1:8794
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
