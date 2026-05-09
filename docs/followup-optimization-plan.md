# Ready Followup Optimization Plan

> Status: historical context. Some directions in this file have already been implemented, partially implemented, or superseded. For new replied-mail sync and DB-backed followup work, use `docs/mail-sync-followup-development-plan.md` as the active implementation plan.

This document is for future agents taking over ProBoost Creator CRM followup work.

Read first:

1. `docs/agent-git-workflow.md`
2. `docs/handoff.md`
3. `docs/mail-sync-followup-development-plan.md`
4. This document for older context when needed

Before changing code, create a new working branch from GitHub as described in `docs/agent-git-workflow.md`.

## Current Context

The CRM has two related implementations:

- CRM-native workflow:
  - `src/automation/mailClient.js`
  - `src/automation/reminderRunner.js`
  - `src/classifier/inboxRules.js`
  - `src/web/server.js`
- Legacy reference workflow:
  - `/Users/depp/proboost-ready-reminder/proboost-replied.js`
  - `/Users/depp/proboost-ready-reminder/unused-invite-reminder.js`

The most fragile area is ProBoost mailbox DOM automation. The native CRM flow can enter the replied inbox, list rows, open threads, read text, classify replies, and prepare followups, but this depends on ProBoost UI selectors and click behavior that may change.

Latest status as of 2026-05-09:

- The selected-target reminder path has been stabilized against the current
  ProBoost reply composer.
- Template selection now verifies the target radio state.
- The current wangEditor/Slate body editor is filled with rendered dynamic text
  and checked before dry-run success or real send.
- `AUTOMATION_DEBUG=1` writes reply checkpoints under `reports/dom-failures/`.
- The remaining active plan is still `docs/mail-sync-followup-development-plan.md`;
  this file remains historical context.

## Progress Against This Plan

- Direction A is partially implemented: `selectors.js`, `domActions.js`, row extraction, row opening helpers, and basic failure screenshots/JSON exist.
- Direction C is implemented at the schema/helper level: `mail_threads`, `mail_messages`, `analysis_results`, `upsertMailThread`, `insertMailMessage`, and `insertAnalysisResult` exist, and `ready-followup` writes opened thread text/classification.
- Direction D is largely implemented through the send-mail SQLite migration: batch send state is mirrored and updated in SQLite, and production split/send entrypoints are now repo-owned.
- Direction B is partially implemented: deterministic rules and optional LLM wrapper exist, but classification is still coupled to the live browser followup pass by default.
- Direction E is partially implemented: React/Vite assets and JSON APIs exist for dashboard/send, while `/followup` still uses the legacy server-rendered surface.
- Selected-target reply template/editor automation is implemented and dry-run
  verified. A controlled one-handle real-send smoke remains before claiming the
  final confirmation path fully verified.

## Recommended Order

Implement in this order:

1. Direction A: DOM operation stabilization layer
2. Direction C: `mail_threads` / `mail_messages` persistence
3. Direction D: `sendMailBridge` result sync back to CRM
4. Direction B: optional LLM semantic classification
5. Direction E: Web console progressive enhancement

Do not start with LLM classification. It depends on stable thread extraction and should be layered on top of a persistent mail history.

## Priority Rationale

### Why Direction A Comes First

DOM stabilization has the highest immediate ROI. If the CRM cannot reliably enter the replied inbox, open the correct thread, and read body text, every downstream feature is built on unstable input.

This should be treated as the first foundation task because:

- ProBoost UI selectors and click targets are the most fragile part of the current workflow.
- Failures are hard to diagnose unless screenshots, URL, and DOM previews are captured.
- Stabilizing DOM helpers does not require changing the business workflow.
- Future ProBoost UI changes should be handled by editing selector maps, not rewriting batch logic.

### Why Direction C Comes Before LLM

Persisted mail threads are the CRM's evidence layer. Once the CRM can open and read threads, it should store the conversation before adding smarter interpretation.

This unlocks:

- creator history views
- manual review
- repeat-run auditability
- duplicate prevention
- later LLM result traceability

LLM classification without stored thread history is harder to debug because there is no durable record of what text the model saw.

### Why Direction D Comes Before LLM

`sendMailBridge` result sync is more system-critical than LLM classification. Today, the batch send workflow writes status to `manifest.json`, while CRM-native sends write `send_logs`. This splits the operational ledger.

Without syncing bridge results into CRM:

- CRM undercounts total sends.
- Creator timelines miss batch outreach.
- Followup logic cannot reliably know who was already contacted.
- Operators must reconcile `manifest.json`, log files, and SQLite manually.

LLM improves classification quality; bridge sync improves data integrity. Data integrity should come first.

### Why Direction B Is Still Needed

`inboxRules.js` is currently keyword-heavy. A `ready` match can misclassify:

- `not ready yet`
- `I am ready but cannot register`
- `I used it but got an error`
- `ready? what should I do next`

LLM classification is necessary for nuanced language, negation, mixed intent, and Chinese/English variants. But it must be optional, degraded safely, and normalized into fixed enums before any workflow acts on it.

### Why Direction E Is Last

The web console needs improvement, but the most valuable UI depends on the data foundations above.

CSS and layout cleanup can happen early because it is low risk. Larger UI features, especially creator detail pages, should wait until `mail_threads`, `mail_messages`, `analysis_results`, and send bridge logs are available in CRM.

## Direction A: DOM Operation Stabilization Layer

### Goal

Move scattered DOM selector and click logic out of `mailClient.js` into version-aware helper modules.

Expected new files:

- `src/automation/selectors.js`
- `src/automation/domActions.js`

Keep `mailClient.js` as the high-level ProBoost mail API. It should call robust helpers instead of embedding every selector directly.

### Initial Selector Map

Start with a simple object. Do not over-engineer.

```js
const SELECTORS = {
  mailModule: {
    text: '邮件',
    variants: [
      'button',
      '[role="button"]',
      'nav *',
      'aside *',
    ],
  },
  inboxTab: {
    text: '收件箱',
    variants: [
      '.mail-left .main-left-tab',
      '.main-left-tab',
      '[class*="left-tab"]',
      'button',
      'a',
    ],
  },
  mailTable: {
    requiredText: ['发件人', '送达时间'],
    variants: [
      'table',
      '.ant-table',
    ],
  },
  repliedStatus: {
    text: '已回复',
    variants: [
      '.ant-select',
      '.ant-select-selector',
      '.ant-select-item-option',
    ],
  },
  replyButton: {
    texts: ['回复', '回复邮件'],
    variants: [
      'button',
      '[role="button"]',
      'a',
    ],
  },
};

module.exports = { SELECTORS };
```

### Helper Functions

Implement the following helpers in `src/automation/domActions.js`:

- `visible(element)`
- `normalizeText(value)`
- `clickVisibleExactText(page, label, selectors)`
- `findMailTable(page, options)`
- `extractMailRows(page)`
- `robustClick(page, feature, options)`
- `robustOpenMailRow(page, rowIndex, options)`
- `waitForMailDetail(page, row, options)`
- `captureDomFailure(page, feature, metadata)`

`captureDomFailure` should write:

- screenshot path under `reports/dom-failures/`
- current URL
- body text preview
- feature name
- row metadata if available

Return the failure payload and include its summary in thrown errors.

### Migration Steps

1. Add `selectors.js` and `domActions.js`.
2. Move current `clickVisibleExactText` from `mailClient.js` into `domActions.js`.
3. Move mail table row extraction into `extractMailRows`.
4. Replace `extractInboxRows(page)` internals with `extractMailRows(page)`.
5. Replace `clickInboxRow`, `clickInboxRowInMailTable`, and `waitForEmailDetail` with helper calls.
6. Keep exported function names from `mailClient.js` stable so `reminderRunner.js` does not need broad changes.

### Acceptance Criteria

- `npm run ready-followup -- --max-pages 1 --limit 1 --headless` can enter replied inbox and either:
  - read one thread with `threadChars > 0`, or
  - fail with a screenshot and DOM preview under `reports/dom-failures/`.
- `/followup` displays row stage transitions through:
  - `listed`
  - `opening`
  - `opened`
  - `thread-read`
  - `classified`
- `node --check` passes for changed JS files.
- No real email is sent unless `--send` is explicitly provided.

### Risks

- Shared Edge profile conflicts can prevent browser startup before DOM logic runs. If this happens, fix or close the profile owner before judging DOM helper quality.
- ProBoost may render multiple tables. Always identify the mail table by required headers, not by first table position.

## Direction C: Persist Mail Threads and Messages

### Goal

When a thread is opened and text is read, persist the conversation into CRM tables:

- `mail_threads`
- `mail_messages`
- `analysis_results`

### Database Functions

Add helpers in `src/db/index.js`:

- `upsertMailThread(db, payload)`
- `insertMailMessage(db, payload)`
- `insertAnalysisResult(db, payload)`

Use existing schema first. Only migrate schema if a required field cannot be represented.

### Integration Point

In `src/automation/reminderRunner.js`, after `thread-read` and before classification:

```js
const threadRecord = upsertMailThread(db, {
  provider_thread_id: deriveThreadKey({ page, row, threadText }),
  mailbox: 'inbox',
  sender: row.sender,
  subject: row.subject,
  first_message_at: row.time,
  last_message_at: new Date().toISOString(),
});

const messageRecord = insertMailMessage(db, {
  thread_id: threadRecord.id,
  direction: 'inbound',
  subject: row.subject,
  sender: row.sender,
  body_text: threadText,
  received_at: row.time,
});
```

After classification, write `analysis_results` linked to `messageRecord.id`.

### Thread Identity

Preferred order:

1. Stable provider thread id from URL, if available.
2. Hash of `sender + subject + row.time`.
3. Hash of `sender + subject + first 500 chars of threadText`.

Do not use raw full body text as a unique key.

### Acceptance Criteria

- Each opened thread creates or updates one `mail_threads` row.
- Each read event creates a `mail_messages` row with non-empty `body_text`.
- Classification results are persisted to `analysis_results`.
- Re-running the same scan does not create duplicate `mail_threads` for the same provider key.

## Direction B: Optional LLM Semantic Classification

### Goal

Add semantic classification as an optional enhancement over `inboxRules.js`.

The deterministic classifier remains the fallback and must continue to work without API credentials.

This is a two-layer classifier, not an LLM replacement of rules:

1. Run rule-based classification first.
2. Return immediately for high-confidence deterministic cases.
3. Call the LLM only for ambiguous or complex cases.
4. If the LLM is unavailable, malformed, or lower-confidence, fall back to rules.

### Rule Layer Improvements First

Before adding LLM calls, improve rule confidence and negation handling:

- `skip_registered`: if registered list matches sender, confidence should be high, usually `0.95`.
- ready with clear phone/WhatsApp/contact: `send_whatsapp_followup`, high confidence.
- ready without contact: `send_register_followup`, medium-high confidence.
- negation phrases such as `not ready`, `not yet`, `haven't`, `later`, `not now`: do not trigger a send action.
- support/error language such as `error`, `cannot register`, `failed`, `can't login`: route to `manual_review` or future support action.

Do not keep every rule result at fixed `0.85` or `0.2`; downstream logic needs meaningful confidence differences.

### Proposed File

- `src/classifier/llmClassifier.js`

Optional wrapper file:

- `src/classifier/classify.js`

If a wrapper is introduced, keep the existing `classifyInboxReply` export stable or update all call sites in one patch.

### Environment Flags

Use explicit opt-in:

```bash
ENABLE_LLM_CLASSIFIER=1
OPENAI_API_KEY=...
LLM_CLASSIFIER_MODEL=gpt-4o-mini
```

If any required value is missing, fall back to `classifyInboxReply`.

### Proposed Flow

```js
async function classifyInboxReply({ row, threadText, registeredNames, readyKeywords }) {
  const ruleResult = ruleBasedClassify({ row, threadText, registeredNames, readyKeywords });

  if (ruleResult.confidence >= 0.90) return ruleResult;

  try {
    const llmResult = await classifyWithLLM({
      threadText,
      sender: row.sender,
      subject: row.subject,
      previousRuleResult: ruleResult,
    });

    const normalized = normalizeLlmResult(llmResult);
    if (normalized.confidence > ruleResult.confidence) return normalized;
    return ruleResult;
  } catch (error) {
    return { ...ruleResult, _degraded: true, degradeReason: error.message };
  }
}
```

### Output Shape

Normalize LLM output into the same shape used by `inboxRules.js`, plus optional fields:

```js
{
  intent: 'ready_to_use',
  confidence: 0.86,
  hasPhone: true,
  phoneNumbers: ['...'],
  inviteCodes: ['...'],
  alreadyRegistered: false,
  recommendedAction: 'send_whatsapp_followup',
  reason: 'Creator says they are ready and shared a phone number.',
  source: 'llm',
}
```

If `confidence < 0.7`, force:

```js
recommendedAction = 'manual_review'
```

### Safety Rules

- Never send solely because the LLM said so unless `--send` is explicitly provided.
- If the LLM result cannot be parsed, fall back to `inboxRules.js` and record the parse error.
- Store raw LLM JSON in `analysis_results.raw_json`.
- Keep prompt text short and avoid sending more than the first 2,000-4,000 characters of a thread unless the user requests deeper analysis.
- Normalize all model output to fixed enums before use.
- Treat `manual_review` as the default for unknown, mixed, or low-confidence cases.

### Acceptance Criteria

- With `ENABLE_LLM_CLASSIFIER` unset, behavior is unchanged.
- With LLM enabled and credentials present, classification result includes `source: 'llm'`.
- Low-confidence LLM output creates or recommends manual review.
- Failed LLM calls do not fail the whole batch.

## Direction D: Sync `sendMailBridge` Results Back to CRM

### Goal

Make CRM the single operational ledger for both send paths:

- CRM-native followup sends
- `sendMailBridge` xlsx batch sends

Today, bridge results live mainly in `manifest.json` and run logs. Sync successful and failed batch results into CRM so dashboards, creator history, followup decisions, and audits can use one database.

### Proposed File

- `src/sendMailBridge/syncToCrm.js`

### Integration Points

Call sync after:

- `runBatch(...)` finishes a batch
- `runPending(...)` finishes or advances pending batches

Likely files:

- `src/sendMailBridge/engine.js`
- `src/web/server.js`, only if server owns the DB transaction around bridge jobs
- `src/db/index.js`, for reusable insert helpers

### Data Model Strategy

Start with existing `send_logs`, but add a dedupe strategy before writing row-level results.

Minimum row payload:

```js
insertSendLog(db, {
  creator_id: matchedCreatorId || null,
  template_id: null,
  campaign_id: campaignId || null,
  subject_rendered: row.subject || null,
  body_rendered: null,
  status: normalizedStatus,
  dry_run: 0,
  sent_at: batchResult.sentAt || new Date().toISOString(),
  error_message: batchResult.error || null,
  run_id: externalRunId,
});
```

### Dedupe Requirement

Do not blindly insert on every rerun. Use a stable external key.

Preferred key inputs:

1. `manifestPath`
2. `batchNumber`
3. `batchFile`
4. row index or row hash

If `send_logs` cannot represent this cleanly, add fields such as:

- `external_source`
- `external_id`
- `payload_json`

Or create a small bridge-specific table and later project it into `send_logs`.

### Creator Matching

Short term:

- allow `creator_id = null`
- store enough raw row context to reconcile later

Better:

- match by handle if available
- match by email identity if available
- match by normalized display name only as a low-confidence fallback

Never block bridge sync just because a CRM creator match is missing.

### Status Mapping

Normalize bridge statuses before writing to CRM:

- `sent` -> `sent`
- `failed` -> `failed`
- `success-toast-not-found` -> `send-confirmed-verify-missed`
- zero selected / no reachable rows -> `skipped-no-reachable-contact`
- profile conflict -> `profile-occupied`

Keep the original bridge reason in `error_message` or `payload_json`.

### Acceptance Criteria

- Running a bridge batch updates `manifest.json` as before and also writes CRM-visible send records.
- Re-running sync does not duplicate rows.
- `/dashboard` can count bridge sends from CRM data or a clear bridge-sync summary.
- Failed batches preserve enough error context to debug without opening the manifest manually.

## Direction E: Web Console Progressive Enhancement

### Goal

Improve the operator console without a risky rewrite.

Current issue: `src/web/server.js` renders a large amount of handwritten HTML. Some CSS and JS have already been split into `src/web/public/` and `src/web/views/`, but the console still needs stronger structure, responsiveness, and accessible interaction patterns.

### Step A: CSS Variables and Layout Cleanup

This is safe to do early.

Expected files:

- `src/web/public/app.css`
- `src/web/views/layout.js`

Tasks:

- centralize color, spacing, radius, font, and status tokens
- improve mobile table overflow
- standardize buttons, status badges, metric chips, forms, and logs
- add visible focus states
- keep text from overflowing buttons and table cells

Acceptance:

- `/send`, `/followup`, `/dashboard`, and `/logs` remain usable on desktop and narrow mobile widths.
- No text overlaps or clipped primary actions.
- No workflow behavior changes.

### Step B: Island-Style JS Enhancement

Do not immediately rewrite the whole console in React.

Preferred next step:

- keep Express-rendered HTML as the baseline
- enhance complex regions with plain JS or small components
- use existing SSE endpoint for followup job refresh

Candidate targets:

- `/followup` result table live updates
- `/send` batch status refresh
- error details expansion
- run summaries and filters

Acceptance:

- Page works with initial server render.
- JS enhancement improves freshness and interaction but is not required for basic visibility.

### Step C: Creator Detail Page

Build only after data foundations exist:

- `mail_threads`
- `mail_messages`
- `analysis_results`
- bridge-synced `send_logs`

Expected API shape:

```text
GET /api/creators/:id
```

Expected sections:

- creator identity and status
- invite codes
- mail threads
- analysis/classification history
- send logs from both CRM-native and bridge workflows
- safe action buttons for reminders

Acceptance:

- A creator detail view shows a complete outreach timeline.
- The page clearly distinguishes dry-run, sent, failed, skipped, and manual review states.
- Real sends still require explicit operator action.

## Testing Checklist

Before handing off:

```bash
node --check src/automation/mailClient.js
node --check src/automation/reminderRunner.js
node --check src/classifier/inboxRules.js
node --check src/web/server.js
git diff --check
```

For browser verification, use dry-run first:

```bash
npm run ready-followup -- --max-pages 1 --limit 1
```

Only use real sends after the user explicitly authorizes:

```bash
npm run ready-followup -- --max-pages 1 --limit 1 --send
```

## Handoff Notes for Future Agents

- Do not edit `/Users/depp/proboost-ready-reminder`; treat it as read-only reference.
- Compare CRM DOM behavior against the legacy scripts when mailbox automation breaks.
- Keep dry-run as the default.
- Keep helper function names small and concrete; avoid adding a large framework around Playwright.
- Prefer resilient diagnostics over silent retries. When a selector fails, capture enough evidence for the next agent to understand the page state.
