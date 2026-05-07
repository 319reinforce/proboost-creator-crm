# ProBoost Creator CRM Development Plan

> Archived reference. This was an early layer plan. For current status and next steps, start with `docs/README.md` and `docs/handoff.md`.

This project is built in layers. Each layer should be usable on its own before the next one starts.

## Layer 1: Stable CLI

Goal: replace spreadsheet-only state with a local database and reproducible commands.

Deliverables:

- SQLite database.
- Import pushed invite-code list.
- Import ready/registered list.
- Compute unused invite codes.
- Render reminder template variables.
- Export reports.

Status: scaffolded.

## Layer 2: ProBoost Automation Adapter

Goal: wrap existing Playwright knowledge from `proboost-ready-reminder` into reusable operations.

Deliverables:

- Login profile manager.
- Search inbox by handle.
- Open a mail thread.
- Read thread metadata and body.
- Select template.
- Fill rendered template.
- Send with confirmation.
- Verify in sent mailbox.
- Save screenshot and send log.

Status: implemented as CLI adapter.

Commands:

```bash
npm run login
npm run search -- --handle jay.alexaa
npm run remind -- --campaign 2026-04-28 --handles melmel_6_
npm run remind -- --campaign 2026-04-28 --handles melmel_6_ --send
```

Safety rules:

- Default dry-run.
- No automatic send for ambiguous search results.
- No send when variables are missing.
- No duplicate same-template send within cooldown.

## Layer 3: Reply Registration

Goal: track what creators reply, not only what we send.

Deliverables:

- Inbox sync job.
- Thread and message tables.
- Creator-thread matching.
- New reply detection.
- Manual review for unmatched messages.

## Layer 4: Semantic Classification

Goal: classify inbound replies into actionable states.

Deliverables:

- Structured JSON classification.
- Intent, confidence, sentiment, contact extraction.
- Recommended action.
- Low confidence manual review.

The model should not directly trigger real sends in this layer.

## Layer 5: Operator Console

Goal: provide a daily operating UI.

Deliverables:

- Dashboard.
- Creator list.
- Creator detail.
- Manual review queue.
- Template manager.
- Send preview and confirmation.

## Layer 6: Campaign Automation

Goal: run controlled, rule-based campaign operations.

Deliverables:

- Campaign rules.
- Send cooldowns.
- Daily send caps.
- Stop-contact rules.
- Conversion funnel reporting.
