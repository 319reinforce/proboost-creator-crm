const DEFAULT_ENDPOINTS = {
  list: 'https://mail.proboost.microdata-inc.com/api/v1/email/receive/list',
  detail: 'https://mail.proboost.microdata-inc.com/api/v1/email/receive/detail',
};

function absoluteEndpoint(value) {
  return new URL(value).toString();
}

async function requestJsonWithBrowserContext(context, url, options = {}) {
  const method = options.method || 'POST';
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const body = options.body && typeof options.body === 'string'
    ? options.body
    : options.body == null
      ? undefined
      : JSON.stringify(options.body);

  if (context.request) {
    const response = await context.request.fetch(url, { method, headers, data: body });
    const text = await response.text();
    return {
      ok: response.ok(),
      status: response.status(),
      url: response.url(),
      payload: parseMaybeJson(text),
    };
  }

  const cookies = await context.cookies(url);
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body,
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    payload: parseMaybeJson(text),
  };
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.data || payload.result || payload;
}

function recordsFromPayload(payload) {
  const data = unwrapData(payload);
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.rows)) return data.rows;
  return [];
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeStatus(row = {}) {
  return String(row.markStatus || row.messageMark || row.status || row.mark || '').trim();
}

function normalizeApiRow(row = {}) {
  const id = String(row.id || row.messageId || row.receiveId || row.mailId || '').trim();
  return {
    ...row,
    id,
    sender: row.senderName || row.sender || row.expertId || row.expertName || '',
    subject: row.title || row.subject || '',
    time: row.createTime || row.receivedAt || row.sendTime || '',
    status: normalizeStatus(row),
    text: [
      row.senderName || row.sender || row.expertId,
      row.title || row.subject,
      normalizeStatus(row),
      row.createTime,
    ].filter(Boolean).join(' '),
    providerThreadId: id ? `api:email/receive:${id}` : '',
    providerMessageId: id ? `api:email/receive:${id}` : '',
    source: 'api',
  };
}

function normalizeApiDetail(payload, fallbackRow = {}) {
  const data = unwrapData(payload);
  if (!data || typeof data !== 'object') return null;
  const id = String(data.id || fallbackRow.id || '').trim();
  const contentHtml = data.content || data.bodyHtml || data.body_html || data.html || '';
  const bodyText = data.bodyText || data.body_text || htmlToText(contentHtml);
  if (!id && !bodyText) return null;
  return {
    id,
    sender: data.senderName || data.sender || data.expertId || fallbackRow.sender || '',
    subject: data.title || data.subject || fallbackRow.subject || '',
    time: data.createTime || data.receivedAt || fallbackRow.time || '',
    receiver: data.receiverName || data.receiver || '',
    contentHtml,
    bodyText,
    providerThreadId: id ? `api:email/receive:${id}` : fallbackRow.providerThreadId || '',
    providerMessageId: id ? `api:email/receive:${id}` : fallbackRow.providerMessageId || '',
    raw: data,
  };
}

function mailboxListPayload({ mailbox = 'replied', page = 1, pageSize = 10 } = {}) {
  const payload = {
    current: page,
    page,
    size: pageSize,
    pageSize,
    countryRegion: 'US',
  };
  if (mailbox === 'replied') payload.sendStatus = 9;
  return payload;
}

function detailPayloads(id) {
  return [
    { id, countryRegion: 'US' },
    { receiveId: id, countryRegion: 'US' },
    { messageId: id, countryRegion: 'US' },
    { mailId: id, countryRegion: 'US' },
  ];
}

function describeDetailPayload(payload) {
  const data = unwrapData(payload);
  if (!data || typeof data !== 'object') {
    return {
      payloadType: Array.isArray(payload) ? 'array' : typeof payload,
      hasData: Boolean(data),
      keys: [],
      hasBodyText: false,
      hasHtml: false,
    };
  }
  const keys = Object.keys(data).slice(0, 12);
  return {
    payloadType: 'object',
    hasData: true,
    keys,
    hasBodyText: Boolean(data.bodyText || data.body_text),
    hasHtml: Boolean(data.content || data.bodyHtml || data.body_html || data.html),
  };
}

function createMailApiClient({ context, endpoints = {} } = {}) {
  if (!context) throw new Error('browser context is required');
  const resolvedEndpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
  return {
    async listMailRows(params = {}) {
      const endpoint = absoluteEndpoint(resolvedEndpoints.list);
      const response = await requestJsonWithBrowserContext(context, endpoint, {
        method: 'POST',
        body: mailboxListPayload(params),
      });
      if (!response.ok) throw new Error(`mail list API failed: ${response.status}`);
      const rows = recordsFromPayload(response.payload).map(normalizeApiRow);
      const data = unwrapData(response.payload) || {};
      return {
        ...response,
        rows,
        total: data.total || rows.length,
        page: data.current || params.page || 1,
        pageSize: data.size || params.pageSize || rows.length,
        pages: data.pages || 0,
      };
    },
    async getMailDetail(params = {}) {
      const id = String(params.id || params.providerMessageId || params.providerThreadId || '').replace(/^api:email\/receive:/, '');
      if (!id) throw new Error('mail detail API requires a message id');
      const endpoint = absoluteEndpoint(resolvedEndpoints.detail);
      let lastResponse = null;
      let lastPayloadBody = null;
      const attempts = [];
      for (const body of detailPayloads(id)) {
        const response = await requestJsonWithBrowserContext(context, endpoint, {
          method: 'POST',
          body,
        });
        lastResponse = response;
        lastPayloadBody = body;
        attempts.push({
          keys: Object.keys(body).filter(key => key !== 'countryRegion'),
          status: response.status,
          ok: response.ok,
          detail: describeDetailPayload(response.payload),
        });
        if (!response.ok) continue;
        const detail = normalizeApiDetail(response.payload, params.row || {});
        if (detail?.bodyText) return { ...response, detail };
      }
      const finalDetail = describeDetailPayload(lastResponse?.payload);
      throw new Error([
        `mail detail API failed or returned no body for id=${id}`,
        `lastStatus=${lastResponse?.status || 'no-response'}`,
        `lastPayloadKeys=${finalDetail.keys.join(',') || '-'}`,
        `lastHasBodyText=${finalDetail.hasBodyText}`,
        `lastHasHtml=${finalDetail.hasHtml}`,
        `lastAttemptKeys=${Object.keys(lastPayloadBody || {}).filter(key => key !== 'countryRegion').join(',') || '-'}`,
        `attempts=${JSON.stringify(attempts)}`,
      ].join('; '));
    },
  };
}

module.exports = {
  createMailApiClient,
  htmlToText,
  normalizeApiDetail,
  normalizeApiRow,
  requestJsonWithBrowserContext,
};
