# Mail Sync Phase 0-5 Handoff

Status as of 2026-05-09. Phase 8 has landed on top of the Phase 0-5 foundation: API-backed detail sync is wired into `mail-sync`, standalone DB-backed classification is available through `npm run classify-mail`, actual registered-list import is available through `npm run import-registered`, and selected-target reply template/editor fill has been stabilized against the current ProBoost composer.

## What Landed

### Phase 0: Diagnostics

- `captureDomFailure()` now writes richer JSON diagnostics under `reports/dom-failures/`.
- Diagnostic payloads include visible buttons, links, Ant Design select labels, active dropdown options, mail table headers, route/hash, screenshot path, and JSON path.
- Web task errors surface diagnostic JSON paths when available.

Key files:

- `src/automation/domActions.js`
- `src/automation/mailClient.js`
- `src/web/server.js`
- `src/web/public/app.js`

### Phase 1: Standalone Mail Sync

- `npm run mail-sync` exists.
- `runMailSyncBatch(db, options)` syncs mail bodies into SQLite without classifying or sending.
- Thread key and persistence helpers moved into reusable mail-sync code.
- `mail-sync` writes `mail_threads` and `mail_messages`; it does not write `send_logs`.

Key files:

- `src/automation/mailSyncRunner.js`
- `src/automation/mailSyncPersistence.js`
- `src/cli/index.js`
- `package.json`

### Phase 2: Replied Mail Entry

- `enterMailbox(page, { mailbox })` supports `inbox` and `replied`.
- Replied entry attempts:
  - configured `REPLIED_URL`, when present
  - exact labels: `已回复`, `已回信`, `已收到回复`, `回复`
  - fuzzy label containing `回复`
  - inbox fallback with reply-like row filtering
- `enterRepliedInbox(page)` remains as a compatibility wrapper.

Key files:

- `src/automation/mailClient.js`
- `src/automation/selectors.js`
- `src/config.js`

### Phase 3: Detail Opening

- Opening a row now tries named strategies:
  - `dom-known-cell`
  - `mouse-cell-center`
  - `double-click-row-center`
  - `focus-enter`
  - `click-pointer-ancestor`
  - `href-navigate`
- `openInboxResult()` returns the successful `openStrategy`.
- Failed detail opens record row text, row HTML, target coordinates, URL before/after, and attempted strategies in diagnostics.
- `mail-sync` result rows include `openStrategy`.

Key files:

- `src/automation/domActions.js`
- `src/automation/mailClient.js`
- `src/automation/mailSyncRunner.js`

### Phase 4: Mail API Discovery

- `npm run mail-debug` exists.
- Discovery launches the authenticated browser, attaches request/response listeners, opens a mailbox, optionally opens the first row, and saves sanitized artifacts.
- Saved artifacts live under `reports/mail-debug/<run-id>/`:
  - `requests.json`
  - `responses.json`
  - `candidates.json`
  - `summary.json`
- Default capture redacts emails and token-like values, and never writes cookie/auth headers.
- Full payload preview remains gated behind `MAIL_DEBUG_RAW=1`.
- `/mail-debug` provides a front-end acceptance page for running discovery and reviewing candidate endpoints.

Key files:

- `src/automation/mailApiDiscovery.js`
- `src/automation/mailApiClient.js`
- `src/web/server.js`
- `src/web/views/layout.js`
- `src/web/public/app.css`
- `src/web/public/app.js`

### Phase 5: DB Idempotency

- `mail_threads` now has nullable `sync_status`, `last_sync_error`, `last_open_strategy`, and `raw_snapshot_path`.
- `mail_messages` now has nullable `provider_message_id`, `body_hash`, and `sync_run_id`.
- Unique indexes prevent duplicate messages by `provider_message_id` or by `(thread_id, body_hash)`.
- `persistThreadRead()` computes body hashes and generated DOM message ids, and repeated syncs update the existing message row instead of inserting duplicates.
- Thread fallback now prefers a normalized body-text hash after URL ids, reducing row-hash thread splits when visible row metadata changes.
- Failed row sync attempts are persisted with `sync_status = 'failed'` and `last_sync_error`.

Key files:

- `src/db/schema.js`
- `src/db/index.js`
- `src/automation/mailSyncPersistence.js`
- `src/automation/mailSyncRunner.js`

### Phase 6: API-Backed Detail Sync

- `mailApiClient` now defaults to the reviewed ProBoost receive endpoints:
  - `POST /api/v1/email/receive/list`
  - `POST /api/v1/email/receive/detail`
- `mail-sync` attempts API list/detail reads through browser-context auth before DOM detail opening.
- API-backed reads persist `provider_thread_id` and `provider_message_id` as `api:email/receive:<id>`.
- `--detail-source dom` forces the old DOM path; `--detail-source api` disables DOM fallback for stricter API validation.

Key files:

- `src/automation/mailApiClient.js`
- `src/automation/mailSyncRunner.js`
- `src/automation/mailSyncPersistence.js`

### Phase 7: Standalone Classification

- `npm run classify-mail` classifies already-synced inbound messages from SQLite.
- It skips messages that already have an `analysis_results` row for the same `prompt_version`.
- It persists `analysis_results` and creates `manual_review_items` for manual-review/low-confidence cases.
- It does not open a browser and does not write `send_logs`.

Key files:

- `src/automation/classificationRunner.js`
- `src/cli/index.js`
- `package.json`

### Phase 8: Actual Registration Import

- `npm run import-registered` imports actual registered/activated lists from
  `.xlsx`, `.xls`, `.csv`, `.tsv`, or text files.
- Matching prefers invite code and then unique handle/name/email matches.
- Matched rows update `creators.status = 'registered'` and
  `invite_codes.status = 'used'`.
- Matched rows write `creator_activation_events` audit entries.
- Unmatched and ambiguous rows are returned in CLI JSON output.

Key files:

- `src/importer/importRegistered.js`
- `src/db/schema.js`
- `src/db/index.js`
- `src/cli/index.js`
- `package.json`

### Reply Composer Stabilization

- `replyToOpenedThread()` now passes rendered template data into template
  selection so it can distinguish "template selected" from "rendered body
  verified".
- Template selection confirms the target radio is checked and the send button is
  available; rendered body insertion is verified separately.
- The current ProBoost editor behaves like wangEditor/Slate rather than Quill.
  The fill path now falls back through paste/Slate-compatible DOM insertion and
  verifies that dynamic rendered lines exist in the editor.
- A dry-run no longer reports success if the editor still contains placeholders
  such as `${达人名称}`.
- `AUTOMATION_DEBUG=1` captures reply checkpoints under `reports/dom-failures/`
  with template radio state, subject inputs, editor previews, buttons, and
  dialogs.

Key file:

- `src/automation/mailClient.js`

## Verification Performed

Static checks passed:

```bash
node -c src/automation/domActions.js
node -c src/automation/mailClient.js
node -c src/automation/mailSyncRunner.js
node -c src/automation/mailSyncPersistence.js
node -c src/automation/mailApiDiscovery.js
node -c src/automation/mailApiClient.js
node -c src/automation/reminderRunner.js
node -c src/cli/index.js
node -c src/web/server.js
```

Phase 5 static checks passed:

```bash
node -c src/db/schema.js
node -c src/db/index.js
node -c src/automation/mailSyncPersistence.js
node -c src/automation/mailSyncRunner.js
```

CLI checks passed:

```bash
npm run mail-sync -- --help
npm run mail-debug -- --help
npm run import-registered -- --help
```

Reply composer smoke passed:

```bash
node --check src/automation/mailClient.js
node -e "require('./src/automation/mailClient')"
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
npm run remind -- --campaign 2026-04-28 --handles ambernicole_finds --force-ambiguous
```

The debug checkpoint confirmed `督促产品使用` was checked and the editor
contained rendered text including `Hi ambernicole_finds!` and
`Your invite code is: ZKCW45`.

SQLite safety check passed against a temporary database:

- Same provider thread key reused one `mail_threads` row.
- `send_logs` stayed at 0.

Phase 5 SQLite idempotency check passed against a temporary database:

- Re-syncing the same DOM-read message returned the same `mail_messages.id`.
- The database stayed at one `mail_threads` row and one `mail_messages` row.
- Successful sync wrote `sync_status = 'body-synced'` and `last_open_strategy`.
- Failed sync wrote `sync_status = 'failed'` and `last_sync_error`.

Phase 4 captured data cross-check passed locally:

- The captured `email/receive/list` response contained ProBoost-native ids for the same 10 inbox rows that existed in the local SQLite DB.
- New Phase 5 body hashing produced no duplicate `provider_message_id` or `(thread_id, body_hash)` conflicts.
- ProBoost `email/receive/list` ids were more stable than the old DOM row hashes and were used to backfill the local ignored SQLite DB.
- Local backfill/report artifacts were intentionally not committed. Reproduce by reading `reports/mail-debug/<run-id>/responses.json` when available, matching list rows to existing `mail_messages`, and backfilling `provider_thread_id`, `provider_message_id`, `body_hash`, `sync_status`, and `sync_run_id`.

## Verification Gaps

- A real headed `/mail-debug` run still needs to be performed after ProBoost login is valid.
- Headless `mail-debug` smoke previously failed in this environment because Microsoft Edge closed during persistent-profile launch with `kill EPERM`.
- The `/mail-debug` page still needs manual browser inspection after a current web server smoke.
- Real headed `mail-sync` still needs to be run against a current login to validate the live API request payloads.
- A controlled one-handle real `--send` smoke still needs operator approval to validate the final confirmation chain after the editor-fill fix.
- `npm run verify:followup` currently fails because `scripts/verify-followup.js`
  imports the removed `../src/sendMailBridge/paths` module.

## Remaining Work

Next recommended order:

1. Refactor `ready-followup`:
   - consume DB-backed synced/classified rows
   - keep real send explicit with `--send`
2. Add web upload/control for registered-list import, building on the completed
   CLI import.
3. Update or replace `scripts/verify-followup.js` so it targets the current
   repo-owned runtime layout.

## Potential Issues To Watch

- Message duplication risk is now mitigated by Phase 5 hashes and unique indexes. Repeated DOM syncs should update existing messages when the provider id or body hash is stable.
- `providerThreadId` still falls back when ProBoost URL does not expose a stable id, but fallback now prefers normalized body text over row metadata. Failed opens can still only use row metadata because no body is available yet.
- Inbox fallback for replied mail still depends on visible row text containing reply-like status. If ProBoost does not expose reply state in rows, API-backed list sync is the proper fix.
- Detail body extraction still uses `document.body.innerText`, which can include UI chrome and may change with layout. API-backed detail sync remains the largest data-quality improvement.
- `mail-debug` is observational only; candidate URLs must be reviewed before any API-backed sync integration.
- `MAIL_DEBUG_RAW=1` can capture larger payload previews. Use it only when needed, keep reports local, and do not commit `reports/mail-debug/`.
- The web acceptance page is server-rendered. If `/followup` later moves to React, keep `/mail-debug` either server-rendered intentionally or migrate it as a full panel.
- Do not run more than one headed Edge automation using the same profile at the same time.
