const fs = require('fs');
const path = require('path');
const { extractInviteCodes, normalizeHandle, normalizeText } = require('./parseInviteList');

function readRows(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`file does not exist: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (['.xlsx', '.xls'].includes(ext)) {
    const xlsx = require('xlsx');
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
      .map((row, index) => ({ rowNumber: index + 2, raw: row }));
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  if (['.csv', '.tsv'].includes(ext)) {
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const headers = (lines.shift() || '').split(delimiter).map(normalizeText);
    return lines
      .map((line, index) => {
        const values = line.split(delimiter);
        const raw = {};
        headers.forEach((header, headerIndex) => {
          if (header) raw[header] = values[headerIndex] || '';
        });
        return { rowNumber: index + 2, raw };
      })
      .filter(row => objectValues(row.raw).some(normalizeText));
  }

  return lines
    .map((line, index) => ({ rowNumber: index + 1, raw: line }))
    .filter(row => normalizeText(row.raw));
}

function objectValues(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [row];
  return Object.values(row);
}

function valueByKey(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  const normalizedKeys = new Map(Object.keys(row).map(key => [normalizeText(key).toLowerCase(), key]));
  for (const key of keys) {
    const actual = normalizedKeys.get(key);
    if (actual && normalizeText(row[actual])) return normalizeText(row[actual]);
  }
  return '';
}

function parseRegisteredRow(row) {
  const raw = row.raw;
  const values = objectValues(raw).map(normalizeText).filter(Boolean);
  const joined = values.join(' ');
  const explicitCode = valueByKey(raw, ['invite code', 'invite_code', 'code', '邀请码', '激活码', 'registration code']);
  const code = (extractInviteCodes(explicitCode)[0] || extractInviteCodes(joined)[0] || '').toUpperCase();
  const explicitHandle = valueByKey(raw, ['handle', 'creator handle', '达人', '达人账号', '账号', 'tiktok handle', 'username']);
  const explicitEmail = valueByKey(raw, ['email', 'mail', '邮箱']);
  const explicitName = valueByKey(raw, ['name', 'display name', 'creator name', '达人昵称', '昵称']);
  const firstToken = normalizeText(joined.replace(new RegExp(`\\b${code}\\b`, 'i'), '')).split(/\s+/).find(Boolean) || '';
  const handle = normalizeHandle(explicitHandle || explicitEmail || explicitName || firstToken);

  return {
    rowNumber: row.rowNumber,
    code,
    handle,
    email: explicitEmail,
    displayName: explicitName || handle,
    raw,
  };
}

function findInviteByCode(db, code, campaignName) {
  if (!code) return null;
  const params = campaignName ? [code, campaignName] : [code];
  return db.prepare(`
    SELECT
      i.id AS invite_code_id,
      i.creator_id,
      i.code,
      ca.name AS campaign
    FROM invite_codes i
    JOIN campaigns ca ON ca.id = i.campaign_id
    WHERE UPPER(i.code) = UPPER(?)
      ${campaignName ? 'AND ca.name = ?' : ''}
    LIMIT 1
  `).get(...params) || null;
}

function findInvitesByHandle(db, handle, campaignName) {
  if (!handle) return [];
  const params = campaignName ? [handle, campaignName] : [handle];
  return db.prepare(`
    SELECT
      i.id AS invite_code_id,
      i.creator_id,
      i.code,
      ca.name AS campaign
    FROM invite_codes i
    JOIN creators c ON c.id = i.creator_id
    JOIN campaigns ca ON ca.id = i.campaign_id
    WHERE LOWER(c.handle) = LOWER(?)
      ${campaignName ? 'AND ca.name = ?' : ''}
    ORDER BY CASE WHEN i.status = 'used' THEN 1 ELSE 0 END ASC, COALESCE(i.pushed_at, i.created_at) DESC
  `).all(...params);
}

function markRegistered(db, match, { note, source, activatedAt }) {
  db.prepare(`
    UPDATE invite_codes
    SET status = 'used',
        registered_at = COALESCE(registered_at, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(activatedAt, match.invite_code_id);
  db.prepare(`
    UPDATE creators
    SET status = 'registered',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(match.creator_id);
  db.prepare(`
    INSERT INTO creator_activation_events (
      creator_id,
      invite_code_id,
      source,
      activated_at,
      operator_note
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(match.creator_id, match.invite_code_id, source, activatedAt, note || null);
}

function importRegistered(db, options) {
  const rows = readRows(options.file).map(parseRegisteredRow).filter(row => row.code || row.handle);
  const campaign = normalizeText(options.campaign);
  const note = normalizeText(options.note);
  const source = normalizeText(options.source) || 'activation-import';
  const activatedAt = options.activatedAt || new Date().toISOString();
  const matched = [];
  const unmatched = [];

  db.transaction(() => {
    for (const row of rows) {
      let match = findInviteByCode(db, row.code, campaign);
      let matchStrategy = match ? 'invite-code' : '';
      if (!match && row.handle) {
        const handleMatches = findInvitesByHandle(db, row.handle, campaign);
        if (handleMatches.length === 1) {
          match = handleMatches[0];
          matchStrategy = 'handle';
        } else if (handleMatches.length > 1) {
          unmatched.push({
            rowNumber: row.rowNumber,
            code: row.code,
            handle: row.handle,
            reason: 'ambiguous-handle',
            candidates: handleMatches.map(item => ({ code: item.code, campaign: item.campaign })),
          });
          continue;
        }
      }

      if (!match) {
        unmatched.push({
          rowNumber: row.rowNumber,
          code: row.code,
          handle: row.handle,
          reason: row.code ? 'invite-code-not-found' : 'no-match-key',
        });
        continue;
      }

      markRegistered(db, match, {
        note: note || `registered import row ${row.rowNumber}`,
        source,
        activatedAt,
      });
      matched.push({
        rowNumber: row.rowNumber,
        creatorId: match.creator_id,
        inviteCodeId: match.invite_code_id,
        code: match.code,
        campaign: match.campaign,
        matchStrategy,
      });
    }
  })();

  return {
    file: path.resolve(options.file),
    campaign: campaign || '',
    source,
    totalRows: rows.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    matched,
    unmatched,
  };
}

module.exports = {
  importRegistered,
  parseRegisteredRow,
};
