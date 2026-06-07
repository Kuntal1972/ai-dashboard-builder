/* ══ Loading overlay ══════════════════════════════════════ */

function showLoading(msg, sub) {
  document.getElementById('loading-msg').textContent = msg || 'Processing…';
  document.getElementById('loading-sub').textContent = sub || '';
  document.getElementById('loading-overlay').classList.remove('hidden');
  document.getElementById('btn-build').disabled = true;
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
  document.getElementById('btn-build').disabled = false;
}

/* ══ Toast notifications ══════════════════════════════════ */

function toast(msg, type) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  const cls = type === 'success' ? 'ok' : type === 'error' ? 'err' : 'warn';
  el.className = `toast ${cls}`;
  el.textContent = msg;
  container.appendChild(el);
  const dur = AppState.config?.ui?.toastDurationMs ?? 4500;
  setTimeout(() => el.remove(), dur);
}

/* ══ Status bar ═══════════════════════════════════════════ */

function setStatus(msg) {
  document.getElementById('sb').textContent = msg;
}

/* ══ Panel tabs ═══════════════════════════════════════════ */

function switchPanelTab(name) {
  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  ['data-tab', 'filter-tab', 'log-tab', 'charts-pick-tab'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  const tabMap = { data: 'data-tab', filters: 'filter-tab', log: 'log-tab', charts: 'charts-pick-tab' };
  const target = document.getElementById(tabMap[name]);
  if (target) target.classList.remove('hidden');
}

/* ══ Smart chart prompt builder ═══════════════════════════
   Reads the loaded dataset and constructs a natural-language
   prompt tailored to the selected chart type.
   Called by addChartTypeToPrompt() whenever a dataset is loaded.
════════════════════════════════════════════════════════════ */
function _buildSmartChartPrompt(chartType) {
  const cols   = AppState.columns || [];
  const types  = AppState.colTypes || {};
  const data   = AppState.rawData  || [];
  const sample = data.slice(0, Math.min(500, data.length));

  /* ── Column classifiers ─────────────────────────────── */
  const numCols  = cols.filter(c => types[c] === 'number');
  const dateCols = cols.filter(c => types[c] === 'date');
  const strCols  = cols.filter(c => types[c] === 'string');

  const uniqueCount = col =>
    new Set(sample.map(r => r[col]).filter(v => v != null && v !== '')).size;

  const matches   = (col, kws) => kws.some(k => col.toLowerCase().includes(k));
  const isIdLike  = c => matches(c, ['id','key','code','ref','uuid',' no','num','sr.','serial','rank','index','row']);
  // Name-like columns are high-cardinality entity identifiers, not useful for grouping
  const isNameLike = c => /\bname\b|\bfull[_\s]?name\b/i.test(c);

  // Low-cardinality categoricals (≤25 unique, ≥1 unique) — best for grouping axes
  // Filter out id-like and name-like columns; sort ascending by unique count (most granular grouping first)
  const catCols = strCols
    .filter(c => !isIdLike(c) && !isNameLike(c) && uniqueCount(c) >= 1 && uniqueCount(c) <= 25)
    .sort((a, b) => uniqueCount(a) - uniqueCount(b));
  const hiCatCols = strCols.filter(c => !isIdLike(c) && !isNameLike(c) && uniqueCount(c) > 25);

  const catCol1 = catCols[0] || hiCatCols[0] || null;
  const catCol2 = catCols[1] || (catCols[0] ? catCols.find(c => c !== catCols[0]) : null) || null;

  // Geographic column detection — use word-boundary regex to avoid "Ethnicity".includes("city") false match
  const geoCol = strCols.find(c =>
    /\b(country|countries|region|state|province|city|cities|location|territory|geography|geo|nation|nationality)\b/i.test(c)
  ) || null;

  // Numeric columns by semantic role
  const sumCols  = numCols.filter(c => !isIdLike(c) && matches(c, ['salary','revenue','sales','amount','total','profit','income','cost','price','value','gross','net','spend','budget','fee','wage']));
  const avgCols  = numCols.filter(c => !isIdLike(c) && matches(c, ['rate','margin','ratio','pct','percent','avg','average','score','rating','index','bonus','%']));
  const cleanNum = numCols.filter(c => !isIdLike(c));

  const num1 = sumCols[0] || cleanNum[0] || null;
  const num2 = avgCols[0] || sumCols[1]  || cleanNum.find(c => c !== num1) || null;
  const num3 = cleanNum.find(c => c !== num1 && c !== num2) || null;

  const date1      = dateCols[0] || null;
  const measure    = num1 || 'employee count';
  const totalCats  = catCols.length + hiCatCols.length;   // all usable categorical columns

  /* ── Applicability gate ──────────────────────────────
     Return null when the selected chart type cannot be
     meaningfully built from the loaded dataset.
     Caller converts null → "This chart type doesn't
     support the given dataset".
  ───────────────────────────────────────────────────── */
  const _notApplicable =
    // Scatter / Bubble require ≥2 distinct numeric columns (X vs Y axes)
    ( ['scatter chart', 'bubble chart with variable size bubbles'].includes(chartType)
        && cleanNum.length < 2 ) ||
    // Filled Map / Map bubble require a recognisable geographic column
    ( ['filled map choropleth', 'map visual with data bubbles'].includes(chartType)
        && !geoCol ) ||
    // Stacked variants require ≥2 categorical columns (axis + legend/stack dimension)
    ( ['stacked column chart', '100% stacked column chart',
       'stacked bar chart',    '100% stacked bar chart',
       'stacked area chart'].includes(chartType)
        && totalCats < 2 ) ||
    // Matrix requires ≥2 categorical columns (row dimension × column dimension)
    ( chartType === 'matrix table with row and column groupings'
        && totalCats < 2 ) ||
    // Gauge requires at least one numeric column to show a value
    ( chartType === 'gauge chart'
        && cleanNum.length < 1 ) ||
    // Combo charts require ≥1 categorical AND ≥1 numeric column
    ( ['line and clustered column combo chart', 'line and stacked column combo chart'].includes(chartType)
        && (totalCats < 1 || cleanNum.length < 1) ) ||
    // Box & Whisker requires at least 1 numeric column
    ( chartType === 'box and whisker plot' && cleanNum.length < 1 ) ||
    // Marimekko requires ≥2 categorical columns
    ( chartType === 'marimekko chart' && totalCats < 2 );

  if (_notApplicable) return null;

  /* ── Per-chart-type prompt templates ───────────────── */
  switch (chartType) {

    /* ─ Quick Add ─ */
    case 'bar chart':
      if (catCol1 && num1 && num2) return `Create a bar chart showing ${num1} and ${num2} by ${catCol1}`;
      if (catCol1 && num1)         return `Create a bar chart showing ${measure} by ${catCol1}`;
      if (catCol1)                 return `Create a bar chart showing employee count by ${catCol1}`;
      return `Create a bar chart`;

    case 'horizontal bar chart':
      if (catCol1 && num1) return `Create a horizontal bar chart showing ${measure} by ${catCol1}`;
      if (catCol1)         return `Create a horizontal bar chart showing employee count by ${catCol1}`;
      return `Create a horizontal bar chart`;

    /* ─ Column charts ─ */
    case 'clustered column chart':
      if (catCol1 && num1)  return `Create a clustered column chart showing ${measure} by ${catCol1}${catCol2 ? `, using ${catCol2} in the legend` : ''}`;
      if (catCol1)          return `Create a clustered column chart showing employee count by ${catCol1}`;
      return `Create a clustered column chart`;

    case 'stacked column chart':
      if (catCol1 && catCol2) return `Create a stacked column chart showing ${measure} by ${catCol1}, stacked by ${catCol2}`;
      if (catCol1)            return `Create a stacked column chart showing ${measure} by ${catCol1}`;
      return `Create a stacked column chart`;

    case '100% stacked column chart':
      if (catCol1 && catCol2) return `Create a 100% stacked column chart showing employee count by ${catCol1}, using ${catCol2} in the legend`;
      if (catCol1)            return `Create a 100% stacked column chart showing ${measure} by ${catCol1}`;
      return `Create a 100% stacked column chart`;

    /* ─ Bar charts ─ */
    case 'clustered bar chart':
      if (catCol1 && num1)  return `Create a clustered bar chart showing ${measure} by ${catCol1}${catCol2 ? `, using ${catCol2} in the legend` : ''}`;
      if (catCol1)          return `Create a clustered bar chart showing employee count by ${catCol1}`;
      return `Create a clustered bar chart`;

    case 'stacked bar chart':
      if (catCol1 && catCol2) return `Create a stacked bar chart showing ${measure} by ${catCol1}, stacked by ${catCol2}`;
      if (catCol1)            return `Create a stacked bar chart showing ${measure} by ${catCol1}`;
      return `Create a stacked bar chart`;

    case '100% stacked bar chart':
      if (catCol1 && catCol2) return `Create a 100% stacked bar chart showing employee count by ${catCol1}, using ${catCol2} in the legend`;
      if (catCol1)            return `Create a 100% stacked bar chart showing ${measure} by ${catCol1}`;
      return `Create a 100% stacked bar chart`;

    /* ─ Line & Area ─ */
    case 'line chart':
      if (date1 && num1)   return `Create a line chart showing ${measure} trend over ${date1}`;
      if (catCol1 && num1) return `Create a line chart showing ${measure} by ${catCol1}`;
      return `Create a line chart`;

    case 'area chart':
      if (date1 && num1)   return `Create an area chart showing ${measure} trend over ${date1}`;
      if (catCol1 && num1) return `Create an area chart showing ${measure} by ${catCol1}`;
      return `Create an area chart`;

    case 'stacked area chart':
      if (catCol1 && catCol2) return `Create a stacked area chart showing employee count by ${catCol1}, split by ${catCol2}`;
      if (date1 && num1 && catCol1) return `Create a stacked area chart showing ${measure} over ${date1}, split by ${catCol1}`;
      if (catCol1 && num1) return `Create a stacked area chart showing ${measure} by ${catCol1}`;
      return `Create a stacked area chart`;

    /* ─ Combo ─ */
    case 'line and clustered column combo chart':
      if (catCol1 && num1 && num2) return `Create a combo chart showing ${num1} and ${num2} by ${catCol1}`;
      if (catCol1 && num1)         return `Create a combo chart showing ${num1} by ${catCol1}`;
      return `Create a line and clustered column combo chart`;

    case 'line and stacked column combo chart':
      if (catCol1 && catCol2 && num1 && num2)
        return `Create a line and stacked column chart showing ${num1} stacked by ${catCol2}, with a line for ${num2}, by ${catCol1}`;
      if (catCol1 && num1 && num2)
        return `Create a line and stacked column chart showing ${num1} and ${num2} by ${catCol1}`;
      if (catCol1 && num1)
        return `Create a line and stacked column chart showing ${num1} by ${catCol1}`;
      return `Create a line and stacked column combo chart`;

    /* ─ Other charts ─ */
    case 'waterfall chart':
      if (catCol1 && num1) return `Create a waterfall chart showing the change in ${measure} across different ${catCol1}`;
      return `Create a waterfall chart`;

    case 'funnel chart':
      if (catCol1 && num1) return `Create a funnel chart showing ${measure} by ${catCol1}`;
      if (catCol1)         return `Create a funnel chart showing count of records by ${catCol1}`;
      return `Create a funnel chart`;

    case 'scatter chart':
      if (num1 && num2) return `Create a scatter chart of ${num1} vs ${num2}${catCol1 ? `, colored by ${catCol1}` : ''}`;
      if (num1)         return `Create a scatter chart showing ${num1}`;
      return `Create a scatter chart`;

    case 'bubble chart with variable size bubbles':
      if (num1 && num2 && num3) return `Create a bubble chart of ${num1} vs ${num2} with bubble size showing ${num3}${catCol1 ? `, colored by ${catCol1}` : ''}`;
      if (num1 && num2)         return `Create a bubble chart of ${num1} vs ${num2}${catCol1 ? `, colored by ${catCol1}` : ''}`;
      return `Create a bubble chart with variable size bubbles`;

    case 'pie chart':
      if (catCol1 && num1) return `Create a pie chart showing ${measure} by ${catCol1}`;
      if (catCol1)         return `Create a pie chart showing distribution by ${catCol1}`;
      return `Create a pie chart`;

    case 'donut chart':
      if (catCol1 && num1) return `Create a donut chart showing ${measure} share by ${catCol1}`;
      if (catCol1)         return `Create a donut chart showing distribution by ${catCol1}`;
      return `Create a donut chart`;

    case 'treemap chart':
      if (catCol1 && num1) return `Create a treemap showing ${measure} by ${catCol1}${catCol2 ? ` and ${catCol2}` : ''}`;
      if (catCol1)         return `Create a treemap showing count of records by ${catCol1}`;
      return `Create a treemap chart`;

    case 'heatmap chart':
      if (catCol1 && catCol2) return `Create a heatmap of ${catCol1} vs ${catCol2}${num1 ? ` showing ${measure}` : ''}`;
      if (catCol1 && date1)   return `Create a heatmap of ${catCol1} vs ${date1}`;
      if (catCol1)             return `Create a heatmap chart for ${catCol1}`;
      return `Create a heatmap chart`;

    case 'sunburst chart':
      if (catCol1 && catCol2 && num1) return `Create a sunburst of ${catCol1} and ${catCol2} weighted by ${num1}`;
      if (catCol1 && catCol2)         return `Create a sunburst chart of ${catCol1} and ${catCol2}`;
      if (catCol1 && num1)            return `Create a sunburst chart of ${catCol1} showing ${measure}`;
      if (catCol1)                    return `Create a sunburst chart by ${catCol1}`;
      return `Create a sunburst chart`;

    case 'hierarchy tree chart':
      if (catCol1 && catCol2 && num1) return `Create a hierarchy tree showing ${measure} by ${catCol1} and ${catCol2}`;
      if (catCol1 && catCol2)         return `Create a hierarchy tree of ${catCol1} and ${catCol2}`;
      if (catCol1 && num1)            return `Create a hierarchy tree for ${catCol1} showing ${measure}`;
      if (catCol1)                    return `Create a hierarchy tree chart for ${catCol1}`;
      return `Create a hierarchy tree chart`;

    /* ─ Maps ─ */
    case 'map visual with data bubbles':
      if (geoCol && num1) return `Create a map visual showing ${measure} by ${geoCol}`;
      if (geoCol)         return `Create a map visual with data bubbles by ${geoCol}`;
      return `Create a map visual with data bubbles`;

    case 'filled map choropleth':
      if (geoCol && num1) return `Create a filled map showing ${measure} by ${geoCol}`;
      if (geoCol)         return `Create a filled map choropleth by ${geoCol}`;
      return `Create a filled map choropleth`;

    /* ─ Gauge ─ */
    case 'gauge chart':
      if (num1) return `Create a gauge chart for total ${num1}`;
      return `Create a gauge chart`;

    /* ─ Cards & Tables ─ */
    case 'multi-row card visual': {
      const mrNums = cleanNum.slice(0, 3);
      if (mrNums.length >= 2 && catCol1) return `Create a multi-row card showing ${mrNums.join(', ')} by ${catCol1}`;
      if (mrNums.length >= 2)            return `Create a multi-row card showing ${mrNums.join(', ')}`;
      if (mrNums.length === 1 && catCol1)return `Create a multi-row card showing ${mrNums[0]} by ${catCol1}`;
      return `Create a multi-row card visual`;
    }

    case 'KPI visual with trend indicator': {
      const kpiNums = cleanNum.slice(0, 4);
      if (kpiNums.length >= 3)
        return `Create KPI cards for total ${kpiNums[0]}, average ${kpiNums[1]}, total ${kpiNums[2]}`;
      if (kpiNums.length === 2)
        return `Create KPI cards for total ${kpiNums[0]}, average ${kpiNums[1]}`;
      if (kpiNums.length === 1)
        return `Create a KPI card for total ${kpiNums[0]}`;
      if (catCol1)
        return `Create a KPI card for count of ${catCol1}`;
      return `Create KPI visual with trend indicator`;
    }

    case 'data table': {
      const tCols = [...catCols.slice(0, 2), ...cleanNum.slice(0, 3)].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
      if (tCols.length >= 2) return `Create a data table showing ${tCols.join(', ')}`;
      if (cols.length >= 2)  return `Create a data table showing ${cols.slice(0, 5).join(', ')}`;
      return `Create a data table`;
    }

    case 'matrix table with row and column groupings':
      if (catCol1 && catCol2 && num1) return `Create a matrix table with ${catCol1} as rows and ${catCol2} as columns, showing total ${num1}`;
      if (catCol1 && catCol2)         return `Create a matrix table with ${catCol1} as rows and ${catCol2} as columns`;
      if (catCol1 && num1)            return `Create a matrix table with ${catCol1} as rows, showing ${num1}`;
      return `Create a matrix table with row and column groupings`;

    /* ─ Special Charts ─ */
    case 'sankey chart': {
      // Sankey needs two DIFFERENT string columns (source → destination).
      // Use ALL non-ID string cols — not just low-cardinality — so high-cardinality
      // flows (e.g. Region → Product, Channel → Category) are picked up too.
      const flowCols = strCols.filter(c => !isIdLike(c));
      const flowSrc  = flowCols[0] || null;
      const flowDst  = flowCols.find(c => c !== flowSrc) || null;
      if (!flowSrc || !flowDst) {
        // Can't build a meaningful Sankey without 2 distinct string columns
        toast('Sankey chart needs at least 2 categorical columns in your dataset.', 'info');
        return null;
      }
      if (flowSrc && flowDst && num1)
        return `Create a sankey chart showing flow from ${flowSrc} to ${flowDst} weighted by ${num1}`;
      return `Create a sankey chart showing flow from ${flowSrc} to ${flowDst}`;
    }

    case 'gantt chart': {
      // Gantt needs a task/activity column + start and end dates
      const taskCol = cols.find(c => /\b(task|activity|project|phase|stage|milestone|title|item|name)\b/i.test(c))
        || catCols[0] || null;
      const startCol = dateCols.find(c => /\b(start|begin|from|open|creat)\b/i.test(c))
        || dateCols[0] || null;
      const endCol   = dateCols.find(c => /\b(end|finish|to|due|close|complet|deadline)\b/i.test(c))
        || dateCols[1] || null;
      if (taskCol && startCol && endCol)
        return `Create a gantt chart showing ${taskCol} from ${startCol} to ${endCol}`;
      if (taskCol && startCol)
        return `Create a gantt chart showing ${taskCol} over ${startCol}`;
      if (taskCol && catCol2)
        return `Create a gantt chart showing ${taskCol} by ${catCol2}`;
      if (taskCol)
        return `Create a gantt chart for ${taskCol}`;
      return `Create a gantt chart`;
    }

    case 'bullet chart': {
      // Bullet chart: actual value vs. target/goal, grouped by a category
      const actualCol = cleanNum.find(c => /\b(actual|achieved|current|real|ytd|sales|revenue|result)\b/i.test(c))
        || num1 || null;
      const targetCol = cleanNum.find(c => /\b(target|goal|quota|budget|plan|benchmark|forecast|expect)\b/i.test(c))
        || (actualCol && cleanNum.find(c => c !== actualCol)) || num2 || null;
      if (catCol1 && actualCol && targetCol)
        return `Create a bullet chart showing actual ${actualCol} vs target ${targetCol} by ${catCol1}`;
      if (catCol1 && actualCol)
        return `Create a bullet chart showing ${actualCol} by ${catCol1}`;
      if (actualCol && targetCol)
        return `Create a bullet chart showing ${actualCol} vs target ${targetCol}`;
      if (actualCol)
        return `Create a bullet chart for ${actualCol}`;
      return `Create a bullet chart`;
    }

    case 'box and whisker plot': {
      if (cleanNum.length < 1) return null;
      if (catCol1 && num1) return `Create a box and whisker plot showing the distribution of ${num1} by ${catCol1}`;
      if (num1 && num2)    return `Create a box and whisker plot comparing the distribution of ${num1} and ${num2}`;
      if (num1)            return `Create a box and whisker plot showing the statistical distribution of ${num1}`;
      return `Create a box and whisker plot`;
    }

    case 'marimekko chart': {
      if (totalCats < 2) return null;
      if (catCol1 && catCol2 && num1)
        return `Create a Marimekko chart showing ${num1} by ${catCol1} (column widths) and ${catCol2} (segments)`;
      if (catCol1 && catCol2)
        return `Create a Marimekko chart showing record count by ${catCol1} (column widths) and ${catCol2} (segments)`;
      return `Create a Marimekko chart`;
    }

    default:
      if (catCol1 && num1) return `Create a ${chartType} showing ${measure} by ${catCol1}`;
      return `Create a ${chartType}`;
  }
}

/* ══ Chart type click handler ════════════════════════════
   If a dataset is loaded: generate a smart prompt from the
   dataset columns and prepend "- " as a bullet prefix.
   If no dataset: fall back to simple type insertion.
════════════════════════════════════════════════════════════ */
function addChartTypeToPrompt(chartType) {
  const ta   = document.getElementById('prompt-input');
  const curr = ta.value.trim();

  let line;
  if (AppState.columns && AppState.columns.length > 0) {
    // Dataset loaded — generate a smart, column-aware prompt
    const smart = _buildSmartChartPrompt(chartType);
    // null means incompatible with this dataset — toast already shown, just bail
    if (smart === null) return;
    line = `- ${smart}`;
  } else {
    // No dataset yet — generic insertion
    line = `- Add a ${chartType}`;
  }

  // Append on a new line if textarea already has content, otherwise set directly
  ta.value = curr.length === 0 ? line : curr + '\n' + line;

  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = ta.scrollHeight;
}

/* ══ Select All Charts ═══════════════════════════════════
   Generates smart prompts for every chart type in the
   Charts tab and loads them all into the prompt panel.
════════════════════════════════════════════════════════════ */
function addAllChartsToPrompt() {
  const allTypes = [
    'bar chart',
    'horizontal bar chart',
    'clustered column chart',
    'stacked column chart',
    '100% stacked column chart',
    'clustered bar chart',
    'stacked bar chart',
    '100% stacked bar chart',
    'line chart',
    'area chart',
    'stacked area chart',
    'line and clustered column combo chart',
    'line and stacked column combo chart',
    'waterfall chart',
    'funnel chart',
    'scatter chart',
    'bubble chart with variable size bubbles',
    'pie chart',
    'donut chart',
    'treemap chart',
    'heatmap chart',
    'sunburst chart',
    'hierarchy tree chart',
    'map visual with data bubbles',
    'filled map choropleth',
    'gauge chart',
    'multi-row card visual',
    'KPI visual with trend indicator',
    'data table',
    'matrix table with row and column groupings',
    // Special charts
    'sankey chart',
    'gantt chart',
    'bullet chart',
    'box and whisker plot',
    'marimekko chart'
  ];

  const ta = document.getElementById('prompt-input');
  const lines = [];

  for (const type of allTypes) {
    let prompt;
    if (AppState.columns && AppState.columns.length > 0) {
      const smart = _buildSmartChartPrompt(type);
      prompt = smart !== null ? `- ${smart}` : null;
    } else {
      prompt = `- Add a ${type}`;
    }
    // Skip chart types that returned null (not applicable to dataset)
    if (prompt !== null) lines.push(prompt);
  }

  ta.value = lines.join('\n');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = ta.scrollHeight;
  toast(`Added ${lines.length} chart prompts to the panel`, 'info');
}

/* ══ Add Filters button ══════════════════════════════════
   Scans the loaded dataset and identifies good filter
   candidates (categorical columns with 2–25 distinct values,
   date columns). Appends a filter prompt to the prompt panel.
════════════════════════════════════════════════════════════ */
function addFiltersToPrompt() {
  const cols  = AppState.columns  || [];
  const types = AppState.colTypes || {};
  const data  = AppState.rawData  || [];

  if (!cols.length || !data.length) {
    toast('Upload a dataset first.', 'error');
    return;
  }

  const MAX_DISTINCT_CAT = 25;
  const MIN_DISTINCT_CAT = 2;
  const filterCols = [];

  for (const col of cols) {
    const t = types[col];
    if (t === 'date') {
      filterCols.push(col);
      continue;
    }
    if (t === 'number') continue;
    // string / unknown — check cardinality
    const distinct = new Set(data.map(r => r[col]).filter(v => v != null && v !== '')).size;
    if (distinct >= MIN_DISTINCT_CAT && distinct <= MAX_DISTINCT_CAT) {
      filterCols.push(col);
    }
  }

  if (!filterCols.length) {
    toast('No suitable filter columns found in this dataset.', 'info');
    return;
  }

  const ta   = document.getElementById('prompt-input');
  const curr = ta.value.trim();
  const line = `Add filters for ${filterCols.join(', ')}`;

  ta.value = curr.length === 0 ? line : curr + '\n' + line;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = ta.scrollHeight;
  toast(`Added filter prompt for ${filterCols.length} column(s)`, 'info');
}

/* ══ AI badge ═════════════════════════════════════════════ */

function refreshAiBadge() {
  const badge = document.getElementById('ai-conn-badge');
  const label = document.getElementById('ai-mode-label');

  if (AppState.mode === 'free') {
    if (badge) { badge.textContent = '⚡ Free Mode'; badge.style.color = '#4ade80'; }
    if (label) { label.textContent = '⚡ Free Mode — no API key needed'; label.style.opacity = '1'; }
    return;
  }

  if (AppState.mode === 'powerbi') {
    const serverUrl = localStorage.getItem('mcp_server_url') || 'http://localhost:3001';
    if (badge) { badge.textContent = '⚡ Power BI Mode'; badge.style.color = '#f59e0b'; }
    if (label) { label.textContent = `Power BI Mode · MCP server: ${serverUrl}`; label.style.opacity = '1'; }
    return;
  }

  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  if (key) {
    const model = localStorage.getItem('claude_model') || 'claude-sonnet-4-6';
    const shortModel = model.replace('claude-', '').replace(/-\d{8}$/, '');
    if (badge) { badge.textContent = `● AI: ${shortModel}`; badge.style.color = '#4caf50'; }
    if (label) { label.textContent = `Claude AI · ${shortModel}`; label.style.opacity = '1'; }
  } else {
    if (badge) { badge.textContent = '○ No API key'; badge.style.color = '#7a8099'; }
    if (label) { label.textContent = 'No API key — enter one in Settings'; label.style.opacity = '.6'; }
  }
}

/* ══ Dataset pill ════════════════════════════════════════ */

function updateDatasetPill(name) {
  const pill = document.getElementById('dataset-pill');
  if (name) {
    pill.textContent = name;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

/* ══ Log entries ════════════════════════════════════════ */

function addLogEntry(role, text) {
  const log = document.getElementById('history-log');
  const el = document.createElement('div');
  el.className = `log-entry ${role}`;
  const label = role === 'user' ? '👤 You' : '🤖 Claude';
  const preview = text.length > 300 ? text.slice(0, 300) + '…' : text;
  el.innerHTML = `<div class="log-role">${label}</div><div>${preview}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

/* ══ Active filter chips ████████████████████████████████ */

function updateFilterStrip() {
  const chips = document.getElementById('active-chips');
  const rowCount = document.getElementById('row-count');
  const active = Object.entries(AppState.filters).filter(([, v]) => v && v !== 'all');

  chips.innerHTML = active.map(([col, val]) =>
    `<span class="ach">${col}: <strong>${val}</strong>
      <span style="cursor:pointer;margin-left:4px;opacity:.6" onclick="clearFilter('${col}')">✕</span>
    </span>`
  ).join('');

  const total = AppState.rawData?.length || 0;
  const filtered = getFilteredData().length;
  rowCount.textContent = active.length ? `${filtered.toLocaleString()} / ${total.toLocaleString()} rows` : '';
}

function clearFilter(col) {
  delete AppState.filters[col];
  updateFilterStrip();
  renderSlicers(AppState.currentSpec);
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

/* ══ Modal helpers ════════════════════════════════════════ */

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
