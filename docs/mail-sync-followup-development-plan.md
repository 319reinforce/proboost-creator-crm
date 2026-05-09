# Mail Sync and Followup Development Plan

This plan turns the current ready-followup browser script into a durable mail-sync pipeline. It is written for future implementation work in this repo, not as a product brainstorm.

## Current Status

Status as of 2026-05-08:

- Implemented: current all-in-one `ready-followup` CLI/web action, DOM helper extraction, expanded DOM failure diagnostics, `mail_threads`, `mail_messages`, `analysis_results`, rule classifier, optional LLM classifier wrapper, persistence of opened thread text/classification from the current live browser pass, standalone `mail-sync` using the current DOM detail-opening path, multi-strategy replied mailbox entry, named detail-opening strategies with row diagnostics, sanitized `mail-debug` API discovery artifacts with a web acceptance page, and Phase 5 DB idempotency columns/indexes for mail sync.
- Verified locally: Phase 4 captured inbox rows were cross-checked against Phase 5 identity rules. ProBoost `email/receive/list` ids are better than DOM row hashes, and the local ignored SQLite DB was backfilled with API ids/body hashes for the 10 captured inbox messages.
- Not implemented: `classify-mail`, `classificationRunner`, API-backed detail sync, independent actual-registration import, and DB-backed ready-followup execution.
- Current blocker: discovered ProBoost mail API candidates still need to be wired into `mail-sync`; until then detail body extraction defaults to live DOM navigation.
- Active next step: API-backed detail sync integration, then independent actual-registration import, DB-backed `classify-mail`, and DB-backed ready-followup. Use `docs/next-agent-phase-kickoff.md` as the execution checklist.

## 1. Current Problem

The ready-followup flow currently depends on a fragile UI path:

1. Open ProBoost mail.
2. Select the replied-mail status filter.
3. List inbox rows.
4. Click each row.
5. Wait for the detail view.
6. Read `document.body.innerText`.
7. Persist the thread and message.
8. Classify the reply.
9. Optionally prepare or send a followup.

The immediate failure is in `src/automation/mailClient.js`: `enterRepliedInbox(page)` requires the `已回复` status filter. If that option is not present or ProBoost changes the dropdown text/structure, the whole followup workflow stops before any rows are synced.

The deeper issue is architectural: classification and reply sending currently depend on live browser navigation. They should depend on persisted mail state.

## 2. Target Architecture

Split the work into three independent layers:

```text
ProBoost headed browser session
  -> Mail discovery and detail sync
  -> SQLite mail state
  -> Classification and action planning
  -> Reply preparation / sending
```

The browser remains useful for login, session cookies, UI-only actions, and fallback detail opening. The durable system should treat SQLite as the source of truth after mail is synced.

### New Responsibilities

- `mailClient`: low-level ProBoost browser and network operations.
- `mailSyncRunner`: scans mailbox pages, opens or fetches message details, and writes mail state.
- `classificationRunner`: classifies synced inbound messages.
- `followupRunner`: prepares or sends followups only from classified database rows.
- `web/server`: exposes separate operator actions for sync, classification, and followup execution.

## 3. Guiding Principles

- Real sends stay opt-in with `--send`.
- Syncing mail must be safe to run repeatedly.
- Browser failures must produce diagnostics that let the next agent reproduce the issue.
- DOM automation is a fallback, not the preferred long-term data extraction method.
- Once a message body has been synced, later classification and sending should not need to reopen the mail thread.
- The UI should show which stage failed: mailbox entry, row listing, detail open, body sync, classification, or reply send.

## 4. Phase 0: Instrument the Current Failure

### Goal

Make failures observable before changing behavior.

### Code Changes

- Extend `captureDomFailure()` in `src/automation/domActions.js` to optionally write:
  - visible buttons and links
  - visible Ant Design select labels
  - active dropdown option texts
  - mail table headers
  - current route and hash
- Add a dedicated failure type for replied-filter discovery:
  - `replied-status-filter-not-found`
  - `replied-status-option-not-found`
  - `mail-table-not-found-after-filter`
- Include the diagnostic JSON path in the web task error display.

### Files

- `src/automation/domActions.js`
- `src/automation/mailClient.js`
- `src/web/server.js`
- `src/web/public/app.js`
- `src/web/client/main.jsx` if the React route is active for this panel

### Acceptance Criteria

- A failed inbox sync writes a screenshot and JSON diagnostic under `reports/dom-failures/`.
- The diagnostic includes enough visible text to identify whether the replied filter exists under a different label.
- The web console shows the diagnostic path or summary in the latest task error.

## 5. Phase 1: Build a Mail Sync Runner

### Goal

Create a standalone sync command that only discovers, opens/fetches, and persists mail. It does not classify or send.

### Proposed CLI

```bash
npm run mail-sync -- --mailbox replied --max-pages 1 --limit 10
npm run mail-sync -- --mailbox inbox --max-pages 1 --limit 10
npm run mail-sync -- --mailbox replied --headless
```

### New File

- `src/automation/mailSyncRunner.js`

### Proposed Public Function

```js
async function runMailSyncBatch(db, options) {
  return {
    runId,
    mailbox,
    scannedRows,
    opened,
    bodySynced,
    failed,
    results,
  };
}
```

### Result Item Shape

```js
{
  page: 1,
  rowIndex: 0,
  sender: '',
  subject: '',
  time: '',
  status: 'body-synced',
  stage: 'body-synced',
  threadId: 1,
  messageId: 10,
  providerThreadId: '',
  bodyChars: 1200,
  error: ''
}
```

### Migration from Existing Code

Move or reuse these functions from `src/automation/reminderRunner.js`:

- `deriveThreadKey`
- `persistThreadRead`

They should become reusable mail-sync helpers instead of being private to ready-followup.

### Acceptance Criteria

- `npm run mail-sync -- --mailbox replied --max-pages 1 --limit 1` can either sync one body or produce diagnostics.
- Running the command does not create a send log.
- Running the command twice updates the same `mail_threads` row when the provider key is stable.
- Each successful body read creates a `mail_messages` row.

## 6. Phase 2: Make Replied Mail Entry Multi-Strategy

### Goal

Stop requiring one exact `已回复` dropdown option.

### Strategy Order

1. Navigate to a known replied mailbox route if ProBoost exposes one.
2. Try exact status option labels:
   - `已回复`
   - `已回信`
   - `已收到回复`
   - `回复`
3. Try fuzzy status option matching with normalized text containing `回复`.
4. If no status filter is available, scan the normal inbox and mark `mailbox = inbox`.
5. If row text includes a status column, filter rows client-side by reply-like status.
6. If all strategies fail, emit diagnostics and stop before classification.

### Code Changes

- Replace `selectMailStatus(page, statusText)` with:
  - `openMailStatusDropdown(page)`
  - `listMailStatusOptions(page)`
  - `selectMailStatusByCandidates(page, candidates)`
  - `enterMailbox(page, { mailbox })`
- Keep `enterRepliedInbox(page)` as a compatibility wrapper around `enterMailbox(page, { mailbox: 'replied' })`.

### Files

- `src/automation/mailClient.js`
- `src/automation/selectors.js`
- `src/automation/domActions.js`

### Acceptance Criteria

- If `已回复` is missing but another reply-like label exists, the sync continues.
- If no replied filter exists, the sync can still scan inbox rows in dry-run mode and clearly reports `mailboxFallback: inbox`.
- Existing `ready-followup` command still works through the compatibility wrapper.

## 7. Phase 3: Harden Detail Opening

### Goal

Make opening a specific mail row reliable enough for production sync.

### Current Weakness

`robustOpenMailRow()` dispatches mouse events against likely DOM targets. That can fail when ProBoost attaches handlers to a different ancestor, virtualizes table rows, or opens details through a router event.

### New Opening Strategies

Try in order:

1. DOM click on known subject/sender cell.
2. Real Playwright mouse click at cell center.
3. Double click at row center.
4. Focus row and press `Enter`.
5. Click nearest ancestor with `role=button`, `data-*`, or cursor pointer.
6. If the row exposes an anchor href, navigate to it directly.
7. If network API discovery is available, fetch detail without opening the row.

### Detail Verification

Do not only check for `邮件详情`. Consider a detail open successful if:

- URL changed to a detail-like route, or
- body contains sender and subject plus reply controls, or
- network response returned a message/detail payload, or
- a stable message body container is visible.

### Files

- `src/automation/domActions.js`
- `src/automation/mailClient.js`

### Acceptance Criteria

- Detail-open failures include row DOM HTML, row text, target coordinates, URL before/after, and screenshot.
- `openInboxResult()` returns the opening strategy that succeeded.
- The sync report shows `openStrategy` per row.

## 8. Phase 4: Discover and Use ProBoost Mail APIs

### Goal

Use headed browser login state, but prefer ProBoost network APIs for listing and detail bodies.

### Why

If ProBoost fetches mail rows and bodies through JSON APIs, direct API reads will be more stable than DOM clicking. The browser is still needed for authentication and for real sends if the send API is not stable or safe.

### Discovery Runner

Add a debug mode:

```bash
npm run mail-debug -- --keep-open
```

It should:

- launch the authenticated headed browser
- attach listeners to requests and responses
- record likely mail list/detail/reply endpoints
- let the operator manually click a row
- save sanitized samples under `reports/mail-debug/`

### New Files

- `src/automation/mailApiDiscovery.js`
- `src/automation/mailApiClient.js`

### Saved Debug Artifacts

```text
reports/mail-debug/
  2026-05-06T...-requests.json
  2026-05-06T...-responses.json
  2026-05-06T...-detail-candidate.json
```

### Safety

- Do not log cookies or auth headers.
- Redact obvious tokens, email addresses if needed, and long HTML bodies unless explicitly enabled.
- Keep raw full payload capture behind an environment flag:

```bash
MAIL_DEBUG_RAW=1 npm run mail-debug -- --keep-open
```

### API Client Behavior

`mailApiClient` should reuse browser context cookies or storage state and provide:

```js
listMailRows({ mailbox, page, pageSize })
getMailDetail({ providerThreadId, row })
```

If API extraction fails, fall back to DOM opening.

### Acceptance Criteria

- Manual clicking one mail row produces a candidate detail endpoint in `reports/mail-debug/`.
- If a detail API is identified, `mail-sync` can fetch a body without relying on detail DOM.
- The fallback DOM path remains available.

## 9. Phase 5: Database State Improvements

### Goal

Make mail sync idempotent and queryable.

Status: implemented as of 2026-05-06.

### Current Tables

The repo already has:

- `mail_threads`
- `mail_messages`
- `analysis_results`

### Recommended Additions

Add nullable columns through `migrateDb()`:

#### `mail_threads`

- `sync_status TEXT`
- `last_sync_error TEXT`
- `last_open_strategy TEXT`
- `raw_snapshot_path TEXT`

#### `mail_messages`

- `provider_message_id TEXT`
- `body_hash TEXT`
- `sync_run_id TEXT`

Indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_provider_message
ON mail_messages (provider_message_id)
WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_thread_body_hash
ON mail_messages (thread_id, body_hash)
WHERE body_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_threads_sync_status
ON mail_threads (sync_status);
```

### Why

Without message identity or body hash, repeated scans can create duplicate `mail_messages` rows. That is tolerable for early debugging but bad for production classification and reporting.

### Acceptance Criteria

- Re-running sync for the same visible message does not duplicate `mail_messages`.
- Failed rows can be queried by `sync_status = 'failed'`.
- The UI can show the last sync error per thread.

### Implementation Notes

- `persistThreadRead()` now computes `body_hash` from normalized body text and a generated DOM `provider_message_id`.
- Thread fallback prefers URL ids, then normalized body text, then row metadata only when body text is unavailable.
- `insertMailMessage()` updates an existing row when `provider_message_id` or `(thread_id, body_hash)` matches.
- `persistThreadSyncFailure()` records failed opens in `mail_threads` for later review.
- When ProBoost API ids are available from `email/receive/list`, prefer `api:email/receive:<id>` over generated DOM ids.

## 10. Phase 6: Split Classification from Sending

### Goal

Classify already-synced messages without browser navigation.

### Proposed CLI

```bash
npm run classify-mail -- --limit 50
npm run classify-mail -- --thread-id 123
```

### New File

- `src/automation/classificationRunner.js`

### Behavior

1. Query inbound `mail_messages` that do not have an `analysis_results` row.
2. Run deterministic rules first.
3. Optionally call LLM classifier for ambiguous messages.
4. Persist normalized `analysis_results`.
5. Mark low confidence or support/problem cases for manual review.

### Acceptance Criteria

- Classification works with the browser closed.
- Each classified message gets exactly one latest analysis result for the current classifier version.
- No send action is performed in this phase.

## 11. Phase 7: Refactor Ready Followup to Consume DB State

### Goal

`ready-followup` should stop doing sync, classify, and send in one tightly coupled pass by default.

### New Flow

1. `mail-sync` syncs bodies.
2. `classify-mail` produces actions.
3. `ready-followup` queries `analysis_results` for:
   - `recommended_action = send_whatsapp_followup`
   - `recommended_action = send_register_followup`
   - not already sent
   - not registered
   - not manual review
4. Browser opens only when a reply needs to be prepared or sent.

### Compatibility Mode

Keep the old all-in-one behavior behind an explicit option:

```bash
npm run ready-followup -- --sync-first --max-pages 1 --limit 5
```

Default web UI should use the split workflow.

### Acceptance Criteria

- Dry-run ready-followup can generate recommended followups from existing DB rows with no browser open.
- Real sending still launches headed browser and requires `--send`.
- Each sent or prepared followup references `thread_id`, `message_id`, and `analysis_id` in logs or payload JSON.

## 12. Phase 8: Web Console Changes

### Goal

Make the operator console reflect the new pipeline.

### UI Actions

On the followup page, separate controls:

- `同步已回复邮件`
- `分析未处理邮件`
- `预览二次触达`
- `发送二次触达`

### UI Metrics

- listed rows
- detail opened
- body synced
- sync failed
- unclassified messages
- classified ready
- manual review
- prepared followups
- sent followups

### Task Views

Recent tasks should show:

- task type
- started/finished time
- status
- current stage
- diagnostic path
- row-level failures

### Acceptance Criteria

- A sync failure is understandable from the UI without opening terminal logs.
- The operator can run sync without risking real sends.
- The operator can preview send candidates before sending.

## 13. Phase 9: Manual Review Queue

### Goal

Route ambiguous or risky messages away from automation.

### Cases

- not ready / not yet
- cannot register
- login or product error
- asks a question
- angry or negative sentiment
- language not confidently parsed
- possible already registered
- contact value detected but action is unclear

### Existing Table

Use `manual_review_items`.

### UI Minimum

- list open review items
- show sender, subject, body preview, classification reason
- mark as resolved
- choose action manually:
  - ignore
  - send WhatsApp followup
  - send register reminder
  - do not contact

## 14. Suggested Implementation Order

1. Phase 0 diagnostics.
2. Phase 1 `mail-sync` runner using current DOM opening.
3. Phase 2 replied mailbox multi-strategy entry.
4. Phase 3 detail opening hardening.
5. Phase 4 mail API discovery.
6. Phase 5 DB idempotency columns and indexes.
7. Phase 6 standalone classification.
8. Actual-registration import before DB-backed ready-followup filtering.
9. Phase 7 ready-followup DB-backed refactor.
10. Phase 8 web console split controls.
11. Phase 9 manual review queue.

This order keeps the system usable after every phase and avoids making classification or sending depend on unproven sync changes.

## 15. Test and Verification Plan

### Static Checks

Run after every code phase:

```bash
node -c src/automation/mailClient.js
node -c src/automation/domActions.js
node -c src/automation/reminderRunner.js
node -c src/db/index.js
node -c src/web/server.js
```

Include any new files in `node -c`.

### Database Checks

Use a temporary SQLite database for unit-like checks:

```bash
CRM_DB_PATH=/tmp/proboost-mail-sync-test.sqlite npm run init
```

Verify:

- migrations add expected columns
- duplicate body hash does not duplicate messages
- `analysis_results` links to `mail_messages`
- task runs persist success and failure payloads

### Browser Checks

Headed:

```bash
npm run mail-sync -- --mailbox replied --max-pages 1 --limit 1
```

Headless smoke where login state supports it:

```bash
npm run mail-sync -- --mailbox replied --max-pages 1 --limit 1 --headless
```

Debug:

```bash
npm run mail-debug -- --keep-open
```

### Safety Checks

- `mail-sync` never writes `send_logs`.
- `classify-mail` never opens browser and never sends.
- `ready-followup` sends only with explicit `--send`.
- Web sync/classify buttons cannot trigger send.

## 16. Rollback Strategy

- Keep existing `ready-followup` command working while new commands are introduced.
- Add compatibility wrappers instead of deleting old exports immediately.
- Put API-based body extraction behind an option or automatic fallback:

```bash
MAIL_DETAIL_SOURCE=api
MAIL_DETAIL_SOURCE=dom
MAIL_DETAIL_SOURCE=auto
```

- If API extraction is wrong, switch back to `dom` without reverting database and UI work.
- If DB idempotency migration causes an issue, preserve nullable columns and disable unique-index usage in insert helpers while investigating.

## 17. Done Definition

This work is complete when:

- The operator can sync replied mail bodies into SQLite without sending.
- Classification can run from SQLite with the browser closed.
- Ready followup can preview candidates from persisted classification results.
- Real send remains headed, explicit, logged, and linked back to the source message.
- A failed mailbox run produces actionable diagnostics in `reports/dom-failures/` or `reports/mail-debug/`.
- The web console separates sync, analysis, preview, and send actions.
