const fs = require('fs');
const path = require('path');
const config = require('../config');
const { launchProBoostSession, persistAuthSnapshot } = require('./session');
const {
  enterMailbox,
  extractInboxRows,
  openInboxResult,
} = require('./mailClient');

const MAX_ITEMS = 300;
const MAX_BODY_CHARS = 12000;
const MAIL_URL_RE = /mail|message|inbox|reply|thread|conversation|notification|letter|email/i;
const DETAIL_RE = /detail|message|thread|conversation|mail[_-]?id|message[_-]?id|thread[_-]?id/i;
const LIST_RE = /list|page|search|query|inbox|mailbox/i;
const REPLY_RE = /reply|send|compose/i;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function redact(value) {
  return String(value ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(authorization|token|access_token|refresh_token|id_token|session|cookie|jwt|bearer)(["'\s:=]+)[^"',\s}]+/gi, '$1$2[redacted]')
    .replace(/([?&](?:token|access_token|auth|session|jwt)=)[^&\s]+/gi, '$1[redacted]');
}

function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/cookie|authorization|token|secret|session|csrf/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(value);
    }
  }
  return out;
}

function previewBody(value, rawEnabled) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = rawEnabled ? text : redact(text);
  return redacted.slice(0, MAX_BODY_CHARS);
}

function isLikelyMailUrl(url) {
  return MAIL_URL_RE.test(url || '');
}

function classifyEndpoint(url, method = 'GET') {
  const tags = [];
  if (LIST_RE.test(url)) tags.push('list-candidate');
  if (DETAIL_RE.test(url)) tags.push('detail-candidate');
  if (REPLY_RE.test(url) || method !== 'GET') tags.push('reply-or-mutation-candidate');
  if (isLikelyMailUrl(url) && tags.length === 0) tags.push('mail-candidate');
  return tags;
}

async function safeResponsePreview(response, rawEnabled) {
  const headers = response.headers();
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  if (!/json|text|javascript|html/i.test(contentType)) return '';
  try {
    const body = await response.text();
    return previewBody(body, rawEnabled);
  } catch {
    return '';
  }
}

function trimList(items) {
  if (items.length <= MAX_ITEMS) return items;
  return items.slice(items.length - MAX_ITEMS);
}

function candidateSummary(requests, responses) {
  const byUrl = new Map();
  for (const item of [...requests, ...responses]) {
    if (!isLikelyMailUrl(item.url)) continue;
    const current = byUrl.get(item.url) || {
      url: item.url,
      method: item.method || 'GET',
      tags: classifyEndpoint(item.url, item.method),
      requestCount: 0,
      responseCount: 0,
      statuses: [],
      contentTypes: [],
      sampleBodyPreview: '',
    };
    if (item.kind === 'request') current.requestCount += 1;
    if (item.kind === 'response') {
      current.responseCount += 1;
      if (item.status != null && !current.statuses.includes(item.status)) current.statuses.push(item.status);
      if (item.contentType && !current.contentTypes.includes(item.contentType)) current.contentTypes.push(item.contentType);
      if (!current.sampleBodyPreview && item.bodyPreview) current.sampleBodyPreview = item.bodyPreview;
    }
    byUrl.set(item.url, current);
  }
  return [...byUrl.values()].sort((a, b) => {
    const score = item => item.tags.length * 10 + item.responseCount + item.requestCount;
    return score(b) - score(a);
  });
}

async function runMailApiDiscovery(options = {}) {
  const id = `mail-debug_${runId()}`;
  const reportRoot = path.join(config.reportDir, 'mail-debug');
  const outDir = path.join(reportRoot, id);
  ensureDir(outDir);

  const rawEnabled = process.env.MAIL_DEBUG_RAW === '1';
  const durationMs = Number.parseInt(options.durationMs || options.duration || '45000', 10) || 45000;
  const mailbox = options.mailbox || 'replied';
  const requests = [];
  const responses = [];
  const notes = [];

  const { context, page } = await launchProBoostSession({
    headless: options.headless,
    keepOpen: options.keepOpen,
  });

  page.on('request', request => {
    const url = request.url();
    if (!isLikelyMailUrl(url)) return;
    requests.push({
      kind: 'request',
      capturedAt: new Date().toISOString(),
      method: request.method(),
      url: redact(url),
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
      postDataPreview: rawEnabled ? previewBody(request.postData() || '', rawEnabled) : '',
      tags: classifyEndpoint(url, request.method()),
    });
    while (requests.length > MAX_ITEMS) requests.shift();
  });

  page.on('response', response => {
    const url = response.url();
    if (!isLikelyMailUrl(url)) return;
    Promise.resolve()
      .then(async () => {
        const headers = response.headers();
        const contentType = headers['content-type'] || headers['Content-Type'] || '';
        responses.push({
          kind: 'response',
          capturedAt: new Date().toISOString(),
          method: response.request().method(),
          url: redact(url),
          status: response.status(),
          contentType,
          headers: sanitizeHeaders(headers),
          bodyPreview: await safeResponsePreview(response, rawEnabled),
          tags: classifyEndpoint(url, response.request().method()),
        });
        while (responses.length > MAX_ITEMS) responses.shift();
      })
      .catch(() => {});
  });

  try {
    const entry = await enterMailbox(page, { mailbox });
    notes.push({ type: 'mailbox-entry', entry, at: new Date().toISOString() });
    if (options.openFirstRow) {
      const rows = await extractInboxRows(page);
      notes.push({ type: 'listed-rows', count: rows.length, at: new Date().toISOString() });
      if (rows[0]) {
        const opened = await openInboxResult(page, rows[0]);
        notes.push({ type: 'opened-first-row', opened, row: rows[0], at: new Date().toISOString() });
      }
    }

    await page.waitForTimeout(durationMs);
    await page.waitForTimeout(700);
    await persistAuthSnapshot(context);
  } finally {
    if (!options.keepOpen) await context.close();
  }

  const finalRequests = trimList(requests);
  const finalResponses = trimList(responses);
  const candidates = candidateSummary(finalRequests, finalResponses);
  const requestPath = path.join(outDir, 'requests.json');
  const responsePath = path.join(outDir, 'responses.json');
  const candidatePath = path.join(outDir, 'candidates.json');
  const summaryPath = path.join(outDir, 'summary.json');

  fs.writeFileSync(requestPath, `${JSON.stringify(finalRequests, null, 2)}\n`);
  fs.writeFileSync(responsePath, `${JSON.stringify(finalResponses, null, 2)}\n`);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidates, null, 2)}\n`);

  const summary = {
    id,
    outDir,
    requestPath,
    responsePath,
    candidatePath,
    rawEnabled,
    durationMs,
    mailbox,
    requestCount: finalRequests.length,
    responseCount: finalResponses.length,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 20),
    notes,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, summaryPath };
}

function listMailDebugRuns(limit = 12) {
  const reportRoot = path.join(config.reportDir, 'mail-debug');
  if (!fs.existsSync(reportRoot)) return [];
  return fs.readdirSync(reportRoot)
    .map(name => {
      const dir = path.join(reportRoot, name);
      const summaryPath = path.join(dir, 'summary.json');
      const stat = fs.statSync(dir);
      const summary = fs.existsSync(summaryPath)
        ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        : null;
      return { name, dir, summaryPath, mtimeMs: stat.mtimeMs, summary };
    })
    .filter(item => item.summary)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

module.exports = {
  runMailApiDiscovery,
  listMailDebugRuns,
};
