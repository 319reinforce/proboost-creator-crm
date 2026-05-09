# Automation Adapter

This folder contains the CRM-native Playwright adapter for ProBoost browser automation.

Main APIs:

```js
searchInboxByHandle(page, handle)
enterRepliedInbox(page)
extractInboxRows(page)
reopenInboxResult(page, row, pageIndex)
extractOpenedThreadText(page)
replyToOpenedThread(page, options)
verifySentRecord(page, handle)
```

Higher-level runners:

- `mailSyncRunner.js`: syncs ProBoost mail bodies into SQLite without
  classifying or sending. API detail sync is preferred, with DOM opening as
  fallback.
- `classificationRunner.js`: classifies already-synced inbound messages from
  SQLite without opening a browser or writing send logs.
- `reminderRunner.js`: owns the legacy all-in-one ready-followup path and the
  selected-target reminder path used by `/followup` creator management.

Current status as of 2026-05-09:

- selected-target `remind` dry-run is verified against the live ProBoost reply
  composer
- template radio selection is verified before continuing
- the current wangEditor/Slate editor is filled with rendered template text and
  checked for dynamic creator/invite-code content before dry-run success or real
  send
- final real-send confirmation needs one controlled headed smoke with a safe
  target

DOM selectors and low-level click/extraction logic live in:

- `selectors.js`
- `domActions.js`

When mailbox DOM operations fail after the browser has launched, diagnostics are written under:

```text
reports/dom-failures/
```

Each failure should include a screenshot path, URL, body text preview, feature name, and row metadata when available.

For reply composer debugging, run with:

```bash
AUTOMATION_DEBUG=1 npm run remind -- --campaign 2026-04-28 --handles <safe-handle> --force-ambiguous
```

Checkpoint diagnostics include template radio state, subject inputs, editor
previews, visible buttons, and dialogs.

Safety defaults:

- dry-run by default
- no send for ambiguous search results
- no send when template variables are missing
- no send when rendered body text cannot be verified in the reply editor
- send logs for every attempt
- screenshots for failures
- real sends only when the caller passes `--send`
