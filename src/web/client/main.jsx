import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  Mail,
  RefreshCw,
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
