# Classifier

This folder is reserved for inbound reply semantic analysis.

Planned output:

```json
{
  "intent": "ready_to_use",
  "confidence": 0.92,
  "sentiment": "positive",
  "needs_invite_code": false,
  "has_contact": true,
  "contact_type": "whatsapp",
  "contact_value": "+1...",
  "recommended_action": "send_whatsapp_followup",
  "reason": "Creator replied ready and included contact information."
}
```

The classifier should only recommend actions. It should not directly trigger real sends.
