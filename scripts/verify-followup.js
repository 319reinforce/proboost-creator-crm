#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  openDb,
  initDb,
  upsertMailThread,
  insertMailMessage,
  insertAnalysisResult,
} = require('../src/db');
const { classifyInboxReplyWithOptionalLlm } = require('../src/classifier/llmClassifier');
const { normalizeBridgeStatus, syncBatchToCrm } = require('../src/sendMailBridge/syncToCrm');
const { patchZeroSendConfirm } = require('../src/sendMailBridge/runtimeScript');
const { autoScript } = require('../src/sendMailBridge/paths');

async function verifyPersistence() {
  const db = openDb(':memory:');
  try {
    initDb(db);

    const firstThread = upsertMailThread(db, {
      provider_thread_id: 'row:test-thread',
      mailbox: 'inbox',
      sender: 'creator',
      subject: 'Ready',
      first_message_at: '2026-05-01 10:00',
    });
    const secondThread = upsertMailThread(db, {
      provider_thread_id: 'row:test-thread',
      mailbox: 'inbox',
      sender: 'creator updated',
      subject: 'Ready updated',
      last_message_at: '2026-05-01 10:05',
    });

    assert.strictEqual(firstThread.id, secondThread.id, 'same provider thread should upsert one thread row');
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS count FROM mail_threads').get().count,
      1,
      'thread upsert should not duplicate rows',
    );

    const message = insertMailMessage(db, {
      thread_id: secondThread.id,
      direction: 'inbound',
      subject: 'Ready',
      sender: 'creator',
      body_text: 'I am ready. My WhatsApp is +1 415 555 1212.',
      received_at: '2026-05-01 10:05',
    });
    assert.ok(message.id, 'message should be inserted');
    assert.ok(message.body_text.length > 0, 'message body_text should be non-empty');

    const analysis = insertAnalysisResult(db, {
      message_id: message.id,
      intent: 'ready',
      confidence: 0.85,
      has_contact: true,
      contact_type: 'phone',
      contact_value: '+1 415 555 1212',
      recommended_action: 'send_whatsapp_followup',
      reason: 'local verification',
      raw_json: { source: 'verify-followup' },
    });
    assert.ok(analysis.id, 'analysis result should be inserted');
  } finally {
    db.close();
  }
}

async function verifyClassifierFallback() {
  const originalEnable = process.env.ENABLE_LLM_CLASSIFIER;
  const originalKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ENABLE_LLM_CLASSIFIER;
    const disabled = await classifyInboxReplyWithOptionalLlm({
      row: { sender: 'creator' },
      threadText: 'ready +1 415 555 1212',
    });
    assert.strictEqual(disabled.recommendedAction, 'send_whatsapp_followup');
    assert.strictEqual(disabled.hasPhone, true);

    process.env.ENABLE_LLM_CLASSIFIER = '1';
    const missingKey = await classifyInboxReplyWithOptionalLlm({
      row: { sender: 'creator' },
      threadText: 'ready +1 415 555 1212',
    });
    assert.strictEqual(missingKey.recommendedAction, 'send_whatsapp_followup');
    assert.strictEqual(missingKey.source, undefined, 'missing key path should preserve legacy rules output');
  } finally {
    if (originalEnable == null) delete process.env.ENABLE_LLM_CLASSIFIER;
    else process.env.ENABLE_LLM_CLASSIFIER = originalEnable;
    if (originalKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
}

function verifyBridgeSync() {
  const db = openDb(':memory:');
  try {
    initDb(db);
    const manifestPath = '/tmp/proboost-crm-verify/manifest.json';
    const manifest = {
      campaignName: 'verify-campaign',
      batches: [],
    };
    const batch = {
      batchNumber: 1,
      file: '/tmp/proboost-crm-verify/batch-1.xlsx',
      rowCount: 200,
      selectedCount: 199,
      status: 'failed',
      reason: 'success-toast-not-found',
      updatedAt: '2026-05-01T10:00:00.000Z',
    };

    assert.strictEqual(normalizeBridgeStatus(batch), 'send-confirmed-verify-missed');
    const first = syncBatchToCrm(db, { manifestPath, manifest, batch });
    const second = syncBatchToCrm(db, { manifestPath, manifest, batch });
    assert.strictEqual(first.sendLogId, second.sendLogId, 'bridge sync should upsert by external key');
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS count FROM send_logs WHERE external_source = ?').get('sendMailBridge').count,
      1,
      'bridge sync should not duplicate send logs',
    );

    const zeroReachable = {
      ...batch,
      batchNumber: 2,
      file: '/tmp/proboost-crm-verify/batch-2.xlsx',
      selectedCount: 0,
      status: 'sent',
      reason: 'import-zero-reachable',
    };
    assert.strictEqual(normalizeBridgeStatus(zeroReachable), 'skipped-no-reachable-contact');
    assert.strictEqual(normalizeBridgeStatus({
      ...zeroReachable,
      reason: 'send-confirm-zero',
    }), 'skipped-no-reachable-contact');
  } finally {
    db.close();
  }
}

function verifyRuntimePatch() {
  const source = fs.readFileSync(path.resolve(autoScript), 'utf8');
  const patched = patchZeroSendConfirm(source);
  assert.ok(patched.includes("return 'zero-send';"), 'runtime patch should return zero-send sentinel');
  assert.ok(patched.includes("text.includes('取消')"), 'runtime patch should click cancel for zero-send modal');
  assert.ok(patched.includes("reason: 'send-confirm-zero'"), 'runtime patch should mark skipped zero-send reason');
}

async function main() {
  await verifyPersistence();
  await verifyClassifierFallback();
  verifyBridgeSync();
  verifyRuntimePatch();
  console.log('followup verification passed');
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
