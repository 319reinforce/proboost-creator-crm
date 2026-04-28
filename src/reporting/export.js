const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getCampaignStats, listUnusedInvites } = require('../importer/queries');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeCsv(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, toCsv(rows));
}

function exportCampaignReport(db, campaignName, reportDir = config.reportDir) {
  const date = new Date().toISOString().split('T')[0];
  const outDir = path.join(reportDir, date, campaignName);
  ensureDir(outDir);

  const stats = getCampaignStats(db, campaignName) || {};
  const unused = listUnusedInvites(db, campaignName);
  const summary = {
    generated_at: new Date().toISOString(),
    campaign: campaignName,
    stats,
    unused_count: unused.length,
  };

  writeJson(path.join(outDir, 'summary.json'), summary);
  writeJson(path.join(outDir, 'unused-invites.json'), unused);
  writeCsv(path.join(outDir, 'unused-invites.csv'), unused);

  return {
    outDir,
    summary,
    unusedPath: path.join(outDir, 'unused-invites.csv'),
  };
}

module.exports = {
  exportCampaignReport,
  toCsv,
};
