const { launchProBoostSession, persistAuthSnapshot } = require('./session');
const {
  searchInboxByHandle,
  openInboxResult,
  reopenInboxResult,
  replyToOpenedThread,
  verifySentRecord,
  enterRepliedInbox,
  setPageSize,
  goToFirstPage,
  goToNextPage,
  extractInboxRows,
  extractOpenedThreadText,
} = require('./mailClient');
const { listUnusedInvites } = require('../importer/queries');
const { getActiveTemplate, renderTemplate } = require('../templates/render');
const {
  insertSendLog,
  insertAnalysisResult,
} = require('../db');
const { persistThreadRead } = require('./mailSyncPersistence');
const { classifyInboxReplyWithOptionalLlm } = require('../classifier/llmClassifier');
const config = require('../config');

function parseHandles(value) {
  return new Set(String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean));
}

function buildVariables(row, options) {
  return {
    creator_name: row.display_name || row.handle,
    handle: row.handle,
    invite_code: row.code,
    signup_link: options.signupLink || config.defaultSignupLink,
    expires_in: options.expiresIn || config.defaultExpiresIn,
    bonus_amount: options.bonusAmount || config.defaultBonusAmount,
    last_subject: '',
  };
}

function selectTargets(db, options) {
  const limit = Number.parseInt(options.limit || '0', 10) || 0;
  let rows = listUnusedInvites(db, options.campaign, 0);
  const handles = parseHandles(options.handles);
  if (handles.size > 0) {
    rows = rows.filter(row => handles.has(String(row.handle || '').toLowerCase()));
  }
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function loadRegisteredNames(db, options = {}) {
  const names = new Set(parseList(options.registeredNames));
  const rows = db.prepare(`
    SELECT handle, display_name
    FROM creators
    WHERE status IN ('registered', 'used', 'ready')
  `).all();
  for (const row of rows) {
    if (row.handle) names.add(row.handle);
    if (row.display_name) names.add(row.display_name);
  }
  return Array.from(names);
}

function getTemplate(db, name) {
  return name ? getActiveTemplate(db, name) : null;
}

function renderFollowup(template, variables) {
  if (!template) return null;
  const rendered = renderTemplate(template, variables);
  return rendered.ok ? rendered : null;
}

function persistClassification(db, { messageRecord, classification }) {
  if (!messageRecord || !classification) return null;
  return insertAnalysisResult(db, {
    message_id: messageRecord.id,
    intent: classification.intent,
    confidence: classification.confidence,
    needs_invite_code: classification.inviteCodes?.length === 0,
    has_contact: Boolean(classification.hasPhone),
    contact_type: classification.hasPhone ? 'phone' : null,
    contact_value: classification.phoneNumbers?.[0] || null,
    recommended_action: classification.recommendedAction,
    reason: classification.reason,
    model: classification.source || 'rules',
    prompt_version: 'inbox-rules-v1',
    raw_json: classification,
  });
}

function summarizeReadyFollowupRun({ runId, dryRun, maxPages, results, pageIndex = 1, scannedRows = 0, note = '' }) {
  return {
    runId,
    dryRun,
    maxPages,
    pageIndex,
    scannedRows,
    note,
    processed: results.length,
    opened: results.filter(item => item.opened).length,
    threadRead: results.filter(item => item.threadChars > 0).length,
    openFailed: results.filter(item => item.stage === 'open-failed').length,
    readyCount: results.filter(item => item.classification?.intent === 'ready').length,
    whatsappFollowups: results.filter(item => item.classification?.recommendedAction === 'send_whatsapp_followup').length,
    registerFollowups: results.filter(item => item.classification?.recommendedAction === 'send_register_followup').length,
    skippedRegistered: results.filter(item => item.classification?.recommendedAction === 'skip_registered').length,
    results,
  };
}

async function emitReadyFollowupProgress(options, snapshot) {
  if (typeof options.onProgress !== 'function') return;
  await options.onProgress(snapshot);
}

async function returnToRepliedPage(page, pageIndex) {
  await enterRepliedInbox(page);
  await setPageSize(page, config.pageSize);
  await goToFirstPage(page);
  for (let i = 1; i < pageIndex; i += 1) {
    const advanced = await goToNextPage(page);
    if (!advanced) break;
  }
}

async function searchHandle(options) {
  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });
  try {
    const result = await searchInboxByHandle(page, options.handle);
    await persistAuthSnapshot(context);
    return result;
  } finally {
    if (!options.keepOpen) await context.close();
  }
}

async function runReminderBatch(db, options) {
  const templateName = options.template || '督促产品使用';
  const template = getActiveTemplate(db, templateName);
  if (!template) throw new Error(`template not found: ${templateName}`);

  const dryRun = !options.send;
  const forceAmbiguous = Boolean(options.forceAmbiguous);
  const targets = selectTargets(db, options);
  const runId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results = [];

  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });

  try {
    for (const row of targets) {
      const rendered = renderTemplate(template, buildVariables(row, options));
      if (!rendered.ok) {
        const log = insertSendLog(db, {
          creator_id: row.creator_id,
          invite_code_id: row.invite_code_id,
          template_id: template.id,
          campaign_id: row.campaign_id,
          subject_rendered: rendered.subject,
          body_rendered: rendered.body,
          status: 'template-variable-missing',
          dry_run: dryRun,
          error_message: `missing variables: ${rendered.missing.join(', ')}`,
          run_id: runId,
        });
        results.push({ handle: row.handle, code: row.code, status: log.status, missing: rendered.missing });
        continue;
      }

      const search = await searchInboxByHandle(page, row.handle);
      let candidates = search.exactRows.length > 0 ? search.exactRows : search.rows;
      if (candidates.length > 1 && forceAmbiguous) candidates = [candidates[0]];

      if (candidates.length !== 1) {
        const status = candidates.length === 0 ? 'not-found' : 'ambiguous';
        insertSendLog(db, {
          creator_id: row.creator_id,
          invite_code_id: row.invite_code_id,
          template_id: template.id,
          campaign_id: row.campaign_id,
          status,
          dry_run: dryRun,
          subject_rendered: rendered.subject,
          body_rendered: rendered.body,
          error_message: `search results=${search.resultCount}, exact=${search.exactCount}`,
          run_id: runId,
        });
        results.push({
          handle: row.handle,
          code: row.code,
          status,
          resultCount: search.resultCount,
          exactCount: search.exactCount,
        });
        continue;
      }

      const candidate = candidates[0];
      let status = 'failed';
      let verified = false;
      let errorMessage = '';

      try {
        await openInboxResult(page, candidate);
        const replyResult = await replyToOpenedThread(page, {
          templateName,
          rendered,
          dryRun,
        });
        status = replyResult.status;
        if (status === 'sent-unverified') {
          verified = await verifySentRecord(page, row.handle);
          status = verified ? 'sent' : 'unconfirmed';
        }
      } catch (error) {
        status = 'failed';
        errorMessage = error.message;
      }

      insertSendLog(db, {
        creator_id: row.creator_id,
        invite_code_id: row.invite_code_id,
        template_id: template.id,
        campaign_id: row.campaign_id,
        status,
        dry_run: dryRun,
        subject_rendered: rendered.subject,
        body_rendered: rendered.body,
        sent_at: status === 'sent' ? new Date().toISOString() : null,
        verified_at: verified ? new Date().toISOString() : null,
        error_message: errorMessage || null,
        run_id: runId,
      });

      results.push({
        handle: row.handle,
        code: row.code,
        sender: candidate.sender,
        subject: candidate.subject,
        status,
      });
    }

    await persistAuthSnapshot(context);
  } finally {
    if (!options.keepOpen) await context.close();
  }

  return {
    runId,
    dryRun,
    targetCount: targets.length,
    results,
  };
}

async function runReadyFollowupBatch(db, options) {
  const dryRun = !options.send;
  const maxPages = Number.parseInt(options.maxPages || '1', 10) || 1;
  const limit = Number.parseInt(options.limit || '0', 10) || 0;
  const templateWhatsappName = options.templateWhatsapp || '感谢发送联系方式';
  const templateRegisterName = options.templateRegister || '督促产品使用';
  const whatsappTemplate = getTemplate(db, templateWhatsappName);
  const registerTemplate = getTemplate(db, templateRegisterName);
  const registeredNames = loadRegisteredNames(db, options);
  const readyKeywords = parseList(options.readyKeywords).length > 0 ? parseList(options.readyKeywords) : undefined;
  const runId = `ready_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results = [];
  let latestScannedRows = 0;
  let latestPageIndex = 1;

  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });

  try {
    await returnToRepliedPage(page, 1);
    await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
      runId,
      dryRun,
      maxPages,
      results,
      pageIndex: 1,
      scannedRows: 0,
      note: 'entered-replied-inbox',
    }));

    let pageIndex = 1;
    let processed = 0;
    while (pageIndex <= maxPages) {
      latestPageIndex = pageIndex;
      const rows = await extractInboxRows(page);
      latestScannedRows = rows.length;
      await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
        runId,
        dryRun,
        maxPages,
        results,
        pageIndex,
        scannedRows: rows.length,
        note: 'listed-inbox-rows',
      }));
      if (rows.length === 0) break;

      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (limit > 0 && processed >= limit) break;
        const row = rows[rowIndex];
        let status = 'failed';
        let errorMessage = '';
        let classification = null;
        let threadRecord = null;
        let messageRecord = null;
        let analysisRecord = null;
        let templateName = null;
        let rendered = null;
        const resultItem = {
          page: pageIndex,
          rowIndex,
          sender: row.sender,
          subject: row.subject,
          time: row.time,
          status: 'listed',
          stage: 'listed',
          template: null,
          classification: null,
          opened: false,
          threadChars: 0,
          threadId: null,
          messageId: null,
          analysisId: null,
        };
        results.push(resultItem);
        await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
          runId,
          dryRun,
          maxPages,
          results,
          pageIndex,
          scannedRows: latestScannedRows,
          note: 'row-listed',
        }));

        try {
          resultItem.status = 'opening';
          resultItem.stage = 'opening';
          await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
            runId,
            dryRun,
            maxPages,
            results,
            pageIndex,
            scannedRows: latestScannedRows,
            note: 'opening-thread',
          }));

          await reopenInboxResult(page, row, pageIndex);
          resultItem.opened = true;
          resultItem.status = 'opened';
          resultItem.stage = 'opened';
          await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
            runId,
            dryRun,
            maxPages,
            results,
            pageIndex,
            scannedRows: latestScannedRows,
            note: 'thread-opened',
          }));

          const threadText = await extractOpenedThreadText(page);
          resultItem.threadChars = threadText.length;
          ({ threadRecord, messageRecord } = persistThreadRead(db, {
            page,
            row,
            threadText,
          }));
          resultItem.threadId = threadRecord.id;
          resultItem.messageId = messageRecord.id;
          resultItem.stage = 'thread-read';
          await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
            runId,
            dryRun,
            maxPages,
            results,
            pageIndex,
            scannedRows: latestScannedRows,
            note: 'thread-read',
          }));

          classification = await classifyInboxReplyWithOptionalLlm({
            row,
            threadText,
            registeredNames,
            readyKeywords,
          });
          resultItem.classification = classification;
          analysisRecord = persistClassification(db, { messageRecord, classification });
          resultItem.analysisId = analysisRecord?.id || null;
          resultItem.stage = 'classified';
          await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
            runId,
            dryRun,
            maxPages,
            results,
            pageIndex,
            scannedRows: latestScannedRows,
            note: 'classified',
          }));

          if (['ignore', 'skip_registered', 'manual_review'].includes(classification.recommendedAction)) {
            status = classification.recommendedAction;
          } else {
            const inviteCode = classification.inviteCodes[0] || '';
            const variables = {
              creator_name: row.sender || row.handle || 'there',
              handle: row.sender || '',
              invite_code: inviteCode,
              signup_link: options.signupLink || config.defaultSignupLink,
              expires_in: options.expiresIn || config.defaultExpiresIn,
              bonus_amount: options.bonusAmount || config.defaultBonusAmount,
              last_subject: row.subject || '',
            };

            if (classification.recommendedAction === 'send_whatsapp_followup') {
              templateName = templateWhatsappName;
              rendered = renderFollowup(whatsappTemplate, variables);
            } else {
              templateName = templateRegisterName;
              rendered = renderFollowup(registerTemplate, variables);
            }

            const replyResult = await replyToOpenedThread(page, {
              templateName,
              rendered,
              dryRun,
              inviteCode,
            });
            status = replyResult.status;
            resultItem.stage = 'reply-prepared';
          }
        } catch (error) {
          status = 'failed';
          errorMessage = error.message;
          if (resultItem.stage === 'opening') resultItem.stage = 'open-failed';
          else resultItem.stage = 'failed';
        }

        insertSendLog(db, {
          status,
          dry_run: dryRun,
          subject_rendered: rendered?.subject || null,
          body_rendered: rendered?.body || null,
          sent_at: status === 'sent' ? new Date().toISOString() : null,
          error_message: errorMessage || classification?.reason || null,
          run_id: runId,
        });

        resultItem.status = status;
        resultItem.stage = resultItem.stage === 'reply-prepared' || resultItem.stage === 'open-failed' || resultItem.stage === 'failed'
          ? resultItem.stage
          : 'done';
        resultItem.template = templateName;
        resultItem.classification = classification;
        resultItem.error = errorMessage || undefined;
        await emitReadyFollowupProgress(options, summarizeReadyFollowupRun({
          runId,
          dryRun,
          maxPages,
          results,
          pageIndex,
          scannedRows: latestScannedRows,
          note: 'row-finished',
        }));

        processed += 1;
        if (limit > 0 && processed >= limit) break;
        await returnToRepliedPage(page, pageIndex);
      }

      if (limit > 0 && processed >= limit) break;
      const advanced = await goToNextPage(page);
      if (!advanced) break;
      pageIndex += 1;
    }

    await persistAuthSnapshot(context);
  } finally {
    if (!options.keepOpen) await context.close();
  }

  return {
    ...summarizeReadyFollowupRun({
      runId,
      dryRun,
      maxPages,
      results,
      pageIndex: latestPageIndex,
      scannedRows: latestScannedRows,
      note: 'finished',
    }),
  };
}

module.exports = {
  runReminderBatch,
  searchHandle,
  runReadyFollowupBatch,
};
