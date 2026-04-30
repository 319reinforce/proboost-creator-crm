function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function page(title, body, activeTab = 'send') {
  const tabs = [
    { key: 'send', label: '发信', href: '/send' },
    { key: 'followup', label: '二次触达', href: '/followup' },
    { key: 'dashboard', label: '数据看板', href: '/dashboard' },
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/app.css" />
  <script defer src="/assets/app.js"></script>
</head>
<body>
  <header>
    <h1>ProBoost Creator CRM</h1>
    <nav class="tabs" aria-label="主功能">
      ${tabs.map(tab => `<a class="tab ${activeTab === tab.key ? 'is-active' : ''}" href="${tab.href}">${tab.label}</a>`).join('')}
    </nav>
    <nav class="utility-nav">
      <a class="button secondary" href="/logs">日志</a>
    </nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

module.exports = {
  page,
};
