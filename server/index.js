require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { buildDashboardWithOllama, processOllamaContent, checkOllamaHealth } = require('./ollama-agent');
const { buildDashboardWithGroq, checkGroqHealth } = require('./groq-agent');
const { generatePbit } = require('./pbit-builder');
const { initRag, searchCharts, listCharts, ragStatus } = require('./chart-rag');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Force no-cache for index.html so browsers always get fresh script version tags
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, '..')));

/* ── Shared pbit response helper ───────────────────────── */
async function _respond(res, spec, csvData, columns, colTypes, fileName) {
  const pbitBuffer  = await generatePbit(spec, csvData, columns, colTypes, fileName);
  const outFileName = `dashboard_${Date.now()}.pbit`;
  res.json({ success: true, spec, pbitBase64: pbitBuffer.toString('base64'), fileName: outFileName });
}

/* ══ Main build endpoint ══════════════════════════════════
   Uses Groq cloud LLM when GROQ_API_KEY is set (default for
   hosted deployments). Falls back to local Ollama otherwise.
══════════════════════════════════════════════════════════ */
app.post('/api/build-powerbi', async (req, res) => {
  try {
    const { csvData, columns, colTypes, prompt, fileName } = req.body;
    if (!csvData) throw new Error('No CSV data provided');
    if (!prompt)  throw new Error('No prompt provided');

    const useGroq = !!process.env.GROQ_API_KEY;

    const spec = useGroq
      ? await buildDashboardWithGroq(csvData, columns, colTypes, prompt, fileName)
      : await buildDashboardWithOllama(csvData, columns, colTypes, prompt, fileName);

    await _respond(res, spec, csvData, columns, colTypes, fileName);
  } catch (err) {
    console.error('[PowerBI Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══ Client-Ollama endpoint (browser calls Ollama itself) ══
   Kept for users who run Ollama locally and prefer it.
══════════════════════════════════════════════════════════ */
app.post('/api/build-powerbi-client-ollama', async (req, res) => {
  try {
    const { ollamaContent, csvData, columns, colTypes, prompt, fileName } = req.body;
    if (!ollamaContent) throw new Error('No Ollama content provided');
    if (!csvData)       throw new Error('No CSV data provided');
    if (!prompt)        throw new Error('No prompt provided');
    const spec = await processOllamaContent(ollamaContent, csvData, columns, colTypes, prompt, fileName);
    await _respond(res, spec, csvData, columns, colTypes, fileName);
  } catch (err) {
    console.error('[PowerBI-Local Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══ RAG endpoints ═══════════════════════════════════════ */

// Search chart types by natural-language description
app.post('/api/rag/search', async (req, res) => {
  try {
    const { prompt, topK = 5 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const results   = await searchCharts(String(prompt), Number(topK), ollamaUrl);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full chart knowledge-base list (unique chart types)
app.get('/api/rag/charts', (_req, res) => {
  res.json({ charts: listCharts() });
});

// RAG engine status
app.get('/api/rag/status', (_req, res) => {
  res.json(ragStatus());
});

/* ══ Health check ════════════════════════════════════════ */
app.get('/api/health', async (req, res) => {
  const groq  = await checkGroqHealth();
  const useGroq = groq.configured;

  if (useGroq) {
    res.json({
      status:     'ok',
      llmMode:    'groq',
      groqReady:  groq.reachable,
      groqModel:  groq.model,
      error:      groq.error || null
    });
    return;
  }

  // Fall back: check local Ollama
  const ollamaUrl = process.env.OLLAMA_URL  || 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL || 'llama3.2';
  try {
    const { models, modelLoaded } = await checkOllamaHealth(ollamaUrl, model);
    res.json({ status: 'ok', llmMode: 'ollama', ollamaReachable: true, modelLoaded, model, availableModels: models });
  } catch (e) {
    res.json({ status: 'ok', llmMode: 'ollama', ollamaReachable: false, modelLoaded: false, model, error: e.message });
  }
});

/* ══ Excel export ════════════════════════════════════════ */
app.post('/api/export-excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { title, kpiCards, charts, rawData, columns, colTypes, filterColumns } = req.body;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'AI Dashboard Builder';
    wb.created = new Date();

    /* ── Shared style helpers ── */
    const C = {
      navy:    'FF1F4E79',
      green:   'FF1D6F42',
      dkGreen: 'FF155233',
      purple:  'FF5C2D91',
      orange:  'FFCC5500',
      white:   'FFFFFFFF',
      black:   'FF000000',
      dk1:     'FF1A1A1A',
      alt1:    'FFEEF3FB',
      alt2:    'FFF2F9F2',
      border:  'FFD0D0D0',
      lightBg: 'FFF8F9FA',
    };

    const fill  = argb => ({ type:'pattern', pattern:'solid', fgColor:{ argb } });
    const font  = (bold, size, argb) => ({ bold, size, color:{ argb }, name:'Calibri' });
    const align = (h, v) => ({ horizontal: h||'left', vertical: v||'middle', wrapText: false });
    const thinBorder = argb => ({ style:'thin', color:{ argb } });
    const cellBorder = c => ({ top:thinBorder(c), bottom:thinBorder(c), left:thinBorder(c), right:thinBorder(c) });

    /* Apply a style object to a cell */
    const style = (cell, opts) => {
      if (opts.fill)      cell.fill      = opts.fill;
      if (opts.font)      cell.font      = opts.font;
      if (opts.alignment) cell.alignment = opts.alignment;
      if (opts.border)    cell.border    = opts.border;
      if (opts.numFmt)    cell.numFmt    = opts.numFmt;
    };

    /* Detect numeric value */
    const isNum = v => typeof v === 'number' && !isNaN(v);

    /* Add a full-width section divider row to a worksheet */
    const sectionRow = (ws, text, bgArgb, fgArgb) => {
      const r = ws.addRow([text]);
      style(r.getCell(1), {
        fill:      fill(bgArgb || C.navy),
        font:      font(true, 12, fgArgb || C.white),
        alignment: align('left'),
        border:    cellBorder(bgArgb || C.navy),
      });
      r.height = 22;
      return r;
    };

    /* Add a header row to a worksheet */
    const headerRow = (ws, headers, bgArgb) => {
      const r = ws.addRow(headers);
      r.eachCell({ includeEmpty: false }, (cell, ci) => {
        const num = isNum(cell.value);
        style(cell, {
          fill:      fill(bgArgb || C.green),
          font:      font(true, 10, C.white),
          alignment: align(num ? 'right' : 'left'),
          border:    { bottom: thinBorder(C.dkGreen) },
        });
      });
      r.height = 18;
      return r;
    };

    /* Add a data row (alternating shade) */
    const dataRow = (ws, values, alt, isTotalRow) => {
      const r = ws.addRow(values);
      r.eachCell({ includeEmpty: true }, (cell) => {
        const num = isNum(cell.value);
        if (isTotalRow) {
          style(cell, { fill: fill(C.green), font: font(true, 10, C.white), alignment: align(num ? 'right' : 'left') });
        } else {
          if (alt) cell.fill = fill(C.alt2);
          style(cell, { font: font(false, 10, C.dk1), alignment: align(num ? 'right' : 'left') });
          cell.border = { bottom: { style:'hair', color:{ argb: C.border } } };
        }
      });
      return r;
    };

    /* ══════════════════════════
       SHEET 1: DASHBOARD
    ══════════════════════════ */
    const wsName = String(title || 'Dashboard').slice(0, 31);
    const ws = wb.addWorksheet(wsName);
    ws.properties.defaultColWidth = 22;
    ws.views = [{ showGridLines: false }];

    // ── Title bar ──
    ws.mergeCells('A1:H1');
    const tr = ws.getRow(1);
    const tc = tr.getCell(1);
    tc.value = `📊  ${title || 'Dashboard'}`;
    style(tc, { fill: fill(C.navy), font: font(true, 18, C.white), alignment: align('left', 'middle') });
    tr.height = 36;

    ws.mergeCells('A2:H2');
    const mr = ws.getRow(2);
    const mc = mr.getCell(1);
    mc.value = `Exported: ${new Date().toLocaleString()}   |   ${(rawData||[]).length.toLocaleString()} total rows`;
    style(mc, { fill: fill(C.lightBg), font: font(false, 10, C.dk1), alignment: align('left') });
    mr.height = 18;

    ws.addRow([]);

    // ── KPI Cards ──
    if (kpiCards && kpiCards.length) {
      sectionRow(ws, '  KPI SUMMARY', C.navy);
      ws.addRow([]);

      // Two rows per KPI card: label | value
      const kpiPerRow = Math.min(kpiCards.length, 4);
      for (let i = 0; i < kpiCards.length; i += kpiPerRow) {
        const group = kpiCards.slice(i, i + kpiPerRow);
        const lblRow = ws.addRow([]);
        const valRow = ws.addRow([]);
        lblRow.height = 18;
        valRow.height = 30;

        group.forEach((k, ci) => {
          const col = ci + 1;
          const lc = lblRow.getCell(col);
          lc.value = k.label || '';
          style(lc, { fill: fill(C.alt1), font: font(true, 9, C.navy), alignment: align('center') });
          lc.border = { top:thinBorder(C.navy), left:thinBorder(C.navy), right:thinBorder(C.navy) };

          const vc = valRow.getCell(col);
          vc.value = k.value || '—';
          style(vc, { fill: fill(C.alt1), font: font(true, 16, C.green), alignment: align('center', 'middle') });
          vc.border = { bottom:thinBorder(C.navy), left:thinBorder(C.navy), right:thinBorder(C.navy) };
        });
      }
      ws.addRow([]);
      ws.addRow([]);
    }

    // ── Charts ──
    const COLORS_ARGB = ['FF7C3AED','FF06B6D4','FF10B981','FFF59E0B','FFEF4444','FF8B5CF6','FF3B82F6','FFEC4899'];

    for (const chart of (charts || [])) {
      const chartType = (chart.type || '').toLowerCase();
      const chartTitle = chart.title || chart.type || 'Chart';

      // Choose header colour by chart type
      const hdrColor = {
        matrix:        C.purple,
        multi_row_card:C.orange,
        table:         C.navy,
        bullet:        C.orange,
      }[chartType] || C.green;

      sectionRow(ws, `  ${chartTitle}`, hdrColor);

      /* ── Embed chart image ── */
      if (chart.imageBase64) {
        const b64 = chart.imageBase64.replace(/^data:image\/png;base64,/, '');
        const imgId = wb.addImage({ base64: b64, extension: 'png' });
        const imgStartRow = ws.rowCount + 1;
        ws.addImage(imgId, {
          tl: { col: 0, row: imgStartRow - 1 },
          br: { col: 8, row: imgStartRow + 17 },
          editAs: 'oneCell',
        });
        for (let i = 0; i < 18; i++) ws.addRow([]);
      }

      /* ── Data table (type-specific rendering) ── */
      if (chartType === 'multi_row_card') {
        // Multi-row card: group column + one col per metric, colour-coded metric headers
        if (chart.headers && chart.headers.length) {
          const r = ws.addRow(chart.headers);
          r.eachCell({ includeEmpty: false }, (cell, ci) => {
            const isGroup = ci === 1;
            const argb = isGroup ? C.navy : COLORS_ARGB[(ci - 2) % COLORS_ARGB.length];
            style(cell, {
              fill:      fill(argb),
              font:      font(true, 10, C.white),
              alignment: align(isGroup ? 'left' : 'right'),
              border:    { bottom: thinBorder(C.dkGreen) },
            });
          });
          r.height = 18;
        }
        (chart.rows || []).forEach((row, ri) => {
          const isTotal = chart.hasTotal && ri === chart.rows.length - 1;
          const r = ws.addRow(row);
          r.eachCell({ includeEmpty: true }, (cell, ci) => {
            const isGroup = ci === 1;
            const num = !isGroup && isNum(cell.value);
            if (isTotal) {
              style(cell, { fill: fill(C.green), font: font(true, 10, C.white), alignment: align(num ? 'right' : 'left') });
            } else {
              if (ri % 2 === 1) cell.fill = fill(C.alt2);
              style(cell, { font: font(isGroup, 10, C.dk1), alignment: align(num ? 'right' : 'left') });
              if (isGroup) { cell.font = { ...cell.font, bold: true }; }
              cell.border = { bottom: { style:'hair', color:{ argb: C.border } } };
            }
          });
        });

      } else if (chartType === 'matrix') {
        // Matrix: first col = row label, rest = column values, last = total
        if (chart.headers && chart.headers.length) {
          const r = ws.addRow(chart.headers);
          r.eachCell({ includeEmpty: false }, (cell, ci) => {
            const isRowHdr = ci === 1;
            const isTotal  = ci === chart.headers.length;
            const bg = isTotal ? C.purple : (isRowHdr ? C.navy : C.purple);
            style(cell, {
              fill:      fill(bg),
              font:      font(true, 10, C.white),
              alignment: align(isRowHdr ? 'left' : 'center'),
              border:    cellBorder(bg),
            });
          });
          r.height = 20;
        }
        (chart.rows || []).forEach((row, ri) => {
          const isTotal = chart.hasTotal && ri === chart.rows.length - 1;
          const r = ws.addRow(row);
          r.eachCell({ includeEmpty: true }, (cell, ci) => {
            const isRowLabel = ci === 1;
            const isTotalCol = ci === row.length;
            const num = !isRowLabel && isNum(cell.value);
            if (isTotal) {
              style(cell, { fill: fill(C.purple), font: font(true, 10, C.white), alignment: align(isRowLabel ? 'left' : 'right') });
            } else {
              if (ri % 2 === 1) cell.fill = fill(C.alt1);
              if (isRowLabel) {
                style(cell, { font: font(true, 10, C.dk1), alignment: align('left') });
              } else {
                style(cell, { font: font(isTotalCol, 10, C.dk1), alignment: align('right') });
                if (isTotalCol) cell.fill = fill('FFEAE4F5');
              }
              cell.border = { bottom: { style:'hair', color:{ argb: C.border } } };
            }
          });
        });

      } else if (chartType === 'bullet') {
        // Bullet chart: category | actual | target | pct of target
        if (chart.headers && chart.rows && chart.rows.length) {
          headerRow(ws, chart.headers, C.orange);
          chart.rows.forEach((row, ri) => {
            const isTotal = chart.hasTotal && ri === chart.rows.length - 1;
            const enriched = [...row];
            // Add a % of target column if we have actual+target (cols 1 and 2)
            if (row.length >= 3 && isNum(row[1]) && isNum(row[2]) && row[2] !== 0) {
              enriched.push(row[1] / row[2]); // ratio
            }
            const r = ws.addRow(enriched);
            r.eachCell({ includeEmpty: true }, (cell, ci) => {
              const num = ci > 1 && isNum(cell.value);
              if (isTotal) {
                style(cell, { fill: fill(C.orange), font: font(true, 10, C.white), alignment: align(num ? 'right' : 'left') });
              } else {
                if (ri % 2 === 1) cell.fill = fill('FFFFF0E6');
                style(cell, { font: font(false, 10, C.dk1), alignment: align(num ? 'right' : 'left') });
                // Percent of target gets a data bar visual
                if (ci === enriched.length && isNum(cell.value)) {
                  cell.numFmt = '0.0%';
                  cell.dataValidation = undefined;
                }
                cell.border = { bottom: { style:'hair', color:{ argb: C.border } } };
              }
            });
          });
        } else {
          ws.addRow(['(no bullet chart data available)']);
        }

      } else {
        // Standard chart: header row + data rows + optional total
        if (chart.headers && chart.rows && chart.rows.length) {
          headerRow(ws, chart.headers, hdrColor);
          chart.rows.forEach((row, ri) => {
            const isTotal = chart.hasTotal && ri === chart.rows.length - 1;
            dataRow(ws, row, ri % 2 === 1, isTotal);
          });
        } else if (!chart.imageBase64) {
          ws.addRow(['(no data for this chart type)']);
        }
      }

      ws.addRow([]);
      ws.addRow([]);
    }

    /* ══════════════════════════
       SHEET 2: FILTERS & CHART DATA
       Each chart gets its own table so users can sort/filter + create native Excel charts
    ══════════════════════════ */
    const usedSheetNames = new Set([wsName, 'Raw Data']);
    const uniqueSheet = (raw) => {
      const base = raw.replace(/[:\\\/\?\*\[\]]/g, '').trim().slice(0, 31) || 'Chart';
      if (!usedSheetNames.has(base)) { usedSheetNames.add(base); return base; }
      for (let i = 2; i < 999; i++) {
        const candidate = base.slice(0, 28) + '_' + i;
        if (!usedSheetNames.has(candidate)) { usedSheetNames.add(candidate); return candidate; }
      }
      return base + '_' + Date.now();
    };

    for (const chart of (charts || [])) {
      if (!chart.rows || !chart.rows.length || !chart.headers) continue;
      const sheetTitle = uniqueSheet(chart.title || chart.type || 'Chart');
      const wsc = wb.addWorksheet(sheetTitle);
      wsc.views = [{ showGridLines: true }];
      wsc.properties.defaultColWidth = 18;

      // Instruction row
      const instRow = wsc.addRow([`Data for: ${chart.title || chart.type}  —  Use Insert > Chart to create an interactive Excel chart from this table`]);
      instRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
      wsc.addRow([]);

      // Header
      const hr = wsc.addRow(chart.headers);
      hr.eachCell({ includeEmpty: false }, (cell, ci) => {
        const isFirst = ci === 1;
        style(cell, {
          fill:      fill(C.green),
          font:      font(true, 10, C.white),
          alignment: align(isFirst ? 'left' : 'right'),
          border:    { bottom: thinBorder(C.dkGreen) },
        });
      });
      hr.height = 18;

      // Data rows
      chart.rows.forEach((row, ri) => {
        const isTotal = chart.hasTotal && ri === chart.rows.length - 1;
        const r = wsc.addRow(row);
        r.eachCell({ includeEmpty: true }, (cell, ci) => {
          const num = ci > 1 && isNum(cell.value);
          if (isTotal) {
            style(cell, { fill: fill(C.green), font: font(true, 10, C.white), alignment: align(num ? 'right' : 'left') });
          } else {
            if (ri % 2 === 1) cell.fill = fill(C.alt2);
            style(cell, { font: font(false, 10, C.dk1), alignment: align(num ? 'right' : 'left') });
          }
        });
      });

      // AutoFilter on header
      const dataStart = 3; // row 3 = header
      wsc.autoFilter = { from: { row: dataStart, column: 1 }, to: { row: dataStart, column: chart.headers.length } };
    }

    /* ══════════════════════════
       SHEET 3: RAW DATA (with AutoFilter = interactive filtering)
    ══════════════════════════ */
    const ws2 = wb.addWorksheet('Raw Data');
    ws2.views = [{ showGridLines: true }];
    ws2.properties.defaultColWidth = 16;

    if (rawData && rawData.length && columns && columns.length) {
      // Instructions
      const instR = ws2.addRow(['💡 Use the AutoFilter dropdowns (▼) in row 2 to filter data. The Raw Data table will update accordingly.']);
      instR.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF444444' } };
      instR.getCell(1).fill = fill('FFFFFDE7');
      ws2.addRow([]);

      // Header row
      const hdrRow = ws2.addRow(columns);
      hdrRow.eachCell({ includeEmpty: false }, (cell) => {
        style(cell, {
          fill:      fill(C.navy),
          font:      font(true, 10, C.white),
          alignment: align('left'),
          border:    { bottom: thinBorder(C.navy) },
        });
      });
      hdrRow.height = 20;

      // AutoFilter on row 3
      ws2.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };

      // Freeze header
      ws2.views = [{ state:'frozen', xSplit:0, ySplit:3, showGridLines:true }];

      // Data
      rawData.forEach((row, ri) => {
        const cells = columns.map(c => {
          const v = row[c];
          return (colTypes && colTypes[c] === 'number' && v !== '' && v != null) ? Number(v) : (v ?? '');
        });
        const r = ws2.addRow(cells);
        if (ri % 2 === 1) {
          r.eachCell({ includeEmpty: true }, cell => { cell.fill = fill(C.alt2); });
        }
        r.eachCell({ includeEmpty: false }, (cell, ci) => {
          const col = columns[ci - 1];
          const num = colTypes && colTypes[col] === 'number';
          style(cell, { font: font(false, 10, C.dk1), alignment: align(num ? 'right' : 'left') });
        });
      });
    }

    /* ── Buffer then send (streaming to res directly risks sending headers before
          errors are caught, causing the socket to close mid-transfer) ── */
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="dashboard_${Date.now()}.xlsx"`);
    res.setHeader('Content-Length',      buffer.length);
    res.end(buffer);

  } catch(err) {
    console.error('[excel-export]', err.stack || err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/* ══ Start ═══════════════════════════════════════════════ */
app.listen(PORT, () => {
  const useGroq   = !!process.env.GROQ_API_KEY;
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  console.log('\n=== AI Dashboard Builder ===');
  console.log(`   App:  http://localhost:${PORT}`);
  console.log(`   LLM:  ${useGroq ? `Groq cloud (${process.env.GROQ_MODEL || 'llama-3.1-8b-instant'})` : 'Local Ollama — run: ollama serve'}`);
  if (!useGroq) console.log(`   Tip:  set GROQ_API_KEY for cloud LLM (free at console.groq.com)`);
  console.log('============================\n');

  // Initialise chart-type RAG store in the background (non-blocking)
  initRag(ollamaUrl).catch(e => console.warn('[rag] Init error:', e.message));
});

// Test endpoint: save HTML report for inspection
app.post('/save-test', express.text({limit:'10mb'}), (req, res) => {
  require('fs').writeFileSync(require('path').join(__dirname,'..','test-report.html'), req.body, 'utf8');
  res.json({ok:true});
});
