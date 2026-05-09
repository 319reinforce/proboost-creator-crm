# Source Tree

Status date: 2026-05-09

This directory contains the CRM application code. The project is CommonJS-based
Node.js, with a React/Vite frontend bundle for the newer dashboard/send views.

## Entry Points

- `cli/index.js`: command-line interface for imports, reports, browser
  automation, mail sync, classification, and legacy adapters.
- `web/server.js`: Express web console, JSON APIs, job orchestration, uploads,
  logs, and static asset serving.
- `db/schema.js` and `db/index.js`: SQLite schema, migrations, and persistence
  helpers.

## Modules

- `automation/`: ProBoost browser automation, mail sync, API discovery,
  classification runner, and reminder/followup runners.
- `classifier/`: deterministic inbox rules and optional LLM classifier wrapper.
- `importer/`: campaign invite-code imports and actual activation imports.
- `sendMailBridge/`: repo-owned batch split/send workflow and runtime SQLite
  bridge for send-mail work orders.
- `templates/`: template variable detection, validation, and rendering.
- `web/`: Express pages, public JS/CSS assets, and React/Vite client code.
- `reporting/`: campaign report exports.
- `legacyAdapters/`: compatibility wrappers for read-only legacy reference
  projects.

## Current Boundaries

- SQLite is the CRM source of truth.
- `sendMailBridge` still has manifest/env-var compatibility inside the runner
  contract, but production split/send code is owned by this repository.
- `automation/reminderRunner.js` still contains the legacy all-in-one
  `ready-followup` flow; the planned target is DB-backed preview/send from
  synced `mail_messages` and `analysis_results`.
- `automation/mailClient.js` owns the fragile ProBoost UI boundary. Use
  `AUTOMATION_DEBUG=1` for reply composer diagnostics before changing selectors
  or editor-fill behavior.

## Verification Notes

Recently verified:

```bash
node --check src/automation/mailClient.js
node -e "require('./src/automation/mailClient')"
npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
```

Known stale verifier:

```bash
npm run verify:followup
```

It still imports the removed `src/sendMailBridge/paths` module and needs to be
updated to the current repo-owned runtime layout.

