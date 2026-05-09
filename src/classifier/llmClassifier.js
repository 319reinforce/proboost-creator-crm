const { classifyInboxReply } = require('./inboxRules');

const API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.LLM_CLASSIFIER_MODEL || 'gpt-4o-mini';
const MAX_THREAD_CHARS = Number(process.env.LLM_CLASSIFIER_MAX_CHARS || 3000);

const ACTIONS = new Set([
  'send_whatsapp_followup',
  'send_register_followup',
  'skip_registered',
  'manual_review',
  'ignore',
]);

const RESPONSE_SCHEMA = {
  name: 'proboost_reply_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        enum: ['ready', 'unknown', 'registered', 'not_ready', 'problem', 'other'],
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      hasPhone: {
        type: 'boolean',
      },
      phoneNumbers: {
        type: 'array',
        items: { type: 'string' },
      },
      inviteCodes: {
        type: 'array',
        items: { type: 'string' },
      },
      alreadyRegistered: {
        type: 'boolean',
      },
      recommendedAction: {
        type: 'string',
        enum: ['send_whatsapp_followup', 'send_register_followup', 'skip_registered', 'manual_review', 'ignore'],
      },
      reason: {
        type: 'string',
      },
    },
    required: [
      'intent',
      'confidence',
      'hasPhone',
      'phoneNumbers',
      'inviteCodes',
      'alreadyRegistered',
      'recommendedAction',
      'reason',
    ],
  },
};

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clampConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, confidence));
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)));
}

function normalizeLlmResult(parsed, { model, rawJson }) {
  const confidence = clampConfidence(parsed.confidence);
  let recommendedAction = ACTIONS.has(parsed.recommendedAction) ? parsed.recommendedAction : 'manual_review';
  if (confidence < 0.7) recommendedAction = 'manual_review';

  return {
    intent: parsed.intent || 'unknown',
    confidence,
    hasPhone: Boolean(parsed.hasPhone),
    phoneNumbers: uniqueStrings(parsed.phoneNumbers),
    inviteCodes: uniqueStrings(parsed.inviteCodes),
    alreadyRegistered: Boolean(parsed.alreadyRegistered),
    recommendedAction,
    reason: String(parsed.reason || 'llm-classified').slice(0, 500),
    source: 'llm',
    model,
    rawJson,
  };
}

async function classifyWithLlm({ row = {}, threadText = '', registeredNames = [], readyKeywords = [] } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when ENABLE_LLM_CLASSIFIER=1');

  const model = DEFAULT_MODEL;
  const text = String(threadText || '').slice(0, MAX_THREAD_CHARS);
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'Classify a ProBoost creator email reply for follow-up routing.',
            'Return only the requested JSON shape.',
            'Use manual_review for ambiguity, negation, product issues, or low confidence.',
            'Never recommend sending if the creator is already registered.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            sender: row.sender || '',
            subject: row.subject || '',
            deliveredAt: row.time || '',
            registeredNames,
            readyKeywords,
            threadText: text,
          }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: RESPONSE_SCHEMA,
      },
    }),
  });

  const rawJson = await response.json().catch(() => null);
  if (!response.ok) {
    const message = rawJson?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`OpenAI classification failed: ${message}`);
  }

  const content = rawJson?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI classification returned empty content');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    error.rawContent = content;
    throw error;
  }

  return normalizeLlmResult(parsed, { model, rawJson: parsed });
}

async function classifyInboxReplyWithOptionalLlm(args = {}) {
  const fallback = classifyInboxReply(args);
  if (!boolEnv('ENABLE_LLM_CLASSIFIER', false)) return fallback;
  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    return await classifyWithLlm(args);
  } catch (error) {
    return {
      ...fallback,
      source: 'rules',
      llmError: String(error.message || error),
    };
  }
}

module.exports = {
  classifyWithLlm,
  classifyInboxReplyWithOptionalLlm,
};
