const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanOutputDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const name of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, name), { recursive: true, force: true });
  }
}

function validateSplitOptions({ inputFile, batchSize, skipDataRows }) {
  if (!inputFile || !fs.existsSync(inputFile)) {
    throw new Error(`输入文件不存在: ${inputFile}`);
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`BATCH_SIZE 无效: ${batchSize}`);
  }
  if (!Number.isFinite(skipDataRows) || skipDataRows < 0) {
    throw new Error(`SKIP_DATA_ROWS 无效: ${skipDataRows}`);
  }
}

function writeBatchFile(headers, rows, batchFile) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, batchFile);
}

function splitCreators(options = {}) {
  const inputFile = options.inputFile;
  const outputDir = options.outputDir;
  const batchSize = Number(options.batchSize || 200);
  const skipDataRows = Number(options.skipDataRows || 0);
  const manifestPath = options.manifestPath || path.join(outputDir, 'manifest.json');
  const log = [];
  const writeLog = line => log.push(line);

  validateSplitOptions({ inputFile, batchSize, skipDataRows });
  ensureDir(outputDir);
  cleanOutputDir(outputDir);

  const workbook = XLSX.readFile(inputFile);
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Excel 文件没有工作表');
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const allData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (!allData || allData.length === 0) {
    throw new Error('Excel 表为空，无法拆分');
  }

  const headers = allData[0];
  if (!headers || headers.length < 2) {
    throw new Error('表头缺失或列数不足（需要至少两列：达人名、邮箱）');
  }

  const rows = allData.slice(1).filter(row => Array.isArray(row) && row.some(cell => String(cell || '').trim() !== ''));
  if (rows.length === 0) {
    throw new Error('没有数据行，无法拆分');
  }

  const originalRowCount = rows.length;
  const dataRows = skipDataRows > 0 ? rows.slice(skipDataRows) : rows;
  if (skipDataRows > 0) {
    writeLog(`⏭️  已跳过前 ${skipDataRows} 条数据行（共 ${originalRowCount} 条），剩余 ${dataRows.length} 条待拆分`);
  }
  if (dataRows.length === 0) {
    throw new Error(`跳过 ${skipDataRows} 行后没有剩余数据，无法拆分`);
  }

  const batchCount = Math.ceil(dataRows.length / batchSize);
  const batches = [];
  writeLog(`总行数: ${dataRows.length}${skipDataRows > 0 ? `（源表 ${originalRowCount} 条）` : ''}`);
  writeLog(`拆分成 ${batchCount} 批次`);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, dataRows.length);
    const batchRows = dataRows.slice(start, end);
    const batchNumber = batchIndex + 1;
    const batchFile = path.join(outputDir, `batch-${batchNumber}.xlsx`);

    writeBatchFile(headers, batchRows, batchFile);
    writeLog(`✅ 批次 ${batchNumber} 已保存: ${batchFile} (${batchRows.length} 条)`);
    batches.push({
      batchNumber,
      file: batchFile,
      rowCount: batchRows.length,
      status: 'pending',
    });
  }

  const manifest = {
    inputFile,
    outputDir,
    batchSize,
    totalRows: dataRows.length,
    sourceTotalRows: originalRowCount,
    skipDataRows,
    batchCount,
    createdAt: new Date().toISOString(),
    batches,
  };

  if (manifestPath) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeLog(`🧾 Compatibility manifest 已保存: ${manifestPath}`);
  }
  writeLog('✨ 拆分完成');

  return { manifest, log: log.join('\n') };
}

module.exports = {
  splitCreators,
};
