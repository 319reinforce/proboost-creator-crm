import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  ListPlus,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import './styles.css';

const numberFormat = new Intl.NumberFormat('zh-CN');
const percentFormat = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 1,
  style: 'percent',
});

const STATUS_LABELS = {
  pending: '待发送',
  sent: '已发送',
  failed: '失败',
  sending: '发送中',
  preparing: '准备中',
  prepared: '已准备',
  finished: '已完成',
  running: '运行中',
  'send-confirmed-verify-missed': '已确认待复核',
  'skipped-no-reachable-contact': '无可触达联系人',
  'profile-occupied': '登录态占用',
  default: '其他',
};

const CHART_COLORS = {
  blue: 'var(--crm-blue)',
  green: 'var(--crm-green)',
  amber: 'var(--crm-amber)',
  red: 'var(--crm-red)',
  violet: 'var(--crm-violet)',
  ink: 'var(--crm-ink)',
};

function formatNumber(value) {
  return numberFormat.format(Number(value || 0));
}

function formatPercent(value) {
  return percentFormat.format(Number.isFinite(value) ? value : 0);
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || STATUS_LABELS.default;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed: ${response.status}`);
  return data;
}

function StatCard({ icon: Icon, label, value, tone = 'blue', caption }) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <div className="stat-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </div>
      <div>
        <div key={value} className="stat-value animate-pop">{formatNumber(value)}</div>
        <div className="stat-label">{label}</div>
        {caption ? <div className="stat-caption">{caption}</div> : null}
      </div>
    </div>
  );
}

function StatusPill({ children, status }) {
  return <span className={`pill pill-${status || 'default'}`}>{children}</span>;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label ? <div className="tooltip-title">{label}</div> : null}
      {payload.map(item => (
        <div className="tooltip-row" key={`${item.name}-${item.value}`}>
          <span style={{ background: item.color || item.payload?.fill }} />
          <strong>{item.name}</strong>
          <em>{formatNumber(item.value)}</em>
        </div>
      ))}
    </div>
  );
}

function DataTable({ rows }) {
  const columns = useMemo(() => [
    {
      accessorKey: 'label',
      header: '状态',
      cell: info => (
        <StatusPill status={info.row.original.status}>
          {statusLabel(info.row.original.status || info.getValue())}
        </StatusPill>
      ),
    },
    {
      accessorKey: 'count',
      header: '批次记录',
      cell: info => formatNumber(info.getValue()),
    },
  ], []);
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="table-shell">
      <table className="modern-table">
        <thead>
          {table.getHeaderGroups().map(headerGroup => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <th key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchTable({ batches, manifestPath, templateName, disabled }) {
  const retryableBatches = batches.filter(batch => batch.status === 'failed' && batch.reason !== 'success-toast-not-found');
  const retryableNumbers = retryableBatches.map(batch => String(batch.batchNumber));
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    setSelected(current => current.filter(batchNumber => retryableNumbers.includes(batchNumber)));
  }, [batches, retryableNumbers.join('|')]);

  const allSelected = retryableNumbers.length > 0 && selected.length === retryableNumbers.length;

  function toggleBatch(batchNumber, checked) {
    const value = String(batchNumber);
    setSelected(current => {
      if (checked) return current.includes(value) ? current : [...current, value];
      return current.filter(item => item !== value);
    });
  }

  function toggleAll(checked) {
    setSelected(checked ? retryableNumbers : []);
  }

  if (!batches.length) return <p className="empty-text">这个工单还没有批次记录。</p>;
  return (
    <form className="batch-retry-form" method="post" action="/batch/send-selected">
      <input type="hidden" name="manifestPath" value={manifestPath || ''} />
      <input type="hidden" name="templateName" value={templateName || '5月新规'} />
      <div className="batch-bulk-toolbar">
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={!retryableNumbers.length || disabled}
            onChange={event => toggleAll(event.target.checked)}
          />
          全选失败批次
        </label>
        <span>{formatNumber(selected.length)} / {formatNumber(retryableNumbers.length)} 可补发</span>
        <button className="icon-action danger-action" type="submit" disabled={!manifestPath || disabled || selected.length === 0}>
          <Send size={14} />
          补发选中失败
        </button>
      </div>
      <div className="table-shell">
        <table className="modern-table batch-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>批次</th>
              <th>文件</th>
              <th>行数</th>
              <th>已选</th>
              <th>状态</th>
              <th>原因</th>
              <th>心跳</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => {
              const canRetry = batch.status === 'failed' && batch.reason !== 'success-toast-not-found';
              const batchValue = String(batch.batchNumber);
              const checked = selected.includes(batchValue);
              return (
                <tr key={batch.id || batch.batchNumber}>
                  <td>
                    {canRetry ? (
                      <input
                        type="checkbox"
                        name="batchNumbers"
                        value={batch.batchNumber}
                        checked={checked}
                        disabled={disabled}
                        onChange={event => toggleBatch(batch.batchNumber, event.target.checked)}
                        aria-label={`选择批次 ${batch.batchNumber}`}
                      />
                    ) : '-'}
                  </td>
                  <td>{batch.batchNumber}</td>
                  <td>{batch.fileName || '-'}</td>
                  <td>{formatNumber(batch.rowCount)}</td>
                  <td>{batch.selectedCount == null ? '-' : formatNumber(batch.selectedCount)}</td>
                  <td><StatusPill status={batch.status}>{batch.label || statusLabel(batch.status)}</StatusPill></td>
                  <td>{batch.reason || '-'}</td>
                  <td>{batch.lastHeartbeatAt || '-'}</td>
                  <td>
                    {canRetry ? (
                      <button
                        className="icon-action danger-action"
                        type="submit"
                        formAction="/batch/send"
                        name="batchNumber"
                        value={batch.batchNumber}
                        disabled={!manifestPath || disabled}
                      >
                        <Send size={14} />
                        发送
                      </button>
                    ) : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </form>
  );
}

function TemplateManager({ templates, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('5月新规');
  const [purpose, setPurpose] = useState('send_mail');
  const [subjectTemplate, setSubjectTemplate] = useState('5月新规');
  const [bodyTemplate, setBodyTemplate] = useState('5月新规');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const data = await postJson('/api/templates', {
        name,
        purpose,
        subjectTemplate,
        bodyTemplate,
      });
      setMessage(`已添加：${data.template?.name || name}`);
      onCreated?.(data.templates || []);
      setName('');
      setSubjectTemplate('');
      setBodyTemplate('');
    } catch (err) {
      setMessage(err.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="dashboard-band template-manager">
      <div className="template-manager-head">
        <div className="section-title">
          <ListPlus size={18} />
          <span>模板管理</span>
          <em>{formatNumber(templates.length)} 个可用模板</em>
        </div>
        <button className="refresh-button secondary-button" type="button" onClick={() => setOpen(value => !value)}>
          <Plus size={16} />
          新增模板
        </button>
      </div>

      <div className="template-chip-row">
        {templates.map(template => (
          <span className="template-chip" key={`${template.name}-${template.version}`}>
            {template.name}
            <em>v{template.version}</em>
          </span>
        ))}
      </div>

      {open ? (
        <form className="template-form" onSubmit={submit}>
          <label>
            <span>模板名</span>
            <input value={name} onChange={event => setName(event.target.value)} required />
          </label>
          <label>
            <span>用途</span>
            <input value={purpose} onChange={event => setPurpose(event.target.value)} />
          </label>
          <label>
            <span>标题模板</span>
            <input value={subjectTemplate} onChange={event => setSubjectTemplate(event.target.value)} placeholder="默认同模板名" />
          </label>
          <label className="template-body-field">
            <span>正文模板</span>
            <textarea value={bodyTemplate} onChange={event => setBodyTemplate(event.target.value)} placeholder="默认同模板名" />
          </label>
          <div className="template-form-actions">
            <button className="refresh-button" type="submit" disabled={saving}>
              <Save size={16} />
              保存模板
            </button>
            {message ? <span className={message.startsWith('已添加') ? 'form-message success' : 'form-message error'}>{message}</span> : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function WorkOrderCard({ order, templates }) {
  const summary = order.summary || {};
  const hasActiveJob = (order.activeJobs || []).length > 0;
  const [templateName, setTemplateName] = useState(templates[0]?.name || '5月新规');

  useEffect(() => {
    if (!templateName && templates[0]?.name) setTemplateName(templates[0].name);
  }, [templateName, templates]);

  return (
    <section className="dashboard-band work-order-card">
      <div className="work-order-head">
        <div>
          <div className="work-order-title">
            <FileText size={18} />
            <h3>{order.campaignName}</h3>
            <StatusPill status={hasActiveJob ? 'running' : order.status}>{hasActiveJob ? '运行中' : statusLabel(order.status)}</StatusPill>
          </div>
          <div className="work-order-paths">
            <span>源文件：{order.sourceFile || '-'}</span>
            <span>Legacy manifest：{order.manifestPath || '-'}</span>
          </div>
        </div>
        <form className="send-form" method="post" action="/batch/send-pending">
          <input type="hidden" name="manifestPath" value={order.rawManifestPath || ''} />
          <label>
            <span>模板</span>
            <input
              name="templateName"
              list="template-options"
              value={templateName}
              onChange={event => setTemplateName(event.target.value)}
            />
          </label>
          <button className="refresh-button danger-action" type="submit" disabled={!order.rawManifestPath || hasActiveJob}>
            <Send size={16} />
            创建发送工单
          </button>
        </form>
      </div>

      <div className="work-order-metrics">
        <div><strong>{formatNumber(summary.total)}</strong><span>批次</span></div>
        <div><strong>{formatNumber(summary.totalRows)}</strong><span>行</span></div>
        <div><strong>{formatNumber(summary.pending)}</strong><span>待发送</span></div>
        <div><strong>{formatNumber(summary.sent)}</strong><span>已发送</span></div>
        <div><strong>{formatNumber(summary.confirmedButUnverified)}</strong><span>待复核</span></div>
        <div><strong>{formatNumber(summary.selected)}</strong><span>已选达人</span></div>
      </div>

      {order.latestLog ? (
        <details className="work-order-log">
          <summary>最近进程：<a href={order.latestLog.href}>{order.latestLog.name}</a></summary>
          <pre>{order.latestLog.summary}</pre>
        </details>
      ) : (
        <p className="empty-text">还没有发送进程日志。</p>
      )}

      <details className="batch-details">
        <summary>查看批次明细</summary>
        <BatchTable
          batches={order.batches || []}
          manifestPath={order.rawManifestPath}
          templateName={templateName}
          disabled={hasActiveJob}
        />
      </details>
    </section>
  );
}

function SendApp({ initialPage = 1 }) {
  const [payload, setPayload] = useState(null);
  const [page, setPage] = useState(Number(initialPage || 1));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const nextPayload = await fetchJson(`/api/send-work-orders?page=${nextPage}`);
      setPayload(nextPayload);
      setPage(nextPayload.page || nextPage);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(page);
    if (!window.EventSource) return undefined;
    const events = new EventSource('/events');
    events.addEventListener('job', () => load(page));
    return () => events.close();
  }, [page]);

  const summary = payload?.summary || {};
  const workOrders = payload?.workOrders || [];
  const templates = payload?.templates || [];
  const canPrev = Number(payload?.page || page) > 1;
  const canNext = Number(payload?.page || page) < Number(payload?.totalPages || 1);

  function updateTemplates(nextTemplates) {
    setPayload(current => current ? { ...current, templates: nextTemplates } : current);
  }

  return (
    <div className="crm-app send-app">
      <datalist id="template-options">
        {templates.map(template => (
          <option key={`${template.name}-${template.version}`} value={template.name} />
        ))}
      </datalist>
      <div className="dashboard-head">
        <div>
          <p className="eyebrow">Send Mail Operations</p>
          <h2>发信工单</h2>
        </div>
        <button className="refresh-button" type="button" onClick={() => load(page)} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <section className="dashboard-band summary-band">
        <div className="stat-grid send-stat-grid">
          <StatCard icon={Mail} label="工单" value={summary.workOrders} caption="SQLite send_mail_campaigns" />
          <StatCard icon={Database} label="批次" value={summary.batches} tone="violet" caption={`${formatNumber(summary.rows)} 达人行数`} />
          <StatCard icon={Send} label="待发送" value={summary.pending} caption="可创建发送工单" />
          <StatCard icon={CheckCircle2} label="已发送" value={summary.sent} tone="green" caption={`${formatNumber(summary.selected)} 已选达人`} />
          <StatCard icon={AlertTriangle} label="需处理" value={(summary.failed || 0) + (summary.unverified || 0)} tone="red" caption="失败 / 待复核" />
        </div>
      </section>

      <TemplateManager templates={templates} onCreated={updateTemplates} />

      {loading && !payload ? <p className="empty-text">正在加载发信工单...</p> : null}
      {!loading && !workOrders.length ? (
        <section className="dashboard-band empty-panel">
          <p className="empty-text">还没有 SQLite 发信工单。上传并拆分 xlsx 后，这里会显示批次状态。</p>
        </section>
      ) : null}
      {workOrders.map(order => <WorkOrderCard key={order.id} order={order} templates={templates} />)}

      {payload && payload.totalItems > payload.pageSize ? (
        <nav className="send-pagination" aria-label="工单分页">
          <button type="button" onClick={() => setPage(page - 1)} disabled={!canPrev}>
            <ChevronLeft size={16} />
            上一页
          </button>
          <span>第 {formatNumber(payload.page)} / {formatNumber(payload.totalPages)} 页，共 {formatNumber(payload.totalItems)} 个工单</span>
          <button type="button" onClick={() => setPage(page + 1)} disabled={!canNext}>
            下一页
            <ChevronRight size={16} />
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function ChartPanel({ icon: Icon, title, children, meta }) {
  return (
    <section className="dashboard-band chart-panel">
      <div className="section-title">
        <Icon size={18} />
        <span>{title}</span>
        {meta ? <em>{meta}</em> : null}
      </div>
      {children}
    </section>
  );
}

function SendProgress({ data, successRate }) {
  return (
    <div className="progress-visual">
      <div className="donut-shell" aria-label={`发送成功率 ${formatPercent(successRate)}`}>
        <ResponsiveContainer width="100%" height={210}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius="66%"
              outerRadius="88%"
              paddingAngle={3}
              stroke="none"
            >
              {data.map(item => <Cell key={item.name} fill={item.color} />)}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <strong>{formatPercent(successRate)}</strong>
          <span>发送成功率</span>
        </div>
      </div>
      <div className="chart-legend">
        {data.map(item => (
          <div key={item.name}>
            <span style={{ background: item.color }} />
            <strong>{item.name}</strong>
            <em>{formatNumber(item.value)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function BridgeChart({ rows }) {
  if (!rows.length) return <p className="empty-text">还没有 CRM 同步发信记录。</p>;
  return (
    <div className="bar-chart">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--crm-line)" />
          <XAxis dataKey="label" tickFormatter={statusLabel} tickLine={false} axisLine={false} minTickGap={18} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
          <Tooltip content={<ChartTooltip />} />
          <Bar dataKey="count" name="记录数" radius={[6, 6, 0, 0]}>
            {rows.map(row => (
              <Cell key={row.status || row.label} fill={row.color || CHART_COLORS.blue} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function FollowupFunnel({ latest }) {
  if (!latest) return <p className="empty-text">还没有二次触达运行记录。</p>;
  const result = latest.result || {};
  const data = [
    { name: '列表行', value: result.scannedRows || 0 },
    { name: '已检查', value: result.processed || 0 },
    { name: '已点开', value: result.opened || 0 },
    { name: '已读正文', value: result.threadRead || 0 },
    { name: 'Ready', value: result.readyCount || 0 },
    { name: '触达动作', value: (result.whatsappFollowups || 0) + (result.registerFollowups || 0) },
  ];

  return (
    <div className="funnel-panel">
      <div className="followup-panel">
        <StatusPill status={latest.status}>{statusLabel(latest.status)}</StatusPill>
        <div className="followup-stats">
          <span>{formatNumber(result.whatsappFollowups)} 联系方式跟进</span>
          <span>{formatNumber(result.registerFollowups)} 注册提醒</span>
          <span>{formatNumber(result.skippedRegistered)} 已注册跳过</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={230}>
        <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="followupArea" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--crm-green)" stopOpacity={0.5} />
              <stop offset="100%" stopColor="var(--crm-green)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--crm-line)" />
          <XAxis dataKey="name" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="value" name="数量" stroke="var(--crm-green)" strokeWidth={3} fill="url(#followupArea)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function DashboardApp() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setPayload(await fetchJson('/api/dashboard'));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    if (!window.EventSource) return undefined;
    const events = new EventSource('/events');
    events.addEventListener('job', load);
    return () => events.close();
  }, []);

  const send = payload?.sendSummary || {};
  const bridge = payload?.bridgeSummary || {};
  const sqlite = payload?.sqliteSummary || {};
  const latest = payload?.latestFollowup || null;

  const batchTotal = Number(send.batches || 0);
  const successRate = batchTotal > 0 ? Number(send.sent || 0) / batchTotal : 0;
  const riskQueue = Number(send.pending || 0) + Number(send.unverified || 0) + Number(send.failed || 0);
  const sendChartRows = useMemo(() => [
    { name: '已发送', value: Number(send.sent || 0), color: CHART_COLORS.green },
    { name: '待发送', value: Number(send.pending || 0), color: CHART_COLORS.blue },
    { name: '发送中', value: Number(send.sending || 0), color: CHART_COLORS.violet },
    { name: '待复核', value: Number(send.unverified || 0), color: CHART_COLORS.amber },
    { name: '失败', value: Number(send.failed || 0), color: CHART_COLORS.red },
  ].filter(item => item.value > 0), [send.failed, send.pending, send.sending, send.sent, send.unverified]);
  const bridgeRows = useMemo(() => (payload?.bridgeRows || []).map(row => ({
    ...row,
    label: statusLabel(row.status || row.label),
    color: row.status === 'sent' ? CHART_COLORS.green
      : row.status === 'failed' || row.status === 'profile-occupied' ? CHART_COLORS.red
        : row.status === 'send-confirmed-verify-missed' ? CHART_COLORS.amber
          : row.status === 'skipped-no-reachable-contact' ? CHART_COLORS.violet
            : CHART_COLORS.blue,
  })), [payload?.bridgeRows]);

  return (
    <div className="crm-app">
      <div className="dashboard-head">
        <div>
          <p className="eyebrow">Operations Dashboard</p>
          <h2>数据看板</h2>
        </div>
        <button className="refresh-button" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <section className="dashboard-band summary-band">
        <div className="stat-grid">
          <StatCard icon={Mail} label="工单" value={send.workOrders} caption="上传拆分后的发送工作单" />
          <StatCard icon={Database} label="批次" value={send.batches} tone="violet" caption={`${formatNumber(send.rows)} 达人行数`} />
          <StatCard icon={Send} label="已发送" value={send.sent} tone="green" caption={formatPercent(successRate)} />
          <StatCard icon={Activity} label="处理中" value={send.sending} tone="amber" caption={`${formatNumber(send.prepared)} 已准备`} />
          <StatCard icon={AlertTriangle} label="需处理" value={riskQueue} tone="red" caption="待发送 / 待复核 / 失败" />
        </div>
      </section>

      <div className="dashboard-grid">
        <ChartPanel icon={BarChart3} title="发信批次进度" meta={`${formatNumber(batchTotal)} 批`}>
          {sendChartRows.length ? (
            <SendProgress data={sendChartRows} successRate={successRate} />
          ) : (
            <p className="empty-text">上传并拆分 xlsx 后，这里会显示发送进度。</p>
          )}
        </ChartPanel>

        <ChartPanel icon={Activity} title="二次触达漏斗">
          <FollowupFunnel latest={latest} />
        </ChartPanel>
      </div>

      <div className="dashboard-grid">
        <ChartPanel icon={ShieldCheck} title="SQLite 承接状态">
          <div className="compact-metrics">
            <div><strong>{formatNumber(sqlite.campaigns)}</strong><span>入库工单</span></div>
            <div><strong>{formatNumber(sqlite.batches)}</strong><span>入库批次</span></div>
            <div><strong>{formatNumber(sqlite.sent)}</strong><span>已发送</span></div>
            <div><strong>{formatNumber(sqlite.failed)}</strong><span>失败</span></div>
          </div>
        </ChartPanel>

        <ChartPanel icon={CheckCircle2} title="CRM 同步记录" meta={`${formatNumber(bridge.total)} 条`}>
          <BridgeChart rows={bridgeRows} />
        </ChartPanel>
      </div>

      <section className="dashboard-band">
        <div className="section-title">
          <CheckCircle2 size={18} />
          <span>CRM 同步发信记录明细</span>
        </div>
        <DataTable rows={bridgeRows} />
      </section>
    </div>
  );
}

const root = document.getElementById('dashboard-root');
if (root) {
  createRoot(root).render(<DashboardApp />);
}

const sendRoot = document.getElementById('send-root');
if (sendRoot) {
  createRoot(sendRoot).render(<SendApp initialPage={sendRoot.dataset.page || 1} />);
}
