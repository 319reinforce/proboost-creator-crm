(function () {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

  const rowKey = (...parts) => parts
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join('|') || `row-${Math.random().toString(16).slice(2)}`;

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

  function updateTableContent(tbodyId, rowsData, renderRow) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    const temp = document.createElement('tbody');
    temp.innerHTML = rowsData.map(renderRow).join('');

    const existingRows = Array.from(tbody.children);
    const newRows = Array.from(temp.children);
    const keyedRows = new Map();
    const consumed = new Set();

    existingRows.forEach((row, index) => {
      if (!row.dataset.rowKey) row.dataset.rowKey = `${tbodyId}:index:${index}`;
      keyedRows.set(row.dataset.rowKey, row);
    });

    newRows.forEach((newRow, i) => {
      if (!newRow.dataset.rowKey) newRow.dataset.rowKey = `${tbodyId}:index:${i}`;
      let currentRow = keyedRows.get(newRow.dataset.rowKey);

      if (!currentRow && existingRows[i] && !consumed.has(existingRows[i])) {
        currentRow = existingRows[i];
      }

      if (currentRow) {
        const openDetails = currentRow.querySelector('details[open]') !== null;
        if (currentRow.innerHTML !== newRow.innerHTML || currentRow.className !== newRow.className) {
          currentRow.innerHTML = newRow.innerHTML;
          currentRow.className = newRow.className;
          currentRow.dataset.rowKey = newRow.dataset.rowKey;
          if (openDetails) currentRow.querySelector('details')?.setAttribute('open', '');
          currentRow.style.animation = 'none';
          currentRow.offsetHeight; /* trigger reflow */
          currentRow.style.animation = 'highlightUpdate 900ms ease-out';
        }
        consumed.add(currentRow);
        const reference = tbody.children[i];
        if (reference !== currentRow) tbody.insertBefore(currentRow, reference || null);
      } else {
        newRow.style.animation = 'highlightNew 420ms ease-out';
        tbody.insertBefore(newRow, tbody.children[i] || null);
        consumed.add(newRow);
      }
    });

    Array.from(tbody.children).forEach(row => {
      if (!consumed.has(row)) row.remove();
    });
  }

  function renderResultRows(rows) {
    updateTableContent('followup-result-rows', rows, item => {
      const classification = item.classification || {};
      return `<tr data-row-key="${escapeHtml(rowKey(item.sender, item.subject, item.stage, item.template, classification.recommendedAction))}">
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
    });
  }

  function renderTaskRows(tasks) {
    updateTableContent('followup-task-rows', tasks, job => `<tr data-row-key="${escapeHtml(rowKey(job.id, job.startedAt, job.templateName))}">
      <td>${escapeHtml(job.startedAt || '-')}</td>
      <td><span class="status ${escapeHtml(statusClass(job.status))}">${escapeHtml(job.status || '-')}</span></td>
      <td>${escapeHtml(job.templateName || '-')}</td>
      <td>${escapeHtml(job.finishedAt || '-')}</td>
      <td>${job.error ? `<details><summary>错误</summary>${(job.diagnostics || []).length ? `<div class="muted">诊断 JSON：${(job.diagnostics || []).map(item => `<code>${escapeHtml(item)}</code>`).join(' ')}</div>` : ''}<pre>${escapeHtml(job.error)}</pre></details>` : escapeHtml(job.runId || '-')}</td>
    </tr>`);
  }

  function setMetricValue(el, value) {
    const next = String(value || 0);
    if (el.textContent === next) return;
    el.textContent = next;
    el.classList.remove('is-number-updated');
    el.offsetHeight; /* trigger reflow */
    el.classList.add('is-number-updated');
  }

  async function refreshFollowup() {
    if (!document.getElementById('inbox-classifier')) return;
    const response = await fetch('/api/followup-summary', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    const result = payload.result || {};

    for (const key of ['scannedRows', 'processed', 'opened', 'threadRead', 'openFailed', 'readyCount', 'whatsappFollowups', 'registerFollowups', 'skippedRegistered']) {
      const el = document.querySelector(`[data-followup-metric="${key}"]`);
      if (el) setMetricValue(el, result[key]);
    }

    const latest = payload.latest || {};
    const running = document.getElementById('followup-running');
    if (running) running.hidden = latest.status !== 'running';

    const error = document.getElementById('followup-error');
    if (error) {
      error.hidden = !latest.error;
      error.textContent = latest.error || '';
    }
    const diagnostics = document.getElementById('followup-diagnostics');
    if (diagnostics) {
      const taskDiagnostics = (payload.tasks || []).flatMap(item => item.diagnostics || []);
      diagnostics.innerHTML = taskDiagnostics.length
        ? `<div class="muted">诊断 JSON：${[...new Set(taskDiagnostics)].map(item => `<code>${escapeHtml(item)}</code>`).join(' ')}</div>`
        : '';
    }

    renderResultRows(payload.rows || []);
    renderTaskRows(payload.tasks || []);
  }

  async function refreshMailDebug() {
    const root = document.getElementById('mail-debug-root');
    if (!root) return;
    const response = await fetch('/api/mail-debug-summary', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    const running = document.getElementById('mail-debug-running');
    if (running) running.hidden = !payload.running;
  }

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
    form.setAttribute('aria-busy', 'true');
    submitter?.classList.add('is-submitting');
  });

  if (!window.EventSource) return;

  const events = new EventSource('/events');
  events.addEventListener('job', event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'ready-followup') refreshFollowup();
      if (payload.type === 'mail-debug') refreshMailDebug();
    } catch {
      // Ignore malformed event payloads; explicit refresh still works.
    }
  });
}());
