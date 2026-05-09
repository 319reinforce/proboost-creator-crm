# Classifier

This folder contains inbound reply classification.

Default behavior is deterministic and local through `inboxRules.js`.
Optional LLM classification is provided by `llmClassifier.js` and is explicit opt-in only:

```bash
ENABLE_LLM_CLASSIFIER=1
OPENAI_API_KEY=...
LLM_CLASSIFIER_MODEL=gpt-4o-mini
```

If LLM classification is disabled, missing credentials, fails, or returns unparsable output, the CRM falls back to `inboxRules.js`.

Normalized output:

```json
{
  "intent": "ready",
  "confidence": 0.86,
  "hasPhone": true,
  "phoneNumbers": ["+1..."],
  "inviteCodes": [],
  "alreadyRegistered": false,
  "recommended_action": "send_whatsapp_followup",
  "reason": "Creator replied ready and included contact information.",
  "source": "llm"
}
```

The classifier should only recommend actions. It should not directly trigger real sends.
`manual_review`, low-confidence LLM results, `ignore`, and `skip_registered` must not enter the send path.

## Current Status

As of 2026-05-09:

- `inboxRules.js` provides the deterministic default classifier.
- `llmClassifier.js` remains explicit opt-in and must degrade back to rules.
- `classificationRunner.js` supports `npm run classify-mail`, which classifies
  already-synced `mail_messages` from SQLite without opening a browser.
- Classification results are persisted to `analysis_results`; manual-review
  cases can create `manual_review_items`.
- The remaining followup work is to make `ready-followup` consume these
  persisted classifications by default instead of scanning/classifying/sending
  in one live browser pass.
