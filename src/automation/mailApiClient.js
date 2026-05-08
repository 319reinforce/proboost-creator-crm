function requireEndpoint(name, value) {
  if (!value) {
    throw new Error(`${name} endpoint is not configured. Run npm run mail-debug and review reports/mail-debug candidates first.`);
  }
  return value;
}

async function requestJsonWithBrowserContext(context, url, options = {}) {
  const cookies = await context.cookies(url);
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Some ProBoost endpoints may return text/html while discovery is still in progress.
  }
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    payload,
  };
}

function createMailApiClient({ context, endpoints = {} } = {}) {
  if (!context) throw new Error('browser context is required');
  return {
    listMailRows(params = {}) {
      const endpoint = requireEndpoint('mail list', endpoints.list);
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
      }
      return requestJsonWithBrowserContext(context, url.toString());
    },
    getMailDetail(params = {}) {
      const endpoint = requireEndpoint('mail detail', endpoints.detail);
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, value);
      }
      return requestJsonWithBrowserContext(context, url.toString());
    },
  };
}

module.exports = {
  createMailApiClient,
  requestJsonWithBrowserContext,
};
