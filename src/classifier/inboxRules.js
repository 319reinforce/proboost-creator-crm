const DEFAULT_READY_KEYWORDS = ['ready'];
const INVITE_CODE_REGEX = /(?<![A-Za-z0-9])[A-Z0-9]{5,8}(?![A-Za-z0-9])/g;
const PHONE_REGEXES = [
  /\+?\d[\d\s().-]{7,}\d/g,
  /1[3-9]\d{9}/g,
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function extractInviteCodes(text) {
  return unique((String(text || '').match(INVITE_CODE_REGEX) || [])
    .map(code => code.toUpperCase())
    .filter(code => !/^\d+$/.test(code)));
}

function extractPhoneNumbers(text) {
  const found = [];
  for (const regex of PHONE_REGEXES) {
    found.push(...(String(text || '').match(regex) || []));
  }
  return unique(found.map(item => normalizeText(item)));
}

function containsAnyKeyword(text, keywords = DEFAULT_READY_KEYWORDS) {
  const haystack = normalizeText(text);
  return keywords.some(keyword => {
    const needle = normalizeText(keyword);
    if (!needle) return false;
    const explicitRegex = needle.match(/^\/(.+)\/([a-z]*)$/i);
    if (explicitRegex) {
      try {
        return new RegExp(explicitRegex[1], explicitRegex[2] || 'iu').test(haystack);
      } catch {
        return false;
      }
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu').test(haystack);
  });
}

function senderInRegisteredList(sender, registeredNames = []) {
  const senderKey = normalizeKey(sender);
  if (!senderKey) return false;
  return registeredNames.some(name => {
    const nameKey = normalizeKey(name);
    return nameKey && (senderKey.includes(nameKey) || nameKey.includes(senderKey));
  });
}

function classifyInboxReply({ row = {}, threadText = '', registeredNames = [], readyKeywords = DEFAULT_READY_KEYWORDS } = {}) {
  const text = normalizeText(threadText);
  const isReady = containsAnyKeyword(text, readyKeywords);
  const alreadyRegistered = senderInRegisteredList(row.sender, registeredNames);
  const phoneNumbers = extractPhoneNumbers(text);
  const inviteCodes = extractInviteCodes(text);

  let recommendedAction = 'ignore';
  let reason = 'no-ready-keyword';
  if (isReady && alreadyRegistered) {
    recommendedAction = 'skip_registered';
    reason = 'sender-already-registered';
  } else if (isReady && phoneNumbers.length > 0) {
    recommendedAction = 'send_whatsapp_followup';
    reason = 'ready-with-phone';
  } else if (isReady) {
    recommendedAction = 'send_register_followup';
    reason = 'ready-without-phone';
  }

  return {
    intent: isReady ? 'ready' : 'unknown',
    confidence: isReady ? 0.85 : 0.2,
    hasPhone: phoneNumbers.length > 0,
    phoneNumbers,
    inviteCodes,
    alreadyRegistered,
    recommendedAction,
    reason,
  };
}

module.exports = {
  DEFAULT_READY_KEYWORDS,
  INVITE_CODE_REGEX,
  normalizeText,
  normalizeKey,
  extractInviteCodes,
  extractPhoneNumbers,
  containsAnyKeyword,
  classifyInboxReply,
};
