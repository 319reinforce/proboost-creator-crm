# ProBoost Creator CRM

`proboost-creator-crm` is the next-stage CRM project for ProBoost creator operations.

Agent handoff rule: future coding agents must read `docs/agent-git-workflow.md` before editing. Use GitHub as the remote and create a new working branch before every code change. For followup automation work, also read `docs/followup-optimization-plan.md`.
For send-mail batch-state migration work, read `docs/send-mail-sqlite-migration-plan.md`.

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

This first layer is a Stable CLI foundation. It intentionally does not send real emails yet.

Implemented:

- SQLite schema
- push/ready import from text or CSV-style files
- creator and invite-code upsert
- unused invite query
- template variable rendering
- report export
- headed ProBoost browser session
- ProBoost inbox search by handle
- reminder dry-run / send CLI
- ready-reply classification and second-touch follow-up CLI
- send log persistence

Excel import is intentionally deferred because the common `xlsx` package currently has unresolved advisories. Export sheets to CSV/text for Layer 1.

Next layers:

- inbox sync and reply registration
- semantic classification
- manual review queue
- web operator console

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

The project also integrates the mature batch-send workflow from `/Users/depp/send-mail`.

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
4. Review generated batches in the page.
5. Fill the ProBoost template name for the batch.
6. Click `有头发送` for a single batch, or `连续有头发送 pending` for all pending batches.

Notes:

- All ProBoost publishing uses headed Microsoft Edge through the existing `send-mail/proboost-auto.js` engine.
- Template names are passed through to ProBoost as `TEMPLATE_NAME`. Common values are `0414新规模板` and `0421三图模板`, and the field also accepts custom template names.
- Sent-mail data is not copied into CRM storage.
- The ProBoost sent-mail page is only used by the underlying browser workflow when verification is explicitly enabled.
- Batch status is stored only in each generated `manifest.json`.
- Migration away from manifest-owned batch state is planned in `docs/send-mail-sqlite-migration-plan.md`; Phase 1 mirrors split/run state into SQLite while preserving the legacy workflow.
