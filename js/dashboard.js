/* ══ Full dashboard render ════════════════════════════════ */

function renderDashboard(spec) {
  const data   = getFilteredData();
  const grid   = document.getElementById('charts-grid');
  const colSet = new Set(AppState.columns);

  const hint = document.getElementById('ready-hint');
  if (hint) hint.style.display = 'none';

  const firstNum = AppState.columns.find(c => AppState.colTypes[c] === 'number') || AppState.columns[0];
  const firstStr = AppState.columns.find(c => AppState.colTypes[c] === 'string') || AppState.columns[0];

  // Never drop KPIs — fix bad columns in-place
  const validKpis = (spec.kpi_cards || []).map(k => {
    if (!colSet.has(k.column)) k = { ...k, column: firstNum };
    // Validate value_column for top_label too
    if (k.value_column && !colSet.has(k.value_column)) k = { ...k, value_column: firstNum };
    return k;
  });

  // Never drop charts — fix bad columns in-place
  const validCharts = (spec.charts || []).map(c => {
    const xOk = !c.x_column || colSet.has(c.x_column);
    const yOk = !c.y_column || colSet.has(c.y_column);
    if (!xOk || !yOk) {
      c = { ...c,
        x_column: xOk ? c.x_column : firstStr,
        y_column: yOk ? c.y_column : firstNum
      };
    }
    return c;
  });

  let html = '';
  if (validKpis.length) {
    html += `<div class="kpi-row">${validKpis.map(k => {
      let display = '—';
      try {
        const val = computeKPI(data, k);
        display = formatKPIValue(val, k);
      } catch (e) {
        console.error('KPI render error:', k.title, e);
      }
      const dbgText = k.aggregation === 'top_label'
        ? `top(${k.column}) by ${k.value_column}`
        : `${k.aggregation}(${k.column})`;
      return `<div class="kpi-card">
        <div class="kpi-label">${k.title}</div>
        <div class="kpi-value">${display}</div>
        <div class="kpi-dbg">${dbgText} · fmt:${k.format}</div>
      </div>`;
    }).join('')}</div>`;
  }

  validCharts.forEach(c => {
    const dbgText = `x:${c.x_column} | y:${c.y_column} | ${c.aggregation}`;
    html += `<div class="chart-card${c.width === 2 ? ' wide' : ''}${c.type === 'table' ? ' table-card' : ''}" id="card-${c.id}">
      <div class="chart-hdr">
        <span class="chart-title">${c.title}</span>
        <span class="dbg-info" title="${dbgText}">${dbgText}</span>
      </div>
      <div class="chart-body"><div class="plotly-chart" id="${c.id}"></div></div>
    </div>`;
  });

  grid.innerHTML = html;
  validCharts.forEach(c => setTimeout(() => renderChart(c, data), 40));

  renderFilterBar(spec);
  renderSlicers(spec);
}

/* ══ Debug mode toggle ════════════════════════════════════ */

function toggleDebugMode() {
  document.body.classList.toggle('debug-mode');
  const on = document.body.classList.contains('debug-mode');
  document.getElementById('btn-debug').textContent = on ? '🔍 Debug ON' : '🔍 Debug';
}

/* ══ Interactive filter bar (top of charts area) ══════════ */

function renderFilterBar(spec) {
  const bar = document.getElementById('filter-strip');
  if (!spec) { bar.innerHTML = ''; return; }

  // Detect date column: only from spec.filters (never fall back to all dataset date columns)
  const dateCol = (spec.filters || []).find(f => AppState.colTypes[f.column] === 'date')?.column;

  if (dateCol) AppState.filters.__dateCol = dateCol;

  // Categorical filter columns (non-date)
  const catFilters = (spec.filters || []).filter(f => AppState.colTypes[f.column] !== 'date');

  let html = '';

  // Date range pickers
  if (dateCol) {
    const fromVal = AppState.filters.__dateFrom || '';
    const toVal   = AppState.filters.__dateTo   || '';
    html += `
      <span class="fb-label">📅 Date</span>
      <input type="date" id="fb-date-from" class="fb-input" value="${fromVal}" onchange="applyDateFilter()">
      <span class="fb-sep">→</span>
      <input type="date" id="fb-date-to" class="fb-input" value="${toVal}" onchange="applyDateFilter()">
      <span class="fb-divider"></span>`;
  }

  // Multi-select dropdowns
  catFilters.forEach(f => {
    if (!AppState.rawData) return;
    const allVals   = AppState.rawData.map(r => r[f.column]);
    const hasEmpty  = allVals.some(v => v === null || v === undefined || v === '');
    const unique    = [...new Set(allVals.map(v => (v == null || v === '') ? null : String(v)).filter(v => v !== null))].sort();
    const selected  = Array.isArray(AppState.filters[f.column]) ? AppState.filters[f.column] : [];
    const selCount  = selected.length;
    const label     = f.label || f.column;
    const safeId    = f.column.replace(/[^a-zA-Z0-9]/g, '_');

    const opts = unique.map(v =>
      `<label class="fb-opt"><input type="checkbox" value="${escAttr(v)}"${selected.includes(v) ? ' checked' : ''}> ${v}</label>`
    ).join('');

    const emptyOpt = hasEmpty
      ? `<label class="fb-opt"><input type="checkbox" value="__empty__"${selected.includes('__empty__') ? ' checked' : ''}> No ${label}</label>`
      : '';

    html += `
      <div class="fb-multi">
        <button class="fb-multi-btn${selCount ? ' active' : ''}" onclick="toggleMultiDrop('${safeId}',event)">
          ${label}${selCount ? ` <span class="fb-badge">${selCount}</span>` : ''} ▾
        </button>
        <div class="fb-drop hidden" id="fb-drop-${safeId}" data-col="${escAttr(f.column)}">
          <label class="fb-opt fb-opt-all">
            <input type="checkbox" id="fb-all-${safeId}"${!selCount ? ' checked' : ''}
              onchange="fbToggleAll('${safeId}',this.checked)"> All
          </label>
          <div class="fb-opts-scroll">${opts}${emptyOpt}</div>
          <button class="fb-apply" onclick="applyMultiFilter('${safeId}')">Apply</button>
        </div>
      </div>`;
  });

  html += `
    <div class="spacer"></div>
    <span id="row-count" class="row-count"></span>
    <button class="fb-reset" onclick="resetAllFilters()">↺ Reset All Filters</button>`;

  bar.innerHTML = html;
  fbUpdateRowCount();
}

function escAttr(v) { return String(v).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/* ══ Filter interactions ══════════════════════════════════ */

function toggleMultiDrop(safeId, e) {
  e && e.stopPropagation();
  const drop = document.getElementById(`fb-drop-${safeId}`);
  if (!drop) return;
  document.querySelectorAll('.fb-drop').forEach(d => { if (d !== drop) d.classList.add('hidden'); });
  drop.classList.toggle('hidden');
}

function fbToggleAll(safeId, checked) {
  const drop = document.getElementById(`fb-drop-${safeId}`);
  if (!drop) return;
  drop.querySelectorAll('.fb-opts-scroll input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
}

function applyMultiFilter(safeId) {
  const drop = document.getElementById(`fb-drop-${safeId}`);
  if (!drop) return;
  const col     = drop.dataset.col;
  const boxes   = [...drop.querySelectorAll('.fb-opts-scroll input[type="checkbox"]')];
  const total   = boxes.length;
  const checked = boxes.filter(cb => cb.checked).map(cb => cb.value);

  // All checked or none checked → no filter (show all)
  AppState.filters[col] = (checked.length === 0 || checked.length === total) ? [] : checked;

  // Update All checkbox
  const allCb = drop.querySelector(`#fb-all-${safeId}`);
  if (allCb) allCb.checked = checked.length === total || checked.length === 0;

  drop.classList.add('hidden');

  // Update button appearance
  const btn = drop.previousElementSibling;
  const sel = AppState.filters[col];
  const label = drop.dataset.col;
  btn.className = `fb-multi-btn${sel.length ? ' active' : ''}`;
  btn.innerHTML = sel.length
    ? `${label} <span class="fb-badge">${sel.length}</span> ▾`
    : `${label} ▾`;

  fbUpdateRowCount();
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

function applyDateFilter() {
  AppState.filters.__dateFrom = document.getElementById('fb-date-from')?.value || '';
  AppState.filters.__dateTo   = document.getElementById('fb-date-to')?.value   || '';
  fbUpdateRowCount();
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

function resetAllFilters() {
  const dateCol = AppState.filters.__dateCol;
  AppState.filters = {};
  if (dateCol) AppState.filters.__dateCol = dateCol;
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

function fbUpdateRowCount() {
  const el = document.getElementById('row-count');
  if (!el || !AppState.rawData) return;
  const total    = AppState.rawData.length;
  const filtered = getFilteredData().length;
  el.textContent = filtered < total
    ? `${filtered.toLocaleString()} / ${total.toLocaleString()} rows`
    : `${total.toLocaleString()} rows`;
}

/* ══ Left panel slicers (secondary) ══════════════════════ */

function renderSlicers(spec) {
  const list     = document.getElementById('slicer-list');
  const btnClear = document.getElementById('btn-clear-all');
  if (!spec?.filters?.length) {
    list.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--mut)">No filters for this dashboard.</div>';
    btnClear.classList.add('hidden');
    return;
  }
  const maxUnique = 60;
  let html = '';
  spec.filters.forEach(f => {
    const unique = [...new Set((AppState.rawData || [])
      .map(r => r[f.column]).filter(v => v != null && v !== ''))].sort((a, b) => String(a).localeCompare(String(b)));
    if (unique.length > maxUnique) return;
    const selected = Array.isArray(AppState.filters[f.column])
      ? (AppState.filters[f.column][0] || 'all')
      : (AppState.filters[f.column] || 'all');
    const opts = unique.map(v =>
      `<option value="${escAttr(String(v))}"${selected === String(v) ? ' selected' : ''}>${v}</option>`
    ).join('');
    html += `<div class="slicer">
      <div class="slicer-hdr">${f.label || f.column}</div>
      <select class="slicer-select" onchange="applyFilter('${f.column.replace(/'/g,"\\'")}',this.value)">
        <option value="all">All</option>${opts}
      </select>
    </div>`;
  });
  list.innerHTML = html || '<div style="padding:12px;font-size:12px;color:var(--mut)">No filterable columns found.</div>';
  const hasActive = Object.entries(AppState.filters).some(([k, v]) =>
    !k.startsWith('__') && Array.isArray(v) ? v.length > 0 : (v && v !== 'all')
  );
  btnClear.classList.toggle('hidden', !hasActive);
}

function applyFilter(column, value) {
  AppState.filters[column] = value === 'all' ? [] : [value];
  renderSlicers(AppState.currentSpec);
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

/* ══ Build ═══════════════════════════════════════════════ */

async function buildDashboard() {
  if (AppState.mode === 'powerbi') return _buildPowerBI();

  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt)           { toast('Describe your dashboard requirements first.', 'error'); return; }
  if (!AppState.rawData) { toast('Upload a data file first.', 'error'); return; }
  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  if (!key) { toast('Enter your Claude API key in Settings first.', 'error'); return; }

  showLoading('Generating dashboard…', 'Claude is analysing your data and requirements');
  addLogEntry('user', prompt);

  const ctx = buildDataContext();
  const rowNote = ctx.totalRows > ctx.rowsSent
    ? `${ctx.rowsSent.toLocaleString()} of ${ctx.totalRows.toLocaleString()} rows shown`
    : `${ctx.totalRows.toLocaleString()} rows`;
  const userMsg =
`I have a dataset: ${ctx.fileName} (${ctx.totalRows.toLocaleString()} total rows, ${AppState.columns.length} columns)

COLUMN SUMMARY:
${ctx.profileText}

FULL DATA (${rowNote}):
${ctx.csvText}

DASHBOARD REQUIREMENTS:
${prompt}`;
  AppState.conversation = [{ role: 'user', content: userMsg }];

  try {
    const raw  = await callClaude(AppState.conversation);
    AppState.conversation.push({ role: 'assistant', content: raw });
    const spec = extractSpec(raw);
    AppState.currentSpec = spec;
    AppState.filters     = {};
    addLogEntry('assistant', `Built: "${spec.title}" — ${spec.charts?.length || 0} charts, ${spec.kpi_cards?.length || 0} KPIs`);
    renderDashboard(spec);
    document.getElementById('btn-refine').disabled = false;
    document.getElementById('btn-download-pbix').disabled = false;
    document.getElementById('prompt-input').value = '';
    toast('Dashboard built! ✓', 'success');
    setStatus(`Dashboard: "${spec.title}" — ${spec.charts?.length || 0} charts`);
  } catch (err) {
    addLogEntry('assistant', `Error: ${err.message}`);
    toast(`Error: ${err.message}`, 'error');
    console.error('Build error:', err);
  } finally { hideLoading(); }
}

/* ══ Refine ══════════════════════════════════════════════ */

async function refineDashboard() {
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt)               { toast('Describe what to change.', 'error'); return; }
  if (!AppState.currentSpec) { toast('Build a dashboard first.', 'error'); return; }

  showLoading('Refining dashboard…', 'Applying your changes');
  addLogEntry('user', `[Refine] ${prompt}`);
  const refineMsg = `Current specification:\n${JSON.stringify(AppState.currentSpec, null, 2)}\n\nRefinement request: ${prompt}\n\nReturn the complete updated JSON specification.`;
  AppState.conversation.push({ role: 'user', content: refineMsg });

  try {
    const raw  = await callClaude(AppState.conversation);
    AppState.conversation.push({ role: 'assistant', content: raw });
    const spec = extractSpec(raw);
    AppState.currentSpec = spec;
    AppState.filters     = {};
    addLogEntry('assistant', `Refined — ${spec.charts?.length || 0} charts, ${spec.kpi_cards?.length || 0} KPIs`);
    renderDashboard(spec);
    document.getElementById('prompt-input').value = '';
    toast('Dashboard refined! ✓', 'success');
  } catch (err) {
    addLogEntry('assistant', `Error: ${err.message}`);
    toast(`Refine error: ${err.message}`, 'error');
    console.error('Refine error:', err);
  } finally { hideLoading(); }
}

/* ══ Power BI Mode ═══════════════════════════════════════ */

async function _buildPowerBI() {
  if (!AppState.rawData) { toast('Upload a data file first.', 'error'); return; }
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) { toast('Describe your dashboard requirements first.', 'error'); return; }

  const serverUrl = (localStorage.getItem('mcp_server_url') || 'http://localhost:3001').replace(/\/$/, '');

  showLoading('Building Power BI Dashboard…', 'Generating layout with cloud AI…');
  addLogEntry('user', prompt);

  try {
    // Build CSV string from raw data
    const cols = AppState.columns;
    const csvRows = [
      cols.join(','),
      ...AppState.rawData.map(r => cols.map(c => {
        const v = r[c] ?? '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
    ];
    const csvData = csvRows.join('\n');

    // Server handles the LLM call (Groq cloud or local Ollama fallback)
    const resp = await fetch(`${serverUrl}/api/build-powerbi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csvData,
        columns:  AppState.columns,
        colTypes: AppState.colTypes,
        prompt,
        fileName: AppState.fileName || 'data.csv'
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${resp.status}`);
    }

    const result = await resp.json();
    if (!result.success) throw new Error(result.error || 'Unknown server error');

    // Convert Power BI spec to Plotly-compatible spec for browser preview
    const spec = result.spec;
    console.info('[PBI raw spec] kpi_cards:', JSON.stringify(spec.kpi_cards));
    console.info('[PBI raw spec] dax_measures:', JSON.stringify(spec.dax_measures));
    const previewSpec = convertPbiSpecToPreview(spec, prompt);
    console.info('[PBI preview kpis]', previewSpec.kpi_cards.map(k => `${k.title} [${k.aggregation}:${k.column}]`));
    AppState.currentSpec = previewSpec;
    AppState.filters = {};
    renderDashboard(previewSpec);

    // Decode base64 pbit and trigger download
    const pbitBlob = _base64ToBlob(result.pbitBase64, 'application/octet-stream');
    AppState.lastPbitBlob     = pbitBlob;
    AppState.lastPbitFileName = result.fileName;
    const dlUrl = URL.createObjectURL(pbitBlob);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = result.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);

    addLogEntry('assistant', `Power BI dashboard built: "${spec.title}" — downloading ${result.fileName}`);
    document.getElementById('btn-refine').disabled = false;
    document.getElementById('btn-download-pbix').disabled = false;
    document.getElementById('prompt-input').value = '';
    toast('Power BI file ready — opening download! ✓', 'success');
    setStatus(`Power BI: "${spec.title}" — ${spec.charts?.length || 0} charts`);
  } catch (err) {
    addLogEntry('assistant', `Error: ${err.message}`);
    if (err.message.includes('fetch') || err.message.includes('NetworkError') || err.message.includes('Failed to fetch')) {
      toast('Cannot reach MCP server. Run: npm start', 'error');
    } else {
      toast(`Error: ${err.message}`, 'error');
    }
    console.error('PowerBI build error:', err);
  } finally { hideLoading(); }
}

function _pbiNorm(s) {
  return String(s).toLowerCase().replace(/[\s_\-]+/g, '');
}

function _chartTypesFromPrompt(prompt) {
  const p = prompt.toLowerCase();
  const types = [];
  const re = /\b(line|area|donut|pie|bar|column|scatter|funnel)\s*(?:chart|graph)?\b/g;
  let m;
  while ((m = re.exec(p)) !== null) {
    types.push(m[1] === 'column' ? 'bar' : m[1]);
  }
  return types;
}

function convertPbiSpecToPreview(spec, prompt) {
  const promptTypes = prompt ? _chartTypesFromPrompt(prompt) : [];

  return {
    title: spec.title,
    description: spec.description,
    kpi_cards: (spec.kpi_cards || []).map(k => ({
      title:        k.title,
      column:       k._column        || k.column      || AppState.columns.find(c => AppState.colTypes[c] === 'number') || AppState.columns[0],
      aggregation:  k._aggregation   || k.aggregation || 'sum',
      format:       k.format || 'number',
      value_column: k._value_column  || k.value_column || undefined
    })),
    charts: (spec.charts || []).map((c, i) => {
      // Trust server-resolved type — do NOT override by prompt-position as chart order varies
      const type = c.type || 'bar';
      const xCol = c._category_column || c.x_column || AppState.columns.find(col => AppState.colTypes[col] !== 'number') || AppState.columns[0];
      const yCol = c._y_column        || c.y_column || AppState.columns.find(col => AppState.colTypes[col] === 'number') || AppState.columns[0];
      return {
        id:          c.id || `chart${i + 1}`,
        title:       c.title,
        type,
        x_column:    xCol,
        y_column:    yCol,
        aggregation: c._aggregation || c.aggregation || 'sum',
        width:       c.width || 1,
        orientation: (type === 'bar' && /\btop\b|\branking?\b/i.test(c.title)) ? 'h' : 'v',
        sort_by:     'y',
        sort_order:  'desc',
        top_n:       c.top_n || null
      };
    }),
    filters: spec.filters || []
  };
}

function inferColumnFromMeasure(measure, columns, colTypes) {
  if (!measure) return columns.find(c => colTypes[c] === 'number') || columns[0];

  // Extract ALL bracketed names from DAX: SUM('Table'[Column]) → try each
  const matches = [...measure.expression.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
  for (const candidate of matches) {
    // 1. Exact match
    const exact = columns.find(c => c === candidate);
    if (exact) return exact;
    // 2. Case-insensitive
    const ci = columns.find(c => c.toLowerCase() === candidate.toLowerCase());
    if (ci) return ci;
    // 3. Normalised (remove spaces/underscores)
    const norm = columns.find(c => _pbiNorm(c) === _pbiNorm(candidate));
    if (norm) return norm;
    // 4. Partial — column contains all words of the candidate
    const words = candidate.toLowerCase().replace(/[_\-]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const partial = columns.find(c => words.every(w => c.toLowerCase().includes(w)));
    if (partial) return partial;
  }

  // Fallback: match measure name words against numeric column names
  const mWords = measure.name.toLowerCase().replace(/[_\-]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const byName = columns.find(c => colTypes[c] === 'number' && mWords.some(w => c.toLowerCase().includes(w)));
  if (byName) return byName;

  return columns.find(c => colTypes[c] === 'number') || columns[0];
}

function inferAggFromMeasure(measure) {
  if (!measure) return 'sum';
  const expr = measure.expression.toUpperCase();
  if (expr.includes('DISTINCTCOUNT')) return 'count_distinct';
  if (expr.includes('COUNTROWS') || expr.match(/\bCOUNT\s*\(/)) return 'count';
  if (expr.includes('AVERAGE') || expr.includes('AVG(')) return 'mean';
  if (expr.includes('MAX(')) return 'max';
  if (expr.includes('MIN(')) return 'min';
  return 'sum';
}

/* ══ Clear ═══════════════════════════════════════════════ */

function clearDashboard() {
  // State
  AppState.conversation = [];
  AppState.currentSpec  = null;
  AppState.filters      = {};
  AppState.rawData      = null;
  AppState.fileName     = '';
  AppState.columns      = [];
  AppState.colTypes     = {};
  AppState.datasets     = [];

  // Multi-dataset UI — reset to single empty view
  document.getElementById('multi-ds-bar').classList.add('hidden');
  document.getElementById('multi-ds-view').classList.add('hidden');
  document.getElementById('multi-ds-view').innerHTML = '';
  document.getElementById('single-ds-view').classList.remove('hidden');

  // Prompt input
  document.getElementById('prompt-input').value = '';

  // Charts grid — restore ready hint
  document.getElementById('charts-grid').innerHTML = `<div class="ready-hint" id="ready-hint">
    <div class="ready-icon">📊</div>
    <div class="ready-title">AI Dashboard Builder</div>
    <div class="ready-msg">Upload data, describe your dashboard requirements, and click <strong>Build Dashboard</strong>.<br>AI will generate interactive visualisations tailored to your data.</div>
    <div class="ready-steps">
      <div class="ready-step"><span class="step-n">1</span>Upload a CSV or data file</div>
      <div class="ready-step"><span class="step-n">2</span>Describe your requirements</div>
      <div class="ready-step"><span class="step-n">3</span>Click Build Dashboard</div>
      <div class="ready-step"><span class="step-n">4</span>Refine with follow-up prompts</div>
    </div>
  </div>`;

  // Active filter strip
  document.getElementById('filter-strip').innerHTML = '';

  // Left panel — Log tab
  document.getElementById('history-log').innerHTML = '';

  // Left panel — Filters tab
  document.getElementById('slicer-list').innerHTML = '';
  const clearAllBtn = document.getElementById('btn-clear-all');
  if (clearAllBtn) clearAllBtn.classList.add('hidden');

  // Left panel — Data tab
  document.getElementById('ds-name').textContent   = 'No dataset loaded';
  document.getElementById('ds-meta').textContent   = 'Upload a file to begin';
  document.getElementById('col-chips').innerHTML   = '';
  document.getElementById('data-preview-table').innerHTML = '';
  document.getElementById('preview-row-info').textContent = '';

  // Header dataset pill
  updateDatasetPill('');

  // Buttons
  document.getElementById('btn-refine').disabled        = true;
  document.getElementById('btn-download-pbix').disabled = true;

  setStatus('Ready — upload a file to begin');
}

function _base64ToBlob(b64, mime) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* Re-download the last built .pbit (called by the Download button) */
function downloadLastPbit() {
  if (!AppState.lastPbitBlob) return;
  const url = URL.createObjectURL(AppState.lastPbitBlob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = AppState.lastPbitFileName || 'dashboard.pbit';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
