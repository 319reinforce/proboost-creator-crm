(function () {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

  const actionLabel = action => ({
    send_whatsapp_followup: '有联系方式，发 WhatsApp 跟进模板',
    send_register_followup: '无联系方式，发注册提醒模板',
    skip_registered: '已注册，跳过',
    ignore: '未识别 ready，忽略',
  }[action] || action || '-');

  const statusClass = status => {
    if (status === 'failed') return 'hard-failed';
    if (status === 'finished' || status === 'sent') return 'sent';
    if (status === 'dry-run' || status === 'running') return 'prepared';
    return '';
  };

  function renderResultRows(rows) {
    const tbody = document.getElementById('followup-result-rows');
    if (!tbody) return;
    tbody.innerHTML = rows.map(item => {
      const classification = item.classification || {};
      return `<tr>
        <td>${escapeHtml(item.sender || '-')}</td>
        <td>${escapeHtml(item.subject || '-')}</td>
        <td><span class="status ${escapeHtml(statusClass(item.status))}">${escapeHtml(classification.intent || item.status || '-')}</span></td>
        <td>${escapeHtml(actionLabel(classification.recommendedAction))}</td>
        <td>${escapeHtml((classification.phoneNumbers || []).join(', ') || '-')}</td>
        <td>${escapeHtml((classification.inviteCodes || []).join(', ') || '-')}</td>
        <td>${escapeHtml(item.template || '-')}</td>
        <td>${escapeHtml(item.stage || '-')}</td>
        <td>${escapeHtml(item.threadChars || 0)}</td>
        <td>${escapeHtml(item.error || '-')}</td>
      </tr>`;
    }).join('');
  }

  function renderTaskRows(tasks) {
    const tbody = document.getElementById('followup-task-rows');
    if (!tbody) return;
    tbody.innerHTML = tasks.map(job => `<tr>
      <td>${escapeHtml(job.startedAt || '-')}</td>
      <td><span class="status ${escapeHtml(statusClass(job.status))}">${escapeHtml(job.status || '-')}</span></td>
      <td>${escapeHtml(job.templateName || '-')}</td>
      <td>${escapeHtml(job.finishedAt || '-')}</td>
      <td>${job.error ? `<details><summary>错误</summary><pre>${escapeHtml(job.error)}</pre></details>` : escapeHtml(job.runId || '-')}</td>
    </tr>`).join('');
  }

  async function refreshFollowup() {
    if (!document.getElementById('inbox-classifier')) return;
    const response = await fetch('/api/followup-summary', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    const result = payload.result || {};

    for (const key of ['scannedRows', 'processed', 'opened', 'threadRead', 'openFailed', 'readyCount', 'whatsappFollowups', 'registerFollowups', 'skippedRegistered']) {
      const el = document.querySelector(`[data-followup-metric="${key}"]`);
      if (el) el.textContent = String(result[key] || 0);
    }

    const latest = payload.latest || {};
    const running = document.getElementById('followup-running');
    if (running) running.hidden = latest.status !== 'running';

    const error = document.getElementById('followup-error');
    if (error) {
      error.hidden = !latest.error;
      error.textContent = latest.error || '';
    }

    renderResultRows(payload.rows || []);
    renderTaskRows(payload.tasks || []);
  }

  if (!window.EventSource) return;
  const events = new EventSource('/events');
  events.addEventListener('job', event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'ready-followup') refreshFollowup();
    } catch {
      // Ignore malformed event payloads; explicit refresh still works.
    }
  });
}());
