const { insertAnalysisResult } = require('../db');
const { classifyInboxReplyWithOptionalLlm } = require('../classifier/llmClassifier');
const { DEFAULT_READY_KEYWORDS } = require('../classifier/inboxRules');

const DEFAULT_PROMPT_VERSION = 'inbox-rules-v1';

function parseList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (value == null || value === '') return fallback;
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageRowToClassifierInput(row) {
  return {
    row: {
      sender: row.sender || row.thread_sender || '',
      subject: row.subject || row.thread_subject || '',
      time: row.received_at || row.first_message_at || '',
    },
    threadText: row.body_text || '',
  };
}

function selectUnclassifiedMessages(db, {
  limit,
  threadId = null,
  messageId = null,
  promptVersion = DEFAULT_PROMPT_VERSION,
}) {
  const filters = [
    "m.direction = 'inbound'",
    "COALESCE(m.body_text, '') <> ''",
    `NOT EXISTS (
      SELECT 1
      FROM analysis_results ar
      WHERE ar.message_id = m.id
        AND ar.prompt_version = @promptVersion
    )`,
  ];
  if (threadId) filters.push('m.thread_id = @threadId');
  if (messageId) filters.push('m.id = @messageId');

  return db.prepare(`
    SELECT
      m.*,
      t.sender AS thread_sender,
      t.subject AS thread_subject,
      t.provider_thread_id,
      t.mailbox,
      t.first_message_at
    FROM mail_messages m
    LEFT JOIN mail_threads t ON t.id = m.thread_id
    WHERE ${filters.join('\n      AND ')}
    ORDER BY COALESCE(m.received_at, m.created_at) DESC
    LIMIT @limit
  `).all({
    limit,
    threadId,
    messageId,
    promptVersion,
  });
}

function persistClassification(db, { messageRow, classification, promptVersion = DEFAULT_PROMPT_VERSION }) {
  return insertAnalysisResult(db, {
    message_id: messageRow.id,
    creator_id: messageRow.creator_id,
    intent: classification.intent,
    confidence: classification.confidence,
    sentiment: classification.sentiment || null,
    needs_invite_code: classification.inviteCodes?.length === 0,
    has_contact: Boolean(classification.hasPhone),
    contact_type: classification.hasPhone ? 'phone' : null,
    contact_value: classification.phoneNumbers?.[0] || null,
    recommended_action: classification.recommendedAction,
    reason: classification.reason,
    model: classification.model || classification.source || 'rules',
    prompt_version: promptVersion,
    raw_json: classification,
  });
}

function manualReviewReason(classification) {
  if (classification.recommendedAction === 'manual_review') return classification.reason || 'manual-review';
  return '';
}

function ensureManualReviewItem(db, { messageRow, analysisRecord, classification }) {
  const reason = manualReviewReason(classification);
  if (!reason || !messageRow.thread_id) return null;
  const existing = db.prepare(`
    SELECT *
    FROM manual_review_items
    WHERE thread_id = ?
      AND status = 'open'
      AND reason = ?
    LIMIT 1
  `).get(messageRow.thread_id, reason);
  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO manual_review_items (
      creator_id,
      thread_id,
      reason,
      severity,
      payload_json,
      status
    )
    VALUES (
      @creator_id,
      @thread_id,
      @reason,
      @severity,
      @payload_json,
      'open'
    )
  `).run({
    creator_id: messageRow.creator_id || null,
    thread_id: messageRow.thread_id,
    reason,
    severity: classification.recommendedAction === 'manual_review' ? 'medium' : 'low',
    payload_json: JSON.stringify({
      messageId: messageRow.id,
      analysisId: analysisRecord.id,
      classification,
    }),
  });
  return db.prepare('SELECT * FROM manual_review_items WHERE id = ?').get(result.lastInsertRowid);
}

async function runClassificationBatch(db, options = {}) {
  const limit = parsePositiveInt(options.limit, 50);
  const promptVersion = options.promptVersion || DEFAULT_PROMPT_VERSION;
  const registeredNames = parseList(options.registeredNames, []);
  const readyKeywords = parseList(options.readyKeywords, DEFAULT_READY_KEYWORDS);
  const threadId = options.threadId ? Number.parseInt(options.threadId, 10) : null;
  const messageId = options.messageId ? Number.parseInt(options.messageId, 10) : null;
  const runId = `classify-mail_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const messages = selectUnclassifiedMessages(db, {
    limit,
    threadId: Number.isFinite(threadId) ? threadId : null,
    messageId: Number.isFinite(messageId) ? messageId : null,
    promptVersion,
  });
  const results = [];

  for (const messageRow of messages) {
    const input = messageRowToClassifierInput(messageRow);
    const classification = await classifyInboxReplyWithOptionalLlm({
      ...input,
      registeredNames,
      readyKeywords,
    });
    const analysisRecord = persistClassification(db, {
      messageRow,
      classification,
      promptVersion,
    });
    const manualReviewItem = ensureManualReviewItem(db, {
      messageRow,
      analysisRecord,
      classification,
    });
    results.push({
      messageId: messageRow.id,
      threadId: messageRow.thread_id,
      analysisId: analysisRecord.id,
      manualReviewItemId: manualReviewItem?.id || null,
      sender: input.row.sender,
      subject: input.row.subject,
      intent: classification.intent,
      confidence: classification.confidence,
      recommendedAction: classification.recommendedAction,
      reason: classification.reason,
      model: analysisRecord.model,
      promptVersion,
    });
  }

  return {
    runId,
    promptVersion,
    requested: {
      limit,
      threadId: Number.isFinite(threadId) ? threadId : null,
      messageId: Number.isFinite(messageId) ? messageId : null,
    },
    selected: messages.length,
    classified: results.length,
    manualReview: results.filter(item => item.manualReviewItemId).length,
    actions: {
      sendWhatsappFollowup: results.filter(item => item.recommendedAction === 'send_whatsapp_followup').length,
      sendRegisterFollowup: results.filter(item => item.recommendedAction === 'send_register_followup').length,
      skipRegistered: results.filter(item => item.recommendedAction === 'skip_registered').length,
      ignore: results.filter(item => item.recommendedAction === 'ignore').length,
      manualReview: results.filter(item => item.recommendedAction === 'manual_review').length,
    },
    results,
  };
}

module.exports = {
  DEFAULT_PROMPT_VERSION,
  runClassificationBatch,
  selectUnclassifiedMessages,
};
