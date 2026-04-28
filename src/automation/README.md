# Automation Adapter

This folder is reserved for the Playwright adapter that will wrap the existing ProBoost browser automation.

Planned APIs:

```js
searchInboxByHandle(handle)
openThread(searchResult)
readThread()
replyWithRenderedTemplate(thread, renderedTemplate)
verifySent(handle, subjectKeyword)
```

Safety defaults:

- dry-run by default
- no send for ambiguous search results
- no send when template variables are missing
- send logs for every attempt
- screenshots for failures
