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
    { key: 'mail-debug', label: '邮件验收', href: '/mail-debug' },
    { key: 'dashboard', label: '数据看板', href: '/dashboard' },
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#f4f1ea" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/app.css" />
  <script defer src="/assets/app.js"></script>
</head>
<body>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">PB</span>
      <div class="brand-copy">
        <h1>ProBoost Creator CRM</h1>
        <p>Creator operations console</p>
      </div>
    </div>
    <nav class="tabs" aria-label="主功能">
      ${tabs.map(tab => `<a class="tab ${activeTab === tab.key ? 'is-active' : ''}" href="${tab.href}">${tab.label}</a>`).join('')}
    </nav>
    <nav class="utility-nav" aria-label="辅助功能">
      <a class="button secondary compact" href="/logs">日志</a>
    </nav>
  </header>
  <main class="app-main">${body}</main>
</body>
</html>`;
}

module.exports = {
  page,
};
