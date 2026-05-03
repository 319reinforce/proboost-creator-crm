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
