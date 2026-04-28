const fs = require('fs');
const path = require('path');

const INVITE_CODE_REGEX = /(?<![A-Za-z0-9])[A-Z0-9]{5,8}(?![A-Za-z0-9])/g;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHandle(value) {
  return normalizeText(value)
    .replace(/^@+/, '')
    .toLowerCase();
}

function extractInviteCodes(text) {
  return Array.from(new Set((String(text || '').match(INVITE_CODE_REGEX) || [])
    .map(code => code.toUpperCase())
    .filter(code => !/^\d+$/.test(code))));
}

function parseInviteLine(line, rowNumber = 0) {
  const text = normalizeText(line);
  if (!text) return null;

  const codes = extractInviteCodes(text);
  const code = codes[0] || '';
  if (!code) return null;

  const withoutCode = normalizeText(text.replace(new RegExp(`\\b${code}\\b`, 'i'), ''));
  const handle = normalizeHandle(withoutCode.split(/\s+/).find(Boolean) || withoutCode);
  if (!handle) return null;

  return {
    handle,
    display_name: handle,
    code,
    rowNumber,
    raw: line,
  };
}

function parseDelimitedText(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line, index) => parseInviteLine(line, index + 1))
    .filter(Boolean);
}

function loadInviteList(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file does not exist: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (['.xlsx', '.xls'].includes(ext)) {
    throw new Error('Excel import is intentionally not enabled in Layer 1. Export the sheet to CSV/text or add a reviewed parser in Layer 2.');
  }
  return parseDelimitedText(filePath);
}

function uniqueByCode(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item.code || seen.has(item.code)) continue;
    seen.add(item.code);
    result.push(item);
  }
  return result;
}

module.exports = {
  INVITE_CODE_REGEX,
  normalizeText,
  normalizeHandle,
  extractInviteCodes,
  parseInviteLine,
  loadInviteList,
  uniqueByCode,
};
