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

DOM selectors and low-level click/extraction logic live in:

- `selectors.js`
- `domActions.js`

When mailbox DOM operations fail after the browser has launched, diagnostics are written under:

```text
reports/dom-failures/
```

Each failure should include a screenshot path, URL, body text preview, feature name, and row metadata when available.

Safety defaults:

- dry-run by default
- no send for ambiguous search results
- no send when template variables are missing
- send logs for every attempt
- screenshots for failures
- real sends only when the caller passes `--send`
