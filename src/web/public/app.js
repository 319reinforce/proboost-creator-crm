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

  const selectedCreatorInviteIds = new Set();

  const formatDate = value => {
    if (!value) return '-';
    return String(value).replace('T', ' ').replace(/\.\d+Z?$/, '');
  };

  function selectedInviteIds() {
    return Array.from(selectedCreatorInviteIds).map(id => Number.parseInt(id, 10)).filter(Number.isFinite);
  }

  function setCreatorResult(message, isError = false) {
    const el = document.querySelector('[data-creator-result]');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('hard-failed', isError);
  }

  function creatorQueryParams() {
    const root = document.querySelector('[data-creator-management]');
    if (!root) return '';
    const params = new URLSearchParams();
    const q = root.querySelector('[data-creator-filter="q"]')?.value.trim();
    const campaign = root.querySelector('[data-creator-filter="campaign"]')?.value.trim();
    const pendingOnly = root.querySelector('[data-creator-filter="pendingOnly"]')?.checked;
    if (q) params.set('q', q);
    if (campaign) params.set('campaign', campaign);
    if (pendingOnly) params.set('status', 'pending');
    params.set('limit', '160');
    return params.toString();
  }

  function renderCreatorPendingRows(rows) {
    const tbody = document.querySelector('[data-creator-rows="pending"]');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7">没有待推进达人。</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(row => {
      const checked = selectedCreatorInviteIds.has(String(row.inviteCodeId)) ? 'checked' : '';
      return `<tr data-invite-code-id="${escapeHtml(row.inviteCodeId)}">
        <td><input type="checkbox" data-creator-select value="${escapeHtml(row.inviteCodeId)}" ${checked} /></td>
        <td><strong>${escapeHtml(row.handle || '-')}</strong><br><span class="muted">${escapeHtml(row.displayName || '-')}</span></td>
        <td><code>${escapeHtml(row.inviteCode || '-')}</code></td>
        <td>${escapeHtml(row.campaign || '-')}</td>
        <td>${escapeHtml(formatDate(row.sentAt))}</td>
        <td>${escapeHtml(row.creatorStatus || row.inviteStatus || '-')}</td>
        <td>${escapeHtml(row.lastSecondTouchStatus || '-')}${row.lastSecondTouchAt ? `<br><span class="muted">${escapeHtml(formatDate(row.lastSecondTouchAt))}</span>` : ''}</td>
      </tr>`;
    }).join('');
  }

  function renderCreatorActivatedRows(rows) {
    const tbody = document.querySelector('[data-creator-rows="activated"]');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">还没有已激活达人。</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(row => `<tr>
      <td><strong>${escapeHtml(row.handle || '-')}</strong><br><span class="muted">${escapeHtml(row.displayName || '-')}</span></td>
      <td><code>${escapeHtml(row.inviteCode || '-')}</code></td>
      <td>${escapeHtml(formatDate(row.activatedAt || row.registeredAt))}</td>
      <td>${escapeHtml(row.activationSource || '-')}</td>
      <td>${escapeHtml(row.operatorNote || row.activationTaskRunId || '-')}</td>
    </tr>`).join('');
  }

  function renderCreatorManagement(payload) {
    const root = document.querySelector('[data-creator-management]');
    if (!root) return;
    const pending = payload.pending || [];
    const activated = payload.activated || [];
    renderCreatorPendingRows(pending);
    renderCreatorActivatedRows(activated);

    for (const [key, value] of Object.entries(payload.summary || {})) {
      root.querySelectorAll(`[data-creator-summary="${key}"]`).forEach(el => setMetricValue(el, value));
    }
    root.querySelector('[data-creator-count="pending"]').textContent = String(pending.length);
    root.querySelector('[data-creator-count="activated"]').textContent = String(activated.length);

    const campaignSelect = root.querySelector('[data-creator-filter="campaign"]');
    if (campaignSelect && campaignSelect.options.length <= 1) {
      const current = campaignSelect.value;
      for (const name of payload.filters?.campaigns || []) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        campaignSelect.appendChild(option);
      }
      campaignSelect.value = current;
    }
  }

  async function refreshCreatorManagement() {
    if (!document.querySelector('[data-creator-management]')) return;
    const query = creatorQueryParams();
    const response = await fetch(`/api/followup/creators?${query}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    renderCreatorManagement(await response.json());
  }

  async function postCreatorAction(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `request failed: ${response.status}`);
    }
    return payload;
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

    for (const key of ['scannedRows', 'processed', 'opened', 'threadRead', 'openFailed', 'skippedKnown', 'readyCount', 'whatsappFollowups', 'registerFollowups', 'skippedRegistered']) {
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

  let creatorFilterTimer = null;

  document.addEventListener('change', event => {
    const target = event.target;
    if (target.matches?.('[data-creator-select]')) {
      if (target.checked) selectedCreatorInviteIds.add(String(target.value));
      else selectedCreatorInviteIds.delete(String(target.value));
      return;
    }
    if (target.matches?.('[data-creator-filter]')) {
      refreshCreatorManagement();
    }
  });

  document.addEventListener('input', event => {
    if (!event.target.matches?.('[data-creator-filter="q"]')) return;
    clearTimeout(creatorFilterTimer);
    creatorFilterTimer = setTimeout(refreshCreatorManagement, 220);
  });

  document.addEventListener('click', async event => {
    const action = event.target.closest?.('[data-creator-action]')?.dataset.creatorAction;
    if (!action) return;
    try {
      if (action === 'refresh') {
        await refreshCreatorManagement();
        setCreatorResult('达人状态已刷新。');
        return;
      }

      const inviteCodeIds = selectedInviteIds();
      if (inviteCodeIds.length === 0) {
        setCreatorResult('请先选择左侧待推进达人。', true);
        return;
      }

      if (action === 'activate') {
        const note = document.querySelector('[data-creator-note]')?.value || '';
        const payload = await postCreatorAction('/api/followup/creators/activate', { inviteCodeIds, note });
        selectedCreatorInviteIds.clear();
        renderCreatorManagement(payload);
        setCreatorResult(`已标记 ${payload.updated || 0} 位达人为已激活。`);
        return;
      }

      if (action === 'second-touch') {
        const templateName = document.querySelector('[data-creator-template]')?.value || '督促产品使用';
        const send = document.querySelector('[data-creator-send]')?.checked || false;
        const payload = await postCreatorAction('/api/followup/creators/second-touch', {
          inviteCodeIds,
          templateName,
          send,
        });
        setCreatorResult(`${send ? '发送' : 'Dry-run'} 工单已创建：${payload.job?.id || '-'}`);
      }
    } catch (error) {
      setCreatorResult(error.message || String(error), true);
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
    form.setAttribute('aria-busy', 'true');
    submitter?.classList.add('is-submitting');
  });

  document.addEventListener('click', event => {
    const tab = event.target.closest?.('.tab');
    if (!tab || tab.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    document.querySelectorAll('.tab.is-active').forEach(item => item.classList.remove('is-active'));
    tab.classList.add('is-active');
  });

  refreshCreatorManagement();

  if (!window.EventSource) return;

  const events = new EventSource('/events');
  events.addEventListener('job', event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'ready-followup') refreshFollowup();
      if (payload.type === 'mail-debug') refreshMailDebug();
      if (payload.type === 'creator-second-touch') refreshCreatorManagement();
    } catch {
      // Ignore malformed event payloads; explicit refresh still works.
    }
  });
}());
