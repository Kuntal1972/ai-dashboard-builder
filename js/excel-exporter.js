/**
 * excel-exporter.js â€” Export the full dashboard as a self-contained interactive HTML report.
 *
 * Key design choices:
 *  â€¢ Plotly.js is fetched from the local server and embedded inline â†’ works offline / behind firewalls
 *  â€¢ Initial traces are captured from the already-rendered DOM elements â†’ guaranteed first render
 *  â€¢ Filter sidebar re-aggregates from embedded raw data â†’ live filter updates
 *  â€¢ No ES2020+ syntax (no ??, no optional chaining) in the embedded engine â†’ max browser compat
 */

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ENTRY POINT
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function downloadDashboardAsExcel() {
  const spec = AppState.currentSpec;
  if (!spec) { _showExcelModal('Build the Dashboard first then click'); return; }

  const btn      = document.getElementById('btn-download-pbix');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'â³ Building Reportâ€¦'; }

  try {
    /* â”€â”€ Fetch Plotly.js from local server and embed it inline â”€â”€ */
    let plotlyInline = '';
    try {
      const resp = await fetch('/js/plotly-2.27.0.min.js');
      if (resp.ok) {
        const src = await resp.text();
        /* Replace any </script> inside the JS so it doesn't close our <script> tag */
        plotlyInline = src.replace(/<\/script>/gi, '<\\/script>');
      }
    } catch (_) { /* will fall back to CDN */ }

    /* â”€â”€ Raw data (cap at 100 k rows) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    const RAW_CAP  = 100_000;
    const rawData  = (AppState.rawData || []).slice(0, RAW_CAP);
    const colTypes = AppState.colTypes  || {};

    /* Column-name normaliser — same logic as dashboard.js fixCol().
       AI spec may use wrong case (e.g. 'month' vs 'Month');
       without this aggData finds no rows and every chart is blank. */
    const _cols   = AppState.columns || [];
    const _colSet = new Set(_cols);
    const _fixCol = n => {
      if (!n || _colSet.has(n)) return n;
      const h = _cols.find(c => c.toLowerCase() === String(n).toLowerCase());
      return h || n;
    };
    const _fixChart = c => ({
      ...c,
      x_column:      _fixCol(c.x_column),
      y_column:      _fixCol(c.y_column),
      y2_column:     _fixCol(c.y2_column),
      color_column:  _fixCol(c.color_column),
      size_column:   _fixCol(c.size_column),
      end_column:    _fixCol(c.end_column),
      target_column: _fixCol(c.target_column),
      value_column:  _fixCol(c.value_column),
      z_column:      _fixCol(c.z_column),
      columns:   Array.isArray(c.columns)   ? c.columns.map(_fixCol)   : c.columns,
      y_columns: Array.isArray(c.y_columns) ? c.y_columns.map(_fixCol) : c.y_columns,
      metrics:   Array.isArray(c.metrics)   ? c.metrics.map(m => ({ ...m, column: _fixCol(m.column) })) : c.metrics,
    });
    const _fixKpi = k => ({
      ...k,
      column:       _fixCol(k.column),
      value_column: _fixCol(k.value_column),
      comparison: k.comparison ? { ...k.comparison, column: _fixCol(k.comparison.column) } : k.comparison,
      secondary:  k.secondary  ? { ...k.secondary,  column: _fixCol(k.secondary.column)  } : k.secondary,
    });
    const fixedSpec = {
      ...spec,
      kpi_cards: (spec.kpi_cards || []).map(_fixKpi),
      charts:    (spec.charts    || []).map(_fixChart),
    };

    /* â”€â”€ Visible charts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    const visCharts = fixedSpec.charts.filter(c => c.type !== 'slicer');

    /* â”€â”€ Capture initial Plotly traces from already-rendered DOM */
    const initTraces = {};
    visCharts.forEach((chart, i) => {
      const el = document.getElementById(chart.id);
      if (el && el.data) {
        try { initTraces[`ch${i}`] = JSON.parse(JSON.stringify(el.data)); } catch (_) {}
      }
    });

    /* â”€â”€ Filter column definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    const seenCols  = new Set();
    const filterDefs = [];

    /* Use fixedSpec for slicers so slicer columns are case-normalised */
    fixedSpec.charts.filter(c => c.type === 'slicer' && c.x_column).forEach(c => {
      if (seenCols.has(c.x_column)) return;
      seenCols.add(c.x_column);
      const vals = _uniqueVals(rawData, c.x_column);
      filterDefs.push({ col: c.x_column, uiType: 'slicer', values: vals });
    });

    /* Normalise filter column names before building controls */
    (spec.filters || []).forEach(f => {
      const col = _fixCol(f.column);
      if (!col || seenCols.has(col)) return;
      seenCols.add(col);
      if ((colTypes[col] || 'string') === 'date') {
        filterDefs.push({ col, uiType: 'date' });
      } else {
        filterDefs.push({ col, uiType: 'checkbox', values: _uniqueVals(rawData, col) });
      }
    });

    /* â”€â”€ Build HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    const html = _buildHtml({
      spec: fixedSpec, rawData, colTypes, filterDefs, visCharts, initTraces, plotlyInline,
      exportTime: new Date().toLocaleString(),
      totalRows:  rawData.length,
    });

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const safe = (spec.title || 'dashboard')
      .replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'dashboard';
    _triggerDownload(blob, `${safe}_${_datestamp()}.html`);

  } catch (err) {
    console.error('[html-exporter]', err);
    _showExcelModal('Export failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   HTML DOCUMENT BUILDER
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function _buildHtml({ spec, rawData, colTypes, filterDefs, visCharts, initTraces, plotlyInline, exportTime, totalRows }) {

  const safeJSON = o => JSON.stringify(o).replace(/<\/script>/gi, '<\\/script>');

  /* Chart card HTML shells */
  const chartCards = visCharts.map((c, i) => {
    const isWide  = c.width === 2;
    const isTable = ['table', 'matrix', 'multi_row_card'].includes(c.type);
    return `
  <div class="chart-card${isWide ? ' wide' : ''}${isTable ? ' table-card' : ''}" id="card-ch${i}">
    <div class="chart-hdr">${_esc(c.title || c.type || ('Chart ' + (i + 1)))}</div>
    <div class="chart-body">
      <div id="ch${i}" class="${isTable ? 'tbl-wrap' : 'plotly-div'}"></div>
    </div>
  </div>`;
  }).join('\n');

  /* KPI card shells — include comparison and secondary sub-values matching the dashboard */
  const kpiCards = (spec.kpi_cards || []).map((k, i) => {
    const hasCmp = k.comparison && k.comparison.column;
    const hasSec = k.secondary && (k.secondary.column || k.secondary.aggregation === 'count');
    return `<div class=”kpi-card” id=”kpi${i}”>` +
      `<div class=”kpi-label”>${_esc(k.title || '')}</div>` +
      `<div class=”kpi-value” id=”kpiv${i}”>—</div>` +
      (hasCmp ? `<div class=”kpi-sub” id=”kpicmp${i}”></div>` : '') +
      (hasSec ? `<div class=”kpi-sub” id=”kpisec${i}”></div>` : '') +
      `</div>`;
  }).join('');

  const plotlyTag = plotlyInline
    ? `<script>${plotlyInline}</script>`
    : `<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${_esc(spec.title || 'Dashboard')} â€” AI Dashboard Builder</title>
${plotlyTag}
<style>${_css()}</style>
</head>
<body>

<header>
  <div class="logo">ðŸ“Š AI <span>Dashboard Builder</span></div>
  <h1>${_esc(spec.title || 'Dashboard')}</h1>
  <div class="meta" id="row-counter">${totalRows.toLocaleString()} rows Â· ${_esc(exportTime)}</div>
</header>

${kpiCards ? `<div class="kpi-row">${kpiCards}</div>` : ''}

<div class="main-layout">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-hdr">
      <span>ðŸ” Filters</span>
      <div style="display:flex;gap:5px">
        <button class="small-btn" onclick="clearAllFilters()">âœ• Clear</button>
        <button class="small-btn" id="btn-collapse" onclick="toggleSidebar()">â—€</button>
      </div>
    </div>
    <div id="filter-controls"></div>
  </aside>
  <div class="charts-area">
    <div class="charts-grid" id="charts-grid">
      ${chartCards}
    </div>
  </div>
</div>

<script>
/* â”€â”€ Embedded data â”€â”€ */
var _RAW        = ${safeJSON(rawData)};
var _SPEC       = ${safeJSON(spec)};
var _CTYPES     = ${safeJSON(colTypes)};
var _FCOLS      = ${safeJSON(filterDefs)};
var _CHARTS     = ${safeJSON(visCharts.map((c, i) => Object.assign({}, c, { divId: 'ch' + i })))};
var _INIT       = ${safeJSON(initTraces)};
</script>

<script>
${_engine()}
</script>

</body>
</html>`;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   EMBEDDED ENGINE  (injected as-is into the HTML <script> tag)
   No ES2020+ syntax â€” must run in any modern browser.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function _engine() { return String.raw`
/* â”€â”€ Filter state â”€â”€ */
var _filters     = {};
var _dateFrom    = null;
var _dateTo      = null;
var _dateCol     = null;
var _sidebarOpen = true;
var _initialized = false;

(function detectDateCol() {
  for (var i = 0; i < _FCOLS.length; i++) {
    if (_FCOLS[i].uiType === 'date') { _dateCol = _FCOLS[i].col; break; }
  }
})();

/* â•â•â•â•â•â•â•â•â•â•â•â• DATA HELPERS â•â•â•â•â•â•â•â•â•â•â•â• */
function _toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  var s = String(v).trim()
    .replace(/[Â£â‚¬$Â¥â‚¹,\s]/g, '')
    .replace(/^\((.+)\)$/, '-$1');
  return Number(s);
}

function _parseDate(v) {
  if (!v) return null;
  var d = new Date(v);
  if (!isNaN(d.getTime())) return d;
  var m = String(v).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    d = new Date(m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function getFilteredData() {
  var df = _dateFrom ? _parseDate(_dateFrom) : null;
  var dt = _dateTo   ? _parseDate(_dateTo + 'T23:59:59') : null;
  return _RAW.filter(function(row) {
    if (_dateCol && (df || dt)) {
      var rd = _parseDate(row[_dateCol]);
      if (rd) {
        if (df && rd < df) return false;
        if (dt && rd > dt) return false;
      }
    }
    var cols = Object.keys(_filters);
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var sel = _filters[col];
      if (!sel || !sel.length) continue;
      var rv = String(row[col] != null ? row[col] : '');
      if (sel.indexOf(rv) === -1) return false;
    }
    return true;
  });
}

/* Simple group-by aggregation. keepOrder=true preserves insertion order (used for line/area) */
function aggData(data, xCol, yCol, aggType, keepOrder) {
  if (!xCol) return [];
  var keys = [], groups = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var k   = String(row[xCol] != null ? row[xCol] : '(blank)');
    if (!groups[k]) { groups[k] = { count: 0, sum: 0, vals: [] }; keys.push(k); }
    var g = groups[k];
    g.count++;
    if (yCol) {
      var n = _toNum(row[yCol]);
      if (!isNaN(n)) { g.sum += n; g.vals.push(n); }
    }
  }
  var result = [];
  for (var j = 0; j < keys.length; j++) {
    var x = keys[j], g = groups[x], y = 0;
    switch (aggType) {
      case 'count': y = g.count; break;
      case 'sum':   y = g.sum;   break;
      case 'avg':
      case 'mean':  y = g.vals.length ? g.sum / g.vals.length : 0; break;
      case 'max':   y = g.vals.length ? Math.max.apply(null, g.vals) : 0; break;
      case 'min':   y = g.vals.length ? Math.min.apply(null, g.vals) : 0; break;
      default:      y = yCol ? g.sum : g.count;
    }
    result.push({ x: x, y: y });
  }
  if (!keepOrder) result.sort(function(a, b) { return b.y - a.y; });
  return result;
}

/* Parse a date value to a JS Date, returns null on failure */
function _parseGanttDate(v) {
  if (!v) return null;
  var d = new Date(v);
  if (!isNaN(d.getTime())) return d;
  var mdy = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) { d = new Date(mdy[3] + '-' + ('0'+mdy[1]).slice(-2) + '-' + ('0'+mdy[2]).slice(-2)); }
  return isNaN(d.getTime()) ? null : d;
}

/* KPI computation */
function computeKpiVal(data, kpi) {
  if (kpi.aggregation === 'count') return data.length;
  if (kpi.aggregation === 'count_distinct') {
    var seen = {};
    for (var i = 0; i < data.length; i++) {
      var v = data[i][kpi.column];
      if (v != null && v !== '') seen[String(v)] = 1;
    }
    return Object.keys(seen).length;
  }
  if (kpi.aggregation === 'top_label') {
    var totals = {};
    for (var i = 0; i < data.length; i++) {
      var lbl = String(data[i][kpi.column] != null ? data[i][kpi.column] : '');
      var val = _toNum(data[i][kpi.value_column || kpi.column]);
      if (lbl) totals[lbl] = (totals[lbl] || 0) + (isNaN(val) ? 1 : val);
    }
    var top = null, topVal = -Infinity;
    Object.keys(totals).forEach(function(k){ if (totals[k] > topVal) { topVal = totals[k]; top = k; } });
    return top || 'â€”';
  }
  var vals = [];
  for (var i = 0; i < data.length; i++) {
    var n = _toNum(data[i][kpi.column]);
    if (!isNaN(n)) vals.push(n);
  }
  if (!vals.length) return 0;
  switch (kpi.aggregation) {
    case 'sum':    return vals.reduce(function(a,b){return a+b;}, 0);
    case 'avg':
    case 'mean':   return vals.reduce(function(a,b){return a+b;}, 0) / vals.length;
    case 'max':    return Math.max.apply(null, vals);
    case 'min':    return Math.min.apply(null, vals);
    case 'median': {
      var sorted = vals.slice().sort(function(a,b){return a-b;});
      var mid = Math.floor(sorted.length/2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
    }
    default:       return vals.reduce(function(a,b){return a+b;}, 0);
  }
}

function fmtKpi(v, kpi) {
  if (typeof v === 'string') return v || 'â€”';
  if (v == null || (typeof v === 'number' && isNaN(v))) return 'â€”';
  var pfx = kpi.format === 'currency' ? (kpi.prefix != null ? kpi.prefix : '$') : (kpi.prefix || '');
  var sfx = kpi.suffix || '';
  if (kpi.format === 'percent' || kpi.format === 'percentage') return pfx + (v * 100).toFixed(1) + '%' + sfx;
  if (kpi.format === 'integer' || kpi.format === 'number')    return pfx + Math.round(v).toLocaleString() + sfx;
  try { return pfx + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + sfx; }
  catch(e) { return pfx + v.toFixed(2) + sfx; }
}

/* â•â•â•â•â•â•â•â•â•â•â•â• CHART TRACES â•â•â•â•â•â•â•â•â•â•â•â• */
var COLORS = ['#7c3aed','#06b6d4','#10b981','#f59e0b',
              '#ef4444','#8b5cf6','#3b82f6','#ec4899',
              '#14b8a6','#f97316','#a3e635','#fb923c'];

function _sortAndLimit(entries, chart) {
  if (chart.sort_by === 'y') {
    entries.sort(function(a, b) {
      return chart.sort_order === 'asc' ? a.y - b.y : b.y - a.y;
    });
  }
  if (chart.top_n) entries = entries.slice(0, chart.top_n);
  return entries;
}

function buildTraces(chart, data) {
  var type = (chart.type || '').toLowerCase();
  /* When no y_column the intent is always count, not sum-of-nothing */
  var agg  = chart.y_column ? (chart.aggregation || 'sum') : 'count';
  var xc   = chart.x_column;
  var yc   = chart.y_column;
  var isHoriz = chart.orientation === 'h' || type === 'horizontal_bar';

  /* Scatter — supports both numeric and categorical x-axis */
  if (type === 'scatter') {
    var xs = [], ys = [];
    for (var i = 0; i < data.length; i++) {
      var xRaw = data[i][xc];
      var xNum = _toNum(xRaw);
      var xVal = !isNaN(xNum) ? xNum : (xRaw != null ? String(xRaw) : null);
      var y    = _toNum(data[i][yc]);
      if (xVal != null && !isNaN(y)) { xs.push(xVal); ys.push(y); }
    }
    return [{ type: 'scatter', mode: 'markers', x: xs, y: ys,
              marker: { color: COLORS[0], opacity: 0.7, size: 8 } }];
  }

  /* Bubble — handles both numeric and categorical x-axis */
  if (type === 'bubble') {
    var bxs = [], bys = [], bss = [], bcs = [];
    var colorCol2 = chart.color_column;
    var catXMap = {};  // for categorical x: map string → numeric position
    var catXList = [];
    for (var i = 0; i < data.length; i++) {
      var bxRaw = data[i][xc];
      var bxNum = _toNum(bxRaw);
      var bxVal = !isNaN(bxNum) ? bxNum : (function(v) {
        var s = String(v != null ? v : '');
        if (catXMap[s] === undefined) { catXMap[s] = catXList.length; catXList.push(s); }
        return catXMap[s];
      })(bxRaw);
      var by = _toNum(data[i][yc]);
      if (isNaN(by)) continue;
      bxs.push(bxVal);
      bys.push(by);
      bss.push(chart.size_column ? (Math.abs(_toNum(data[i][chart.size_column])) || 8) : 10);
      bcs.push(colorCol2 ? String(data[i][colorCol2] != null ? data[i][colorCol2] : '') : COLORS[0]);
    }
    var bMaxS = bss.length ? Math.max.apply(null, bss) : 1;
    var bTrace = { type: 'scatter', mode: 'markers', x: bxs, y: bys,
              marker: { size: bss, opacity: 0.7, sizemode: 'area', sizeref: 2 * bMaxS / (40 * 40) } };
    if (colorCol2) bTrace.marker.color = bcs;
    else bTrace.marker.color = COLORS[0];
    if (catXList.length) {
      bTrace.xaxis = { tickvals: catXList.map(function(_,i){ return i; }), ticktext: catXList };
    }
    return [bTrace];
  }

  /* Histogram */
  if (type === 'histogram') {
    var vals = [];
    for (var i = 0; i < data.length; i++) {
      var n = _toNum(data[i][xc || yc]);
      if (!isNaN(n)) vals.push(n);
    }
    return [{ type: 'histogram', x: vals, marker: { color: COLORS[0] }, nbinsx: 20 }];
  }

  /* Box and Whisker */
  if (type === 'box') {
    if (xc) {
      var boxCats = [], boxSeen = {};
      for (var i = 0; i < data.length; i++) {
        var bk = String(data[i][xc] != null ? data[i][xc] : '');
        if (!boxSeen[bk]) { boxSeen[bk] = true; boxCats.push(bk); }
      }
      return boxCats.map(function(cat, ci) {
        var ys2 = [];
        for (var j = 0; j < data.length; j++) {
          if (String(data[j][xc] != null ? data[j][xc] : '') === cat) {
            var n2 = _toNum(data[j][yc]);
            if (!isNaN(n2)) ys2.push(n2);
          }
        }
        return { type: 'box', name: cat, y: ys2, boxmean: true,
                 marker: { color: COLORS[ci % COLORS.length] } };
      });
    }
    var bys = [];
    for (var i = 0; i < data.length; i++) {
      var bn = _toNum(data[i][yc]);
      if (!isNaN(bn)) bys.push(bn);
    }
    return [{ type: 'box', name: yc || 'Values', y: bys, boxmean: true,
              marker: { color: COLORS[0] } }];
  }

  /* Marimekko */
  if (type === 'marimekko') {
    if (!xc) return [];
    var colorCol2 = chart.color_column;
    var mxOrd = [], mxSeen = {}, mcOrd = [], mcSeen = {}, mgrid = {}, mtotX = {};
    for (var i = 0; i < data.length; i++) {
      var mxv = String(data[i][xc] != null ? data[i][xc] : ''); if (!mxv) continue;
      var mcv = colorCol2 ? String(data[i][colorCol2] != null ? data[i][colorCol2] : '') : 'All';
      var mn  = yc ? _toNum(data[i][yc]) : 1;
      if (!mxSeen[mxv]) { mxSeen[mxv] = true; mxOrd.push(mxv); }
      if (!mcSeen[mcv]) { mcSeen[mcv] = true; mcOrd.push(mcv); }
      if (!mgrid[mxv]) mgrid[mxv] = {};
      var mv = isNaN(mn) ? 1 : mn;
      mgrid[mxv][mcv] = (mgrid[mxv][mcv] || 0) + mv;
      mtotX[mxv] = (mtotX[mxv] || 0) + mv;
    }
    var mgrand = 0;
    for (var k in mtotX) mgrand += mtotX[k];
    if (!mgrand) return [];
    var mxInfo = {}, mcumX = 0;
    mxOrd.forEach(function(mxv) {
      var mshare = (mtotX[mxv] || 0) / mgrand * 100;
      mxInfo[mxv] = { center: mcumX + mshare / 2, width: mshare };
      mcumX += mshare;
    });
    var mStack = {};
    mxOrd.forEach(function(mxv) { mStack[mxv] = 0; });
    return mcOrd.map(function(mcv, mci) {
      var mxs = [], mys = [], mbs = [], mws = [], mts = [];
      mxOrd.forEach(function(mxv) {
        var mxt = mtotX[mxv] || 1;
        var mcell = (mgrid[mxv] && mgrid[mxv][mcv]) || 0;
        var mpct  = mcell / mxt * 100;
        mxs.push(mxInfo[mxv].center);
        mys.push(mpct);
        mbs.push(mStack[mxv]);
        mws.push(Math.max(0.1, mxInfo[mxv].width * 0.97));
        mts.push('<b>' + mxv + '</b><br>' + mcv + ': ' + mpct.toFixed(1) + '%');
        mStack[mxv] += mpct;
      });
      return { type: 'bar', name: mcv, x: mxs, y: mys, base: mbs, width: mws,
               text: mts, hoverinfo: 'text', textposition: 'inside',
               textfont: { size: 9, color: '#fff' },
               marker: { color: COLORS[mci % COLORS.length],
                         line: { color: '#0f0f1a', width: 0.5 } } };
    });
  }

  /* Pie / Donut */
  if (type === 'pie' || type === 'donut') {
    var d = aggData(data, xc, yc, agg);
    d = _sortAndLimit(d, chart);
    return [{ type: 'pie',
              labels: d.map(function(r){ return r.x; }),
              values: d.map(function(r){ return r.y; }),
              hole: type === 'donut' ? 0.45 : 0,
              marker: { colors: COLORS } }];
  }

  /* Treemap — proper Plotly treemap with positive values only */
  if (type === 'treemap') {
    var d = aggData(data, xc, yc, agg);
    d = _sortAndLimit(d, chart);
    d = d.filter(function(r){ return typeof r.y === 'number' && r.y > 0; });
    if (!d.length) return [];
    var tVals = d.map(function(r){ return r.y; });
    var tMin = Math.min.apply(null, tVals), tMax = Math.max.apply(null, tVals);
    return [{ type: 'treemap',
              labels:  d.map(function(r){ return String(r.x); }),
              values:  tVals,
              parents: d.map(function(){ return ''; }),
              textinfo: 'label+value',
              marker: { colors: tVals, colorscale: 'Viridis', cmin: tMin, cmax: tMax, showscale: true } }];
  }

  /* Gauge */
  if (type === 'gauge') {
    var gVal;
    if (agg === 'count' || (!yc && !xc)) {
      gVal = data.length;
    } else if (agg === 'count_distinct') {
      var gSeen = {};
      for (var i = 0; i < data.length; i++) { var gv = data[i][yc || xc]; if (gv != null) gSeen[String(gv)] = 1; }
      gVal = Object.keys(gSeen).length;
    } else {
      var gVals = [];
      for (var i = 0; i < data.length; i++) {
        var gn = _toNum(data[i][yc || xc]);
        if (!isNaN(gn)) gVals.push(gn);
      }
      if (!gVals.length) {
        gVal = 0;
      } else if (agg === 'avg' || agg === 'mean') {
        gVal = gVals.reduce(function(a,b){return a+b;},0) / gVals.length;
      } else if (agg === 'max') {
        gVal = Math.max.apply(null, gVals);
      } else if (agg === 'min') {
        gVal = Math.min.apply(null, gVals);
      } else {
        gVal = gVals.reduce(function(a,b){return a+b;},0);
      }
    }
    return [{ type: 'indicator', mode: 'gauge+number', value: gVal,
              gauge: { bar: { color: COLORS[0] }, bgcolor: 'rgba(0,0,0,0)',
                       bordercolor: '#2e2e50',
                       axis: { tickcolor: '#94a3b8' },
                       steps: [{ range: [0, gVal * 1.5 || 100], color: 'rgba(124,58,237,0.1)' }] } }];
  }

  /* Waterfall */
  if (type === 'waterfall') {
    var d = aggData(data, xc, yc, agg);
    return [{ type: 'waterfall',
              x: d.map(function(r){ return r.x; }),
              y: d.map(function(r){ return r.y; }),
              connector: { line: { color: '#2e2e50' } },
              increasing: { marker: { color: COLORS[2] } },
              decreasing: { marker: { color: COLORS[4] } } }];
  }

  /* Combo — bar/stacked-bar column + line on secondary axis */
  if (type === 'combo') {
    var comboStackMode = chart.stack_mode || '';
    var comboIsStacked = comboStackMode === 'stack' || comboStackMode === 'stacked';
    /* Handle multi-series bar (color_column) or stacked bar with y_columns */
    var comboBarTraces = [];
    if (chart.color_column) {
      var comboCats = [], comboSeen = {};
      for (var ci2 = 0; ci2 < data.length; ci2++) {
        var cv4 = String(data[ci2][chart.color_column] != null ? data[ci2][chart.color_column] : '');
        if (!comboSeen[cv4]) { comboSeen[cv4] = true; comboCats.push(cv4); }
      }
      comboCats.forEach(function(cat, idx) {
        var sub3 = data.filter(function(r){ return String(r[chart.color_column] != null ? r[chart.color_column] : '') === cat; });
        var e3 = aggData(sub3, xc, yc, agg);
        comboBarTraces.push({ type: 'bar', name: cat,
          x: e3.map(function(r){ return r.x; }),
          y: e3.map(function(r){ return r.y; }),
          marker: { color: COLORS[idx % COLORS.length] } });
      });
    } else if (Array.isArray(chart.y_columns) && chart.y_columns.length) {
      chart.y_columns.forEach(function(col, idx) {
        var e3 = aggData(data, xc, col, agg);
        comboBarTraces.push({ type: 'bar', name: col,
          x: e3.map(function(r){ return r.x; }),
          y: e3.map(function(r){ return r.y; }),
          marker: { color: COLORS[idx % COLORS.length] } });
      });
    } else {
      var d1 = _sortAndLimit(aggData(data, xc, yc, agg), chart);
      comboBarTraces.push({ type: 'bar', name: yc || 'Value',
        x: d1.map(function(r){ return r.x; }),
        y: d1.map(function(r){ return r.y; }),
        marker: { color: COLORS[0] } });
    }
    var comboTraces = comboBarTraces;
    if (chart.y2_column) {
      var d2 = aggData(data, xc, chart.y2_column, agg, true);
      comboTraces.push({ type: 'scatter', mode: 'lines+markers', name: chart.y2_column, yaxis: 'y2',
                    x: d2.map(function(r){ return r.x; }),
                    y: d2.map(function(r){ return r.y; }),
                    line: { color: COLORS[comboTraces.length % COLORS.length] } });
    }
    return comboTraces;
  }

  /* Funnel */
  if (type === 'funnel') {
    var d = aggData(data, xc, yc, agg);
    d = _sortAndLimit(d, chart);
    return [{ type: 'funnel',
              y: d.map(function(r){ return r.x; }),
              x: d.map(function(r){ return r.y; }),
              marker: { color: COLORS } }];
  }

  /* Bullet — horizontal bar with optional target marker */
  if (type === 'bullet') {
    var d = aggData(data, xc, yc, agg);
    d = _sortAndLimit(d, chart);
    var bTraces = [{ type: 'bar', orientation: 'h',
              y: d.map(function(r){ return r.x; }),
              x: d.map(function(r){ return r.y; }),
              marker: { color: COLORS[0] } }];
    if (chart.target_column) {
      var tData = aggData(data, xc, chart.target_column, agg);
      var tMap = {};
      tData.forEach(function(r){ tMap[r.x] = r.y; });
      bTraces.push({ type: 'scatter', mode: 'markers', orientation: 'h',
        y: d.map(function(r){ return r.x; }),
        x: d.map(function(r){ return tMap[r.x] || 0; }),
        marker: { color: COLORS[4], size: 10, symbol: 'line-ns', line: { width: 3, color: COLORS[4] } },
        name: 'Target' });
    }
    return bTraces;
  }

  /* Heatmap — x_column = x-axis, y_column = y-axis rows, value_column/z_column = cell values */
  if (type === 'heatmap') {
    var hxc = xc, hyc = chart.y_column;
    var hvc = chart.value_column || chart.z_column || null;
    if (hxc && hyc) {
      var hxSet = {}, hySet = {}, hxVals = [], hyVals = [];
      for (var i = 0; i < data.length; i++) {
        var hx = String(data[i][hxc] != null ? data[i][hxc] : '(blank)');
        var hy = String(data[i][hyc] != null ? data[i][hyc] : '(blank)');
        if (!hxSet[hx]) { hxSet[hx] = true; hxVals.push(hx); }
        if (!hySet[hy]) { hySet[hy] = true; hyVals.push(hy); }
      }
      hxVals = hxVals.slice(0, 40).sort();
      hyVals = hyVals.slice(0, 40).sort();
      if (!hxVals.length || !hyVals.length) return [];
      var hGrid = {};
      for (var i = 0; i < data.length; i++) {
        var hx = String(data[i][hxc] != null ? data[i][hxc] : '(blank)');
        var hy = String(data[i][hyc] != null ? data[i][hyc] : '(blank)');
        var hk = hx + '\x00' + hy;
        if (!hGrid[hk]) hGrid[hk] = { s: 0, n: 0 };
        hGrid[hk].n++;
        if (hvc) { var hn = _toNum(data[i][hvc]); if (!isNaN(hn)) hGrid[hk].s += hn; }
      }
      var hZ = hyVals.map(function(hy) {
        return hxVals.map(function(hx) {
          var cell = hGrid[hx + '\x00' + hy] || { s: 0, n: 0 };
          return hvc ? cell.s : cell.n;
        });
      });
      return [{ type: 'heatmap', x: hxVals, y: hyVals, z: hZ,
                colorscale: 'YlOrRd', showscale: true, hoverongaps: false }];
    }
  }

  /* Sunburst — native Plotly sunburst */
  if (type === 'sunburst') {
    var d = aggData(data, xc, yc, agg);
    d = d.filter(function(r){ return typeof r.y === 'number' && r.y > 0; });
    if (!d.length) {
      var fb2 = aggData(data, xc, null, 'count');
      return fb2.length ? [{ type:'bar', x:fb2.map(function(r){return r.x;}), y:fb2.map(function(r){return r.y;}), marker:{color:COLORS[0]} }] : [];
    }
    /* Two-level: if color_column is set, build parent → child hierarchy */
    var sbParentCol = chart.color_column;
    if (sbParentCol) {
      var sbMap = {}, sbPTot = {};
      data.forEach(function(r) {
        var p = String(r[xc] != null ? r[xc] : '');
        var c = String(r[sbParentCol] != null ? r[sbParentCol] : '');
        if (!p || !c) return;
        var k = p + '\x00' + c;
        var v = yc ? (_toNum(r[yc]) || 0) : 1;
        sbMap[k] = (sbMap[k] || 0) + v;
        sbPTot[p] = (sbPTot[p] || 0) + v;
      });
      var sbIds = [''], sbLabels = [''], sbParents = [''], sbVals = [0];
      Object.keys(sbPTot).forEach(function(p) {
        sbIds.push(p); sbLabels.push(p); sbParents.push(''); sbVals.push(sbPTot[p]);
      });
      Object.keys(sbMap).forEach(function(k) {
        var parts = k.split('\x00');
        sbIds.push(k); sbLabels.push(parts[1]); sbParents.push(parts[0]); sbVals.push(sbMap[k]);
      });
      return [{ type: 'sunburst', ids: sbIds, labels: sbLabels, parents: sbParents, values: sbVals,
                branchvalues: 'total', textinfo: 'label+value+percent parent',
                marker: { colorscale: 'Viridis', showscale: false } }];
    }
    return [{ type: 'sunburst',
              labels:  d.map(function(r){ return String(r.x); }),
              values:  d.map(function(r){ return r.y; }),
              parents: d.map(function(){ return ''; }),
              textinfo: 'label+value' }];
  }

  /* Icicle / hierarchy — native Plotly icicle */
  if (type === 'icicle' || type === 'hierarchy') {
    var d = aggData(data, xc, yc, agg);
    d = d.filter(function(r){ return typeof r.y === 'number' && r.y > 0; });
    if (!d.length) {
      /* Fallback: count bar when no positive values in filtered data */
      var fb = aggData(data, xc, null, 'count');
      return fb.length ? [{ type:'bar', x:fb.map(function(r){return r.x;}), y:fb.map(function(r){return r.y;}), marker:{color:COLORS[0]} }] : [];
    }
    var icParentCol = chart.color_column;
    if (icParentCol) {
      var icMap = {}, icPTot = {};
      data.forEach(function(r) {
        var p = String(r[xc] != null ? r[xc] : '');
        var c = String(r[icParentCol] != null ? r[icParentCol] : '');
        if (!p || !c) return;
        var k = p + '\x00' + c;
        var v = yc ? (_toNum(r[yc]) || 0) : 1;
        icMap[k] = (icMap[k] || 0) + v;
        icPTot[p] = (icPTot[p] || 0) + v;
      });
      var icIds = [''], icLabels = [''], icParents = [''], icVals = [0];
      Object.keys(icPTot).forEach(function(p) {
        icIds.push(p); icLabels.push(p); icParents.push(''); icVals.push(icPTot[p]);
      });
      Object.keys(icMap).forEach(function(k) {
        var parts = k.split('\x00');
        icIds.push(k); icLabels.push(parts[1]); icParents.push(parts[0]); icVals.push(icMap[k]);
      });
      return [{ type: 'icicle', ids: icIds, labels: icLabels, parents: icParents, values: icVals,
                branchvalues: 'total', textinfo: 'label+value+percent parent',
                marker: { colorscale: 'Blues', showscale: false } }];
    }
    return [{ type: 'icicle',
              labels:  d.map(function(r){ return String(r.x); }),
              values:  d.map(function(r){ return r.y; }),
              parents: d.map(function(){ return ''; }),
              textinfo: 'label+value' }];
  }

  /* Sankey — native Plotly sankey (x_column = source, y_column = target) */
  if (type === 'sankey') {
    var skSrc = xc, skTgt = chart.y_column;
    var skVal = chart._value_column || chart.target_column || null;
    if (skSrc && skTgt) {
      var skLinks = {}, skSrcTot = {}, skTgtTot = {};
      data.forEach(function(r) {
        var s = String(r[skSrc] != null ? r[skSrc] : '').trim();
        var t = String(r[skTgt] != null ? r[skTgt] : '').trim();
        if (!s || !t || s === t) return;
        var v = (skVal && r[skVal] != null) ? (_toNum(r[skVal]) || 1) : 1;
        var k = s + '\x00' + t;
        skLinks[k] = (skLinks[k] || 0) + v;
        skSrcTot[s] = (skSrcTot[s] || 0) + v;
        skTgtTot[t] = (skTgtTot[t] || 0) + v;
      });
      /* Top 20 sources and targets by volume */
      var topSrc = Object.keys(skSrcTot).sort(function(a,b){return skSrcTot[b]-skSrcTot[a];}).slice(0,20);
      var topTgt = Object.keys(skTgtTot).sort(function(a,b){return skTgtTot[b]-skTgtTot[a];}).slice(0,20);
      var topSrcSet = {}, topTgtSet = {};
      topSrc.forEach(function(n){ topSrcSet[n]=true; });
      topTgt.forEach(function(n){ topTgtSet[n]=true; });
      var validLinks = [];
      Object.keys(skLinks).forEach(function(k) {
        var parts = k.split('\x00');
        if (topSrcSet[parts[0]] && topTgtSet[parts[1]] && skLinks[k] > 0)
          validLinks.push({ src: parts[0], tgt: parts[1], val: skLinks[k] });
      });
      if (!validLinks.length) {
        /* Filtered data too sparse for sankey — show aggregated bar */
        var fbEntries = aggData(data, skSrc, skVal, 'sum');
        if (!fbEntries.length) fbEntries = aggData(data, skSrc, null, 'count');
        return [{ type: 'bar',
                  x: fbEntries.map(function(r){ return r.x; }),
                  y: fbEntries.map(function(r){ return r.y; }),
                  marker: { color: COLORS[0] } }];
      } else {
        var srcNodes = Object.keys(skSrcTot).sort(function(a,b){return skSrcTot[b]-skSrcTot[a];}).slice(0,20);
        var tgtNodes = Object.keys(skTgtTot).sort(function(a,b){return skTgtTot[b]-skTgtTot[a];}).slice(0,20)
          .filter(function(n){ return srcNodes.indexOf(n) === -1; });
        var nodeList = srcNodes.concat(tgtNodes);
        var nodeIdx = {};
        nodeList.forEach(function(n,i){ nodeIdx[n]=i; });
        var SKPAL = ['#4e9af1','#f0a500','#7bc67e','#e05c5c','#9b59b6','#1abc9c','#e67e22','#3498db','#e74c3c','#2ecc71'];
        var nodeColors = nodeList.map(function(n,i){ return SKPAL[i % SKPAL.length]; });
        return [{ type: 'sankey', orientation: 'h', arrangement: 'snap',
                  node: { pad: 20, thickness: 24, label: nodeList, color: nodeColors,
                          line: { color: 'rgba(255,255,255,0.2)', width: 1 } },
                  link: { source: validLinks.map(function(l){ return nodeIdx[l.src]; }),
                          target: validLinks.map(function(l){ return nodeIdx[l.tgt]; }),
                          value:  validLinks.map(function(l){ return l.val; }) },
                  textfont: { color: '#e2e8f0', size: 11 } }];
      }
    }
  }

  /* Gantt: x=END_ms, base=START_ms matches Plotly date axis (chart-renderer pattern) */
  if (type === 'gantt') {
    var gTaskCol  = xc;
    var gStartCol = chart.y_column;
    var gEndCol   = chart.end_column;
    var gColorCol = chart.color_column;
    if (gTaskCol && gStartCol && gEndCol) {
      var gTasks = {}, gGroupSeen = {};
      data.forEach(function(r) {
        var task  = String(r[gTaskCol]  != null ? r[gTaskCol]  : '').trim();
        var start = _parseGanttDate(r[gStartCol]);
        var end   = _parseGanttDate(r[gEndCol]);
        if (!task || !start || !end || end <= start) return;
        var grp = gColorCol ? String(r[gColorCol] != null ? r[gColorCol] : '') : 'Tasks';
        if (!gTasks[task]) gTasks[task] = { start: start, end: end, grp: grp };
        else {
          if (start < gTasks[task].start) gTasks[task].start = start;
          if (end   > gTasks[task].end)   gTasks[task].end   = end;
        }
        if (!gGroupSeen[grp]) gGroupSeen[grp] = true;
      });
      var gEntries = Object.keys(gTasks)
        .map(function(t){ return { task: t, d: gTasks[t] }; })
        .sort(function(a,b){ return a.d.start - b.d.start; })
        .slice(0, 40);
      if (gEntries.length) {
        var gMap = {};
        gEntries.forEach(function(e) {
          var grp = e.d.grp;
          if (!gMap[grp]) gMap[grp] = { tasks: [], startMs: [], endMs: [] };
          gMap[grp].tasks.push(e.task);
          gMap[grp].startMs.push(e.d.start.getTime());
          gMap[grp].endMs.push(e.d.end.getTime());
        });
        return Object.keys(gMap).map(function(grp, gi) {
          var gm = gMap[grp];
          return { type: 'bar', orientation: 'h', name: grp,
                   y: gm.tasks,
                   x: gm.endMs,
                   base: gm.startMs,
                   marker: { color: COLORS[gi % COLORS.length], opacity: 0.85 } };
        });
      }
    }
    /* Fallback: horizontal bar */
    var gd = aggData(data, gTaskCol || xc, chart.y_column || yc, agg);
    return [{ type: 'bar', orientation: 'h',
              y: gd.map(function(r){ return r.x; }),
              x: gd.map(function(r){ return r.y; }),
              marker: { color: COLORS[0] } }];
  }

  /* ── Bar / Line / Area (covers bar, line, area, horizontal_bar, stacked_bar, stacked_area) ── */
  var isLine = type === 'line' || type === 'area' || type === 'stacked_area';
  var plotType = isLine ? 'scatter' : 'bar';

  /* Effective stack mode â€” support both new (stack_mode) and legacy (type=stacked_*) conventions */
  var stackMode = chart.stack_mode || '';
  if (type === 'stacked_bar' || type === 'stacked_area') stackMode = 'stack';

  /* color_column â†’ multi-series (one trace per category) */
  var colorCol = chart.color_column;

  if (colorCol) {
    /* Collect ordered unique categories */
    var cats = [], catSeen = {};
    for (var ci = 0; ci < data.length; ci++) {
      var cv = String(data[ci][colorCol] != null ? data[ci][colorCol] : '');
      if (!catSeen[cv]) { catSeen[cv] = true; cats.push(cv); }
    }
    return cats.map(function(cat, idx) {
      var sub = data.filter(function(r) {
        return String(r[colorCol] != null ? r[colorCol] : '') === cat;
      });
      var entries;
      if (isLine) {
        entries = aggData(sub, xc, yc, agg, true);
        if (_CTYPES && _CTYPES[xc] === 'date') {
          entries.sort(function(a,b){ return a.x < b.x ? -1 : a.x > b.x ? 1 : 0; });
        }
        entries = _sortAndLimit(entries, chart);
      } else {
        entries = _sortAndLimit(aggData(sub, xc, yc, agg, false), chart);
      }
      var color   = COLORS[idx % COLORS.length];
      var t = { name: cat, marker: { color: color } };

      if (isHoriz) {
        t.type        = 'bar';
        t.orientation = 'h';
        t.y           = entries.map(function(r){ return r.x; });
        t.x           = entries.map(function(r){ return r.y; });
      } else if (isLine) {
        t.type   = 'scatter';
        t.mode   = 'lines+markers';
        t.x      = entries.map(function(r){ return r.x; });
        t.y      = entries.map(function(r){ return r.y; });
        t.line   = { color: color, width: 2 };
        t.marker = { size: 5, color: color };
        if (type === 'area' || type === 'stacked_area') {
          t.fill      = stackMode === 'stack' ? 'tonexty' : (idx === 0 ? 'tozeroy' : 'tonexty');
          t.fillcolor = color + '33';
          if (stackMode === 'stack') t.stackgroup = 'one';
        }
      } else {
        t.type = 'bar';
        t.x    = entries.map(function(r){ return r.x; });
        t.y    = entries.map(function(r){ return r.y; });
      }
      return t;
    });
  }

  /* Legacy y_columns array (stacked_bar / stacked_area with explicit column list) */
  if ((type === 'stacked_bar' || type === 'stacked_area') &&
      Array.isArray(chart.y_columns) && chart.y_columns.length) {
    return chart.y_columns.map(function(col, idx) {
      var entries = aggData(data, xc, col, agg, isLine);
      if (type === 'stacked_area') {
        return { type: 'scatter', mode: 'lines', name: col, stackgroup: 'one', fill: 'tonexty',
                 x: entries.map(function(r){ return r.x; }),
                 y: entries.map(function(r){ return r.y; }),
                 line: { color: COLORS[idx % COLORS.length] },
                 fillcolor: COLORS[idx % COLORS.length] + '33' };
      }
      return { type: 'bar', name: col,
               x: entries.map(function(r){ return r.x; }),
               y: entries.map(function(r){ return r.y; }),
               marker: { color: COLORS[idx % COLORS.length] } };
    });
  }

  /* Single-series */
  var entries;
  if (isLine) {
    entries = aggData(data, xc, yc, agg, true);
    if (_CTYPES && _CTYPES[xc] === 'date') {
      entries.sort(function(a,b){ return a.x < b.x ? -1 : a.x > b.x ? 1 : 0; });
    }
    entries = _sortAndLimit(entries, chart);
  } else {
    entries = _sortAndLimit(aggData(data, xc, yc, agg, false), chart);
  }

  if (isHoriz) {
    var rev = entries.slice().reverse();
    return [{ type: 'bar', orientation: 'h',
              y: rev.map(function(r){ return r.x; }),
              x: rev.map(function(r){ return r.y; }),
              marker: { color: COLORS[0] } }];
  }

  if (isLine) {
    var lt = { type: 'scatter',
               x: entries.map(function(r){ return r.x; }),
               y: entries.map(function(r){ return r.y; }),
               line: { color: COLORS[0], width: 2 },
               marker: { color: COLORS[0], size: 5 } };
    if (type === 'area' || type === 'stacked_area') {
      lt.mode      = 'lines';
      lt.fill      = 'tozeroy';
      lt.fillcolor = COLORS[0] + '33';
    } else {
      lt.mode = 'lines+markers';
    }
    return [lt];
  }

  /* Choropleth map */
  if (type === 'choropleth') {
    var d = aggData(data, xc, yc, agg);
    if (!d.length) return [];
    return [{ type: 'choropleth',
              locations: d.map(function(r){ return r.x; }),
              z:         d.map(function(r){ return r.y; }),
              locationmode: 'country names',
              colorscale: 'Blues',
              colorbar: { title: yc || 'Value', tickfont: { color: '#94a3b8' }, titlefont: { color: '#94a3b8' } },
              marker: { line: { color: '#2e2e50', width: 0.5 } } }];
  }

  /* Scatter geo / bubble map */
  if (type === 'scattergeo') {
    var d = aggData(data, xc, yc, agg);
    if (!d.length) return [];
    var zVals = d.map(function(r){ return r.y; });
    var zMax = Math.max.apply(null, zVals) || 1;
    return [{ type: 'scattergeo',
              locations: d.map(function(r){ return r.x; }),
              locationmode: 'country names',
              mode: 'markers',
              marker: { size:  zVals.map(function(v){ return Math.max(4, Math.sqrt(v / zMax) * 30); }),
                        color: zVals, colorscale: 'Viridis', showscale: true,
                        colorbar: { tickfont: { color: '#94a3b8' } },
                        line: { color: '#2e2e50', width: 0.5 } },
              text: d.map(function(r){ return r.x + ': ' + r.y; }),
              hoverinfo: 'text' }];
  }

  /* Default: vertical bar â€” cycle colours per bar for visual variety */
  return [{ type: 'bar',
            x: entries.map(function(r){ return r.x; }),
            y: entries.map(function(r){ return r.y; }),
            marker: { color: entries.map(function(_, i){ return COLORS[i % COLORS.length]; }) } }];
}

function layoutFor(chart) {
  /* Deep copy base layout so Plotly mutations don't bleed between charts */
  var l = JSON.parse(JSON.stringify({
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor:  'rgba(0,0,0,0)',
    font:  { color: '#e2e8f0', size: 12, family: 'Segoe UI,system-ui,sans-serif' },
    margin: { t: 10, b: 60, l: 90, r: 20 },
    showlegend: true,
    legend: { font: { color: '#94a3b8', size: 11 }, bgcolor: 'rgba(0,0,0,0)' },
    xaxis:  { gridcolor: '#2e2e50', zerolinecolor: '#2e2e50',
              tickfont: { color: '#94a3b8', size: 11 } },
    yaxis:  { gridcolor: '#2e2e50', zerolinecolor: '#2e2e50',
              tickfont: { color: '#94a3b8', size: 11 } },
    hoverlabel: { bgcolor: '#252540', bordercolor: '#7c3aed', font: { color: '#e2e8f0' } },
    colorway: ['#7c3aed','#06b6d4','#10b981','#f59e0b',
               '#ef4444','#8b5cf6','#3b82f6','#ec4899'],
    autosize: true
  }));

  var type      = (chart.type || '').toLowerCase();
  var stackMode = chart.stack_mode || '';
  var isHoriz   = chart.orientation === 'h' || type === 'horizontal_bar';
  if (type === 'stacked_bar' || type === 'stacked_area') stackMode = 'stack';

  /* barmode for bar charts */
  if (type === 'bar' || type === 'stacked_bar' || type === 'horizontal_bar') {
    if (stackMode === 'percent') {
      l.barmode = 'stack';
      l.barnorm = 'percent';
    } else if (stackMode === 'stack') {
      l.barmode = 'stack';
    } else if (chart.color_column) {
      l.barmode = 'group';
    }
  }

  /* horizontal bar â€” widen left margin for category labels */
  if (isHoriz) l.margin.l = 140;

  if (type === 'gauge')   l.margin = { t: 40, b: 20, l: 20, r: 20 };
  if (type === 'funnel')  { l.margin.l = 120; }
  if (type === 'heatmap') { l.margin.b = 80; l.margin.l = 120; }
  if (type === 'bullet' || type === 'gantt') l.margin.l = 140;
  /* Types that have no x/y axes — remove them to avoid Plotly anchor errors */
  if (type === 'sankey' || type === 'sunburst' || type === 'icicle' ||
      type === 'hierarchy' || type === 'treemap') {
    delete l.xaxis; delete l.yaxis;
    l.showlegend = false;
    l.margin = { t: 20, b: 20, l: 20, r: 20 };
  }
  if (type === 'gantt') {
    l.xaxis  = { type: 'date', tickformat: '%b %d %Y', tickangle: -30,
                 gridcolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 10 } };
    l.yaxis  = { autorange: 'reversed', gridcolor: '#2e2e50',
                 tickfont: { color: '#e2e8f0', size: 10 } };
    l.barmode    = 'overlay';
    l.bargap     = 0.35;
    l.showlegend = true;
    l.margin     = { t: 20, b: 80, l: 200, r: 30 };
  }

  if (type === 'combo') {
    var cStackMode = chart.stack_mode || '';
    if (cStackMode === 'stack' || cStackMode === 'stacked' || chart.color_column || (Array.isArray(chart.y_columns) && chart.y_columns.length > 1)) {
      l.barmode = cStackMode === 'stack' || cStackMode === 'stacked' ? 'stack' : 'group';
    }
    if (chart.y2_column) {
      l.yaxis2 = { overlaying: 'y', side: 'right',
                   gridcolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 11 } };
    }
  }
  if (type === 'box') {
    l.boxmode = 'group';
    l.xaxis.tickfont = { color: '#94a3b8', size: 11 };
    delete l.xaxis.tickformat;
    delete l.yaxis.tickformat;
  }
  if (type === 'marimekko') {
    l.barmode = 'overlay';
    l.xaxis = { showgrid: false, tickfont: { color: '#94a3b8', size: 10 }, range: [0, 100] };
    l.yaxis = { gridcolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 11 },
                ticksuffix: '%', range: [0, 105] };
    l.margin = { t: 10, b: 80, l: 60, r: 20 };
  }
  if (type === 'choropleth' || type === 'scattergeo') {
    delete l.xaxis; delete l.yaxis;
    l.showlegend = false;
    l.margin = { t: 10, b: 10, l: 10, r: 10 };
    l.geo = { bgcolor: 'rgba(0,0,0,0)', showland: true, landcolor: '#1e1e3a',
              showocean: true, oceancolor: '#0d0d1a', showcountries: true,
              countrycolor: '#2e2e50', showframe: false,
              coastlinecolor: '#2e2e50', lakecolor: '#0d0d1a',
              projection: { type: 'natural earth' } };
  }
  return l;
}

var PLOTLY_CONFIG = {
  responsive: true, displayModeBar: true, displaylogo: false,
  modeBarButtonsToRemove: ['sendDataToCloud','select2d','lasso2d','autoScale2d'],
  toImageButtonOptions: { format: 'png', width: 1400, height: 700 }
};

/* â•â•â•â•â•â•â•â•â•â•â•â• TABLE CHART â•â•â•â•â•â•â•â•â•â•â•â• */
function buildTableHtml(chart, data) {
  var cols = (Array.isArray(chart.columns) && chart.columns.length)
    ? chart.columns
    : [chart.x_column, chart.y_column, chart.z_column].filter(Boolean);
  if (!cols.length) cols = Object.keys(data[0] || {}).slice(0, 8);
  var rows = data.slice(0, chart.top_n || 500);
  var head = '<tr>' + cols.map(function(c){ return '<th>' + c + '</th>'; }).join('') + '</tr>';
  var body = rows.map(function(r){
    return '<tr>' + cols.map(function(c){
      return '<td>' + (r[c] != null ? r[c] : '') + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table class="data-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
       + '<div class="tbl-footer">Showing ' + rows.length + ' of ' + data.length + ' rows</div>';
}

/* â•â•â•â•â•â•â•â•â•â•â•â• MATRIX (pivot table) â•â•â•â•â•â•â•â•â•â•â•â• */
function buildMatrixHtml(chart, data) {
  var rowCol = chart.x_column;
  var colCol = chart.color_column;
  var valCol = chart.y_column;
  var agg    = chart.aggregation || 'count';

  if (!rowCol || !colCol) return buildTableHtml(chart, data);

  var rowVals = [], colVals = [], rowSeen = {}, colSeen = {};
  for (var i = 0; i < data.length; i++) {
    var rv = String(data[i][rowCol] != null ? data[i][rowCol] : '(blank)');
    var cv = String(data[i][colCol] != null ? data[i][colCol] : '(blank)');
    if (!rowSeen[rv]) { rowSeen[rv] = true; rowVals.push(rv); }
    if (!colSeen[cv]) { colSeen[cv] = true; colVals.push(cv); }
  }
  rowVals.sort(); colVals.sort();

  var dispRows = rowVals.slice(0, 200);
  var dispCols = colVals.slice(0, 30);

  function cellAgg(rows) {
    if (agg === 'count') return rows.length;
    var nums = [];
    for (var j = 0; j < rows.length; j++) {
      var n = _toNum(rows[j][valCol]);
      if (!isNaN(n)) nums.push(n);
    }
    if (!nums.length) return 0;
    if (agg === 'mean') return nums.reduce(function(s,v){return s+v;},0) / nums.length;
    if (agg === 'max')  return Math.max.apply(null, nums);
    if (agg === 'min')  return Math.min.apply(null, nums);
    return nums.reduce(function(s,v){return s+v;},0);
  }

  function fmt(v) {
    if (typeof v !== 'number') return String(v);
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, {maximumFractionDigits:2});
  }

  /* Pre-group by row */
  var byRow = {};
  for (var i = 0; i < data.length; i++) {
    var rv = String(data[i][rowCol] != null ? data[i][rowCol] : '(blank)');
    if (!byRow[rv]) byRow[rv] = [];
    byRow[rv].push(data[i]);
  }

  var thead = '<tr><th class="matrix-row-hdr">' + rowCol + '</th>'
    + dispCols.map(function(cv){ return '<th class="matrix-col-hdr">' + cv + '</th>'; }).join('')
    + '<th class="matrix-total">Total</th></tr>';

  var tbody = dispRows.map(function(rv) {
    var rowData = byRow[rv] || [];
    var cells = dispCols.map(function(cv) {
      var sub = rowData.filter(function(r){ return String(r[colCol] != null ? r[colCol] : '(blank)') === cv; });
      return '<td class="n">' + fmt(cellAgg(sub)) + '</td>';
    }).join('');
    return '<tr><td class="matrix-row-label">' + rv + '</td>' + cells
         + '<td class="matrix-total n">' + fmt(cellAgg(rowData)) + '</td></tr>';
  }).join('');

  var totalRow = '<tr class="matrix-totals-row"><td class="matrix-row-label"><strong>Total</strong></td>'
    + dispCols.map(function(cv) {
        var sub = data.filter(function(r){ return String(r[colCol] != null ? r[colCol] : '(blank)') === cv; });
        return '<td class="n"><strong>' + fmt(cellAgg(sub)) + '</strong></td>';
      }).join('')
    + '<td class="matrix-total n"><strong>' + fmt(cellAgg(data)) + '</strong></td></tr>';

  return '<div class="dt-wrap"><table class="data-tbl matrix-table"><thead>' + thead + '</thead><tbody>'
       + tbody + totalRow + '</tbody></table>'
       + '<div class="tbl-footer">' + dispRows.length + ' rows Ã— ' + dispCols.length + ' cols</div></div>';
}

/* â•â•â•â•â•â•â•â•â•â•â•â• MULTI-ROW CARD â•â•â•â•â•â•â•â•â•â•â•â• */
function buildMultiRowCardHtml(chart, data) {
  var groupCol = chart.x_column;
  var metrics  = (Array.isArray(chart.metrics) && chart.metrics.length) ? chart.metrics : null;

  if (!metrics) {
    var yCol = chart.y_column;
    var agg  = chart.aggregation || 'sum';
    metrics  = [{ label: 'Count', column: null, aggregation: 'count', format: 'number' }];
    if (yCol) {
      metrics.push({ label: 'Total ' + yCol, column: yCol, aggregation: 'sum',  format: 'currency' });
      metrics.push({ label: 'Avg '   + yCol, column: yCol, aggregation: 'mean', format: 'currency' });
    }
  }

  function computeMetric(rows, m) {
    if (m.aggregation === 'count' || !m.column) return rows.length;
    if (m.aggregation === 'count_distinct') {
      var seen = {};
      for (var i = 0; i < rows.length; i++) { var v = rows[i][m.column]; if (v != null && v !== '') seen[v] = 1; }
      return Object.keys(seen).length;
    }
    var nums = [];
    for (var i = 0; i < rows.length; i++) { var n = _toNum(rows[i][m.column]); if (!isNaN(n)) nums.push(n); }
    if (!nums.length) return 0;
    switch (m.aggregation) {
      case 'sum':  return nums.reduce(function(s,v){return s+v;},0);
      case 'mean': return nums.reduce(function(s,v){return s+v;},0) / nums.length;
      case 'max':  return Math.max.apply(null, nums);
      case 'min':  return Math.min.apply(null, nums);
      default:     return nums.reduce(function(s,v){return s+v;},0);
    }
  }

  function fmtMRC(v, fmt) {
    if (v == null) return 'â€”';
    var n = Number(v);
    if (isNaN(n)) return String(v) || 'â€”';
    if (fmt === 'currency')   return '$' + n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
    if (fmt === 'percentage') return (n * 100).toFixed(1) + '%';
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, {maximumFractionDigits:2});
  }

  var groups = groupCol
    ? (function() {
        var seen = {}, gs = [];
        for (var i = 0; i < data.length; i++) {
          var g = data[i][groupCol];
          if (g != null && g !== '' && !seen[g]) { seen[g] = true; gs.push(g); }
        }
        return gs.sort();
      })()
    : ['(All)'];

  var headerCells = '<th class="mrc-th mrc-th-group">' + (groupCol || '') + '</th>'
    + metrics.map(function(m, i){ return '<th class="mrc-th mrc-th-metric" style="border-top:3px solid ' + COLORS[i % COLORS.length] + '">' + m.label + '</th>'; }).join('');

  var bodyRows = groups.map(function(grp, gi) {
    var rows = groupCol ? data.filter(function(r){ return r[groupCol] === grp; }) : data;
    var cells = metrics.map(function(m, i) {
      return '<td class="mrc-td mrc-td-metric">'
           + '<span class="mrc-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>'
           + '<span class="mrc-num">' + fmtMRC(computeMetric(rows, m), m.format) + '</span></td>';
    }).join('');
    return '<tr class="mrc-row' + (gi % 2 === 1 ? ' mrc-alt' : '') + '">'
         + '<td class="mrc-td mrc-td-group">' + grp + '</td>' + cells + '</tr>';
  }).join('');

  var totalCells = metrics.map(function(m, i) {
    return '<td class="mrc-td mrc-td-total">'
         + '<span class="mrc-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>'
         + '<span class="mrc-num">' + fmtMRC(computeMetric(data, m), m.format) + '</span></td>';
  }).join('');

  return '<div class="mrc-wrap"><table class="mrc-table"><thead><tr>' + headerCells + '</tr></thead><tbody>'
       + bodyRows
       + '<tr class="mrc-row mrc-total-row"><td class="mrc-td mrc-td-group mrc-total-label">Total</td>' + totalCells + '</tr>'
       + '</tbody></table></div>';
}

/* â•â•â•â•â•â•â•â•â•â•â•â• RENDER / UPDATE â•â•â•â•â•â•â•â•â•â•â•â• */
function updateAll() {
  var data = getFilteredData();
  updateKpis(data);
  updateCharts(data);
  /* update row counter */
  var rc = document.getElementById('row-counter');
  if (rc) rc.textContent = data.length.toLocaleString() + ' rows shown';
}

function updateKpis(data) {
  var kpis = (_SPEC.kpi_cards || []);
  for (var i = 0; i < kpis.length; i++) {
    var k = kpis[i];
    var el = document.getElementById('kpiv' + i);
    if (!el) continue;
    try { el.textContent = fmtKpi(computeKpiVal(data, k), k); }
    catch(e) { el.textContent = '—'; }

    /* comparison sub-value */
    if (k.comparison && k.comparison.column) {
      var cmpEl = document.getElementById('kpicmp' + i);
      if (cmpEl) {
        try {
          var cv = computeKpiVal(data, k.comparison);
          cmpEl.innerHTML = '&#x21D4; ' + (k.comparison.label || '') + ': <strong>' + fmtKpi(cv, k.comparison) + '</strong>';
        } catch(e) { cmpEl.textContent = ''; }
      }
    }

    /* secondary sub-value */
    if (k.secondary && (k.secondary.column || k.secondary.aggregation === 'count')) {
      var secEl = document.getElementById('kpisec' + i);
      if (secEl) {
        try {
          var sv = computeKpiVal(data, k.secondary);
          secEl.innerHTML = '&#x1F4CA; ' + (k.secondary.label || '') + ': <strong>' + fmtKpi(sv, k.secondary) + '</strong>';
        } catch(e) { secEl.textContent = ''; }
      }
    }
  }
}

function updateCharts(data) {
  if (typeof Plotly === 'undefined') {
    var grid = document.getElementById('charts-grid');
    if (grid && !grid._plotlyErr) {
      grid._plotlyErr = true;
      var banner = document.createElement('div');
      banner.className = 'plotly-error';
      banner.innerHTML = 'âš  Plotly could not be loaded. Open this file in a browser with internet access, or re-download the report while the app is running.';
      grid.insertBefore(banner, grid.firstChild);
    }
    return;
  }

  for (var i = 0; i < _CHARTS.length; i++) {
    var chart = _CHARTS[i];
    var el    = document.getElementById(chart.divId);
    if (!el) continue;

    var type = (chart.type || '').toLowerCase();

    /* â”€â”€ HTML-rendered chart types â”€â”€ */
    if (type === 'table') {
      el.innerHTML = buildTableHtml(chart, data);
      continue;
    }
    if (type === 'matrix') {
      el.innerHTML = buildMatrixHtml(chart, data);
      continue;
    }
    if (type === 'multi_row_card') {
      el.innerHTML = buildMultiRowCardHtml(chart, data);
      continue;
    }

    /* ── Plotly chart types ── */
    try {
      var traces;
      var layout = layoutFor(chart);
      var initT  = _INIT && _INIT[chart.divId];

      /* First load: use captured DOM traces for pixel-perfect initial render.
         On every filter change (_initialized=true): always rebuild from data. */
      if (!_initialized && initT && initT.length) {
        traces = initT;
      } else {
        traces = buildTraces(chart, data);
      }

      /* Self-contained types carry data in node/link/z — don't gate on x/y */
      var SC = { sankey:1, heatmap:1, treemap:1, sunburst:1, icicle:1,
                 funnel:1, waterfall:1, indicator:1, choropleth:1, scattergeo:1, pie:1,
                 box:1 };
      var hasData = traces && traces.length &&
        traces.some(function(t) {
          if (SC[t.type]) return true;
          return (t.x && t.x.length) || (t.y && t.y.length) ||
                 (t.labels && t.labels.length) || (t.values && t.values.length) ||
                 (t.z && t.z.length);
        });
      if (!hasData) {
        try { if (typeof Plotly !== 'undefined') Plotly.purge(el); } catch (_) {}
        el.innerHTML = '<div class="chart-err" style="color:var(--muted);font-size:12px;padding:24px;text-align:center">No data for this filter</div>';
        el._hasPlot = false;
        continue;
      }

      /* Purge stale Plotly state when previous render showed "No data" message
         (innerHTML was replaced externally, leaving orphaned Plotly props on el) */
      if (!el._hasPlot) {
        try { Plotly.purge(el); } catch (_) {}
      }
      /* Always use newPlot — avoids Plotly.react type-mismatch errors and
         ensures a clean re-render on every filter change */
      Plotly.newPlot(el, traces, layout, PLOTLY_CONFIG);
      el._hasPlot = true;

    } catch(e) {
      try { if (typeof Plotly !== 'undefined') Plotly.purge(el); } catch (_) {}
      el.innerHTML = '<div class="chart-err">&#9888; ' + (e.message || 'Chart render error') + '</div>';
      el._hasPlot = false;
      console.warn('[chart]', chart.title, e);
    }
  }
  _initialized = true;
}

/* â•â•â•â•â•â•â•â•â•â•â•â• FILTER SIDEBAR â•â•â•â•â•â•â•â•â•â•â•â• */
function renderFilterSidebar() {
  var container = document.getElementById('filter-controls');
  if (!container) return;
  if (!_FCOLS.length) {
    container.innerHTML = '<div class="no-filters">No filters defined for this dashboard.</div>';
    return;
  }

  var html = '';
  for (var fi = 0; fi < _FCOLS.length; fi++) {
    var f = _FCOLS[fi];
    if (f.uiType === 'date') {
      html += '<div class="filter-section">'
           +  '<div class="filter-title">ðŸ“… ' + f.col + '</div>'
           +  '<div class="date-range">'
           +  '<label>From <input type="date" id="df-from" onchange="onDateChange()"></label>'
           +  '<label>To&nbsp;&nbsp; <input type="date" id="df-to"   onchange="onDateChange()"></label>'
           +  '</div></div>';
      continue;
    }
    if (f.uiType === 'slicer') {
      var btns = '<button class="sbtn active" data-col="' + _ea(f.col) + '" data-val="__all__" onclick="slicerClick(this)">All</button>';
      for (var vi = 0; vi < f.values.length; vi++) {
        btns += '<button class="sbtn" data-col="' + _ea(f.col) + '" data-val="' + _ea(f.values[vi]) + '" onclick="slicerClick(this)">' + _eh(f.values[vi]) + '</button>';
      }
      html += '<div class="filter-section">'
           +  '<div class="filter-title">ðŸ”˜ ' + _eh(f.col) + '</div>'
           +  '<div class="slicer-btns" id="slc-' + _safeId(f.col) + '">' + btns + '</div>'
           +  '</div>';
      continue;
    }
    /* checkbox */
    var safeId = _safeId(f.col);
    var checks = '';
    for (var vi = 0; vi < f.values.length; vi++) {
      checks += '<label class="chk-lbl"><input type="checkbox" data-col="' + _ea(f.col)
             +  '" value="' + _ea(f.values[vi]) + '" checked onchange="checkboxChanged(this)"> '
             +  _eh(f.values[vi]) + '</label>';
    }
    html += '<div class="filter-section">'
         +  '<div class="filter-title" onclick="toggleSection(this)">â–¾ ' + _eh(f.col)
         +  '<span class="sel-count" id="cnt-' + safeId + '">All</span></div>'
         +  '<div class="check-list" id="fc-' + safeId + '">'
         +  '<input type="text" class="search-inp" placeholder="Searchâ€¦" oninput="searchFilter(this,\'fc-' + safeId + '\')">'
         +  checks + '</div></div>';
  }
  container.innerHTML = html;
}

function toggleSection(hdr) {
  var list = hdr.nextElementSibling;
  if (!list) return;
  var open = list.style.display !== 'none';
  list.style.display = open ? 'none' : '';
  hdr.childNodes[0].textContent = open ? 'â–¸ ' : 'â–¾ ';
}

function searchFilter(inp, listId) {
  var q    = inp.value.toLowerCase();
  var list = document.getElementById(listId);
  if (!list) return;
  var labels = list.querySelectorAll('.chk-lbl');
  for (var i = 0; i < labels.length; i++) {
    labels[i].style.display = labels[i].textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
  }
}

function slicerClick(btn) {
  var col = btn.dataset.col;
  var val = btn.dataset.val;
  var ctr = document.getElementById('slc-' + _safeId(col));
  if (!ctr) ctr = btn.parentNode;
  var allBtn = ctr.querySelector('[data-val="__all__"]');

  if (val === '__all__') {
    /* Clear: deactivate all value buttons, activate All */
    var btns = ctr.querySelectorAll('.sbtn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    btn.classList.add('active');
    delete _filters[col];
  } else {
    /* Toggle this value — multi-select */
    var current = Array.isArray(_filters[col]) ? _filters[col].slice() : [];
    var idx = current.indexOf(val);
    if (idx === -1) { current.push(val); } else { current.splice(idx, 1); }
    btn.classList.toggle('active', idx === -1);
    if (current.length === 0) {
      if (allBtn) allBtn.classList.add('active');
      delete _filters[col];
    } else {
      if (allBtn) allBtn.classList.remove('active');
      _filters[col] = current;
    }
  }
  updateAll();
}

function checkboxChanged(cb) {
  var col  = cb.dataset.col;
  var safeId = _safeId(col);
  var list = document.getElementById('fc-' + safeId);
  var all  = list ? list.querySelectorAll('input[type=checkbox]') : [];
  var checked = [];
  for (var i = 0; i < all.length; i++) { if (all[i].checked) checked.push(all[i].value); }
  if (!checked.length || checked.length === all.length) {
    delete _filters[col];
    for (var i = 0; i < all.length; i++) all[i].checked = true;
  } else {
    _filters[col] = checked;
  }
  var cnt = document.getElementById('cnt-' + safeId);
  if (cnt) cnt.textContent = _filters[col] ? (_filters[col].length + ' sel') : 'All';
  updateAll();
}

function onDateChange() {
  var f = document.getElementById('df-from');
  var t = document.getElementById('df-to');
  _dateFrom = f ? f.value || null : null;
  _dateTo   = t ? t.value || null : null;
  updateAll();
}

function clearAllFilters() {
  _filters = {}; _dateFrom = null; _dateTo = null;
  var btns = document.querySelectorAll('.sbtn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].dataset.val === '__all__');
  }
  var cbs = document.querySelectorAll('.check-list input[type=checkbox]');
  for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
  var cnts = document.querySelectorAll('.sel-count');
  for (var i = 0; i < cnts.length; i++) cnts[i].textContent = 'All';
  var df = document.getElementById('df-from'), dt = document.getElementById('df-to');
  if (df) df.value = ''; if (dt) dt.value = '';
  updateAll();
}

function toggleSidebar() {
  _sidebarOpen = !_sidebarOpen;
  var sb  = document.getElementById('sidebar');
  var btn = document.getElementById('btn-collapse');
  sb.classList.toggle('collapsed', !_sidebarOpen);
  if (btn) btn.textContent = _sidebarOpen ? 'â—€' : 'â–¶';
}

/* â”€â”€ tiny HTML-safe helpers â”€â”€ */
function _eh(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _ea(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _safeId(s) { return String(s).replace(/[^a-zA-Z0-9]/g,'_'); }

/* â•â•â•â•â•â•â•â•â•â•â•â• BOOTSTRAP â•â•â•â•â•â•â•â•â•â•â•â• */
document.addEventListener('DOMContentLoaded', function() {
  renderFilterSidebar();
  updateAll();
});
`; }

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CSS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function _css() { return `
  :root{--bg:#0f0f1a;--surf:#16162e;--card:#1a1a2e;--border:#2e2e50;
    --purple:#7c3aed;--purple2:#a78bfa;--cyan:#06b6d4;
    --fg:#e2e8f0;--muted:#94a3b8;}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;}
  body{background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,sans-serif;
       display:flex;flex-direction:column;height:100vh;overflow:hidden;}

  header{display:flex;align-items:center;gap:12px;padding:10px 18px;background:var(--surf);
         border-bottom:2px solid var(--purple);flex-shrink:0;min-height:46px;}
  .logo{font-size:13px;color:var(--muted);white-space:nowrap;}
  .logo span{color:var(--purple2);font-weight:700;}
  header h1{flex:1;font-size:17px;font-weight:700;color:var(--fg);}
  .meta{font-size:10px;color:var(--muted);white-space:nowrap;}

  .kpi-row{display:flex;flex-wrap:wrap;gap:10px;padding:10px 16px;background:var(--surf);
           border-bottom:1px solid var(--border);flex-shrink:0;}
  .kpi-card{flex:1;min-width:110px;background:var(--card);border:1px solid var(--border);
            border-radius:10px;padding:10px 14px;transition:border-color .2s;}
  .kpi-card:hover{border-color:var(--purple);}
  .kpi-label{font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;
             letter-spacing:.06em;margin-bottom:4px;}
  .kpi-value{font-size:20px;font-weight:800;
             background:linear-gradient(135deg,var(--purple2),var(--cyan));
             -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
  .kpi-sub{font-size:10px;color:var(--muted);margin-top:3px;}
  .kpi-sub strong{color:var(--fg);}

  .main-layout{display:flex;flex:1;min-height:0;overflow:hidden;}

  .sidebar{width:230px;min-width:230px;background:var(--surf);border-right:1px solid var(--border);
           display:flex;flex-direction:column;overflow:hidden;transition:width .25s,min-width .25s;flex-shrink:0;}
  .sidebar.collapsed{width:0;min-width:0;border:none;}
  .sidebar-hdr{display:flex;align-items:center;justify-content:space-between;
               padding:9px 11px;font-size:12px;font-weight:700;color:var(--fg);
               border-bottom:1px solid var(--border);background:var(--card);flex-shrink:0;}
  #filter-controls{overflow-y:auto;flex:1;padding:4px 0;}

  .filter-section{border-bottom:1px solid var(--border);padding:8px 10px;}
  .filter-title{font-size:10px;font-weight:700;color:var(--purple2);text-transform:uppercase;
                letter-spacing:.05em;margin-bottom:6px;cursor:pointer;
                display:flex;align-items:center;justify-content:space-between;user-select:none;}
  .sel-count{font-size:9px;color:var(--muted);font-weight:400;text-transform:none;}

  .slicer-btns{display:flex;flex-wrap:wrap;gap:3px;}
  .sbtn{background:var(--card);border:1px solid var(--border);border-radius:14px;
        padding:3px 9px;font-size:11px;color:var(--muted);cursor:pointer;transition:all .15s;}
  .sbtn:hover{border-color:var(--purple);color:var(--fg);}
  .sbtn.active{background:var(--purple);border-color:var(--purple);color:#fff;font-weight:600;}

  .check-list{display:flex;flex-direction:column;gap:1px;max-height:160px;overflow-y:auto;margin-top:3px;}
  .chk-lbl{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--fg);
           padding:2px 4px;border-radius:4px;cursor:pointer;}
  .chk-lbl:hover{background:rgba(124,58,237,.12);}
  .chk-lbl input{accent-color:var(--purple);cursor:pointer;}
  .search-inp{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;
              padding:4px 7px;font-size:11px;color:var(--fg);margin-bottom:4px;outline:none;}
  .search-inp:focus{border-color:var(--purple);}

  .date-range{display:flex;flex-direction:column;gap:4px;}
  .date-range label{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:5px;}
  .date-range input[type=date]{background:var(--bg);border:1px solid var(--border);border-radius:5px;
                                padding:3px 6px;font-size:11px;color:var(--fg);flex:1;outline:none;
                                color-scheme:dark;}
  .date-range input[type=date]:focus{border-color:var(--purple);}

  .small-btn{background:transparent;border:1px solid var(--border);border-radius:5px;
             padding:3px 8px;font-size:11px;color:var(--muted);cursor:pointer;transition:all .15s;}
  .small-btn:hover{border-color:var(--purple);color:var(--fg);}
  .no-filters{padding:12px;font-size:12px;color:var(--muted);font-style:italic;}

  .charts-area{flex:1;overflow-y:auto;min-width:0;}
  .charts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));
               gap:12px;padding:12px;align-content:start;}
  .chart-card{background:var(--card);border:1px solid var(--border);border-radius:12px;
              overflow:hidden;display:flex;flex-direction:column;}
  .chart-card:hover{border-color:rgba(124,58,237,.45);}
  .chart-card.wide,.chart-card.table-card{grid-column:1/-1;}
  .chart-hdr{padding:9px 14px;font-size:12px;font-weight:600;color:var(--fg);
             border-bottom:1px solid var(--border);background:rgba(124,58,237,.08);flex-shrink:0;}
  .chart-body{flex:1;padding:4px;display:flex;flex-direction:column;}
  .plotly-div{flex:1;min-height:320px;width:100%;}
  .tbl-wrap{overflow:auto;flex:1;min-height:200px;padding:2px;}
  .data-tbl{width:100%;border-collapse:collapse;font-size:11px;}
  .data-tbl th{position:sticky;top:0;background:rgba(124,58,237,.25);color:var(--fg);
               padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--border);}
  .data-tbl td{padding:5px 10px;border-bottom:1px solid var(--border);color:var(--fg);}
  .data-tbl tr:hover td{background:rgba(255,255,255,.04);}

  .plotly-error{grid-column:1/-1;background:#451a03;border:1px solid #f97316;border-radius:8px;
                padding:14px 18px;color:#fed7aa;font-size:13px;margin-bottom:4px;}
  .chart-err{padding:24px;text-align:center;color:#f87171;font-size:12px;}

  /* â”€â”€ Table / Matrix shared â”€â”€ */
  .dt-wrap,.mrc-wrap{overflow:auto;width:100%;height:100%;}
  .tbl-footer,.dt-footer{font-size:10px;color:var(--muted);padding:5px 10px;text-align:right;}

  /* â”€â”€ Matrix â”€â”€ */
  .matrix-table{width:100%;border-collapse:collapse;font-size:11px;}
  .matrix-table th,.matrix-table td{padding:5px 10px;border:1px solid var(--border);white-space:nowrap;}
  .matrix-row-hdr,.matrix-col-hdr{background:rgba(124,58,237,.2);color:var(--purple2);font-weight:700;text-align:left;}
  .matrix-row-label{color:var(--fg);font-weight:600;}
  .matrix-total{background:rgba(124,58,237,.12);font-weight:700;color:var(--purple2);}
  .matrix-totals-row td{background:rgba(124,58,237,.1);border-top:2px solid var(--purple);}
  .matrix-table td.n{text-align:right;}

  /* â”€â”€ Multi-row card â”€â”€ */
  .mrc-wrap{overflow:auto;width:100%;height:100%;}
  .mrc-table{width:100%;border-collapse:collapse;font-size:12px;}
  .mrc-th{padding:7px 12px;font-size:10px;font-weight:700;text-transform:uppercase;
          letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap;}
  .mrc-th-group{text-align:left;min-width:120px;}
  .mrc-th-metric{text-align:right;min-width:100px;}
  .mrc-td{padding:6px 12px;border-bottom:1px solid var(--border);}
  .mrc-td-group{color:var(--fg);font-weight:600;}
  .mrc-td-metric{text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:5px;}
  .mrc-td-total{text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:5px;font-weight:700;}
  .mrc-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0;}
  .mrc-num{color:var(--fg);}
  .mrc-row:hover td{background:rgba(255,255,255,.03);}
  .mrc-alt td{background:rgba(255,255,255,.02);}
  .mrc-total-row td{background:rgba(124,58,237,.1);border-top:2px solid var(--purple);}
  .mrc-total-label{color:var(--purple2);font-weight:700;}

  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-track{background:var(--surf);}
  ::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
  ::-webkit-scrollbar-thumb:hover{background:var(--purple);}
`; }

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   EXCEL DASHBOARD EXPORT  â€” single tab, native editable charts
   Layout (one "Dashboard" sheet):
     â€¢ KPI cards   â€“ styled cells at top
     â€¢ Per chart   â€“ section header | data table on LEFT | native
                     editable Excel chart on RIGHT (same rows)
   Charts are real OOXML chart objects linked to the data cells,
   fully editable: click â†’ Design / Format tabs appear in Excel.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
/* ======================================================================
   EXCEL DASHBOARD EXPORT
   Layout (one "Dashboard" sheet):
     - Dashboard title + metadata
     - KPI SUMMARY: each card rendered as a styled coloured box
     - Per chart:
         Section header row (dark background, chart title)
         Chart image rows  (Plotly PNG, spans cols A-K, ~20 rows tall)
         Chart Data table  (aggregated data, styled rows, below image)
     - Raw Data sheet (all source rows, auto-filter)
   Chart images are real PNG bitmaps injected via JSZip.
   ====================================================================== */

async function downloadDashboardDataAsExcel() {
  const spec = AppState.currentSpec;
  if (!spec) { alert('Build a dashboard first, then click Download Excel.'); return; }
  if (typeof XLSX === 'undefined') { alert('XLSX library not loaded. Refresh the page.'); return; }

  const btn      = document.getElementById('btn-download-excel');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Building Excel…'; }

  try {
    const data     = getFilteredData();
    const raw      = AppState.rawData  || [];
    const cols     = AppState.columns && AppState.columns.length
                       ? AppState.columns : Object.keys(raw[0] || {});
    const colTypes = AppState.colTypes || {};

    /* Same column-name normaliser as downloadDashboardAsExcel */
    const _cols2   = AppState.columns || [];
    const _colSet2 = new Set(_cols2);
    const _fixCol2 = n => {
      if (!n || _colSet2.has(n)) return n;
      const h = _cols2.find(c => c.toLowerCase() === String(n).toLowerCase());
      return h || n;
    };
    const _fixChart2 = c => ({
      ...c,
      x_column:      _fixCol2(c.x_column),
      y_column:      _fixCol2(c.y_column),
      y2_column:     _fixCol2(c.y2_column),
      color_column:  _fixCol2(c.color_column),
      size_column:   _fixCol2(c.size_column),
      end_column:    _fixCol2(c.end_column),
      target_column: _fixCol2(c.target_column),
      value_column:  _fixCol2(c.value_column),
      z_column:      _fixCol2(c.z_column),
      columns:   Array.isArray(c.columns)   ? c.columns.map(_fixCol2)   : c.columns,
      y_columns: Array.isArray(c.y_columns) ? c.y_columns.map(_fixCol2) : c.y_columns,
    });


    const title    = spec.title || 'Dashboard';
    const sheetName = title.slice(0, 31);
    const safe     = title.replace(/[^a-zA-Z0-9_\- ]/g, '').trim()
                          .replace(/\s+/g, '_').slice(0, 40) || 'dashboard';

    /* ── KPI value formatter ── */
    const fmtKpiVal = (v, k) => {
      if (typeof v === 'string') return v || '—';
      if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
      const p = k.format === 'currency' ? (k.prefix != null ? k.prefix : '$') : (k.prefix || '');
      const s = k.suffix || '';
      if (k.format === 'percentage') return p + (v * 100).toFixed(1) + '%' + s;
      if (k.format === 'integer')    return p + Math.round(v).toLocaleString() + s;
      return p + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + s;
    };

    /* ── Shared aggregation helper ── */
    const _agg = (nums, ag) => {
      if (!nums.length) return 0;
      switch (ag) {
        case 'count': return nums.length;
        case 'mean':  return nums.reduce((s, v) => s + v, 0) / nums.length;
        case 'max':   return Math.max(...nums);
        case 'min':   return Math.min(...nums);
        default:      return nums.reduce((s, v) => s + v, 0);
      }
    };

    /* ── Aggregate chart data ── */
    const aggChart = chart => {
      const type = chart.type;
      const ag   = chart.y_column ? (chart.aggregation || 'sum') : 'count';
      const xc   = chart.x_column, yc = chart.y_column, cc = chart.color_column;

      if (type === 'table') {
        const c = (Array.isArray(chart.columns) && chart.columns.length)
          ? chart.columns : [xc, yc].filter(Boolean);
        if (!c.length) return null;
        return { h: c, r: data.slice(0, chart.top_n || 500).map(row => c.map(col => row[col] != null ? row[col] : '')) };
      }

      if (type === 'matrix') {
        if (!xc || !cc) return null;
        const rvs = [...new Set(data.map(r => String(r[xc] != null ? r[xc] : '')))].sort().slice(0, 50);
        const cvs = [...new Set(data.map(r => String(r[cc] != null ? r[cc] : '')))].sort().slice(0, 15);
        const byR = {};
        data.forEach(r => { const v = String(r[xc] != null ? r[xc] : ''); (byR[v] = byR[v] || []).push(r); });
        const ca = (rows2, vc) => {
          const n = vc ? rows2.map(r => Number(r[vc])).filter(n2 => !isNaN(n2)) : [];
          if (ag === 'count') return rows2.length;
          return _agg(n, ag);
        };
        return {
          h: [xc, ...cvs, 'Total'],
          r: [
            ...rvs.map(rv => { const d2 = byR[rv] || []; return [rv, ...cvs.map(cv => ca(d2.filter(r => String(r[cc] != null ? r[cc] : '') === cv), yc)), ca(d2, yc)]; }),
            ['Total', ...cvs.map(cv => ca(data.filter(r => String(r[cc] != null ? r[cc] : '') === cv), yc)), ca(data, yc)]
          ]
        };
      }

      if (type === 'multi_row_card') {
        const gc = xc;
        let ms = Array.isArray(chart.metrics) && chart.metrics.length ? chart.metrics : null;
        if (!ms) {
          ms = [{ label: 'Count', column: null, aggregation: 'count' }];
          if (yc) { ms.push({ label: 'Total ' + yc, column: yc, aggregation: 'sum' }); ms.push({ label: 'Avg ' + yc, column: yc, aggregation: 'mean' }); }
        }
        const cm = (rows2, m) => {
          if (m.aggregation === 'count' || !m.column) return rows2.length;
          const n = rows2.map(r => Number(r[m.column])).filter(n2 => !isNaN(n2));
          return _agg(n, m.aggregation);
        };
        const gs = gc ? [...new Set(data.map(r => r[gc]).filter(v => v != null && v !== ''))].sort() : ['(All)'];
        return {
          h: [gc || 'Group', ...ms.map(m => m.label)],
          r: [...gs.map(g => { const d2 = gc ? data.filter(r => r[gc] === g) : data; return [g, ...ms.map(m => cm(d2, m))]; }), ['Total', ...ms.map(m => cm(data, m))]]
        };
      }

      if (type === 'histogram') {
        const hc = xc || yc;
        if (!hc) return null;
        const vals = data.map(r => Number(r[hc])).filter(n => !isNaN(n)).sort((a, b) => a - b);
        if (!vals.length) return null;
        const bins = 20, lo = vals[0], hi = vals[vals.length - 1], bw = (hi - lo) / bins || 1;
        const counts = Array.from({ length: bins }, (_, i) => {
          const lo2 = lo + i * bw, hi2 = lo2 + bw;
          return [lo2.toFixed(1) + '-' + hi2.toFixed(1), vals.filter(v => v >= lo2 && (i === bins - 1 ? v <= hi2 : v < hi2)).length];
        });
        return { h: [hc + ' (range)', 'Count'], r: counts };
      }

      /* Gauge: single aggregated value — no x_column needed */
      if (type === 'gauge') {
        const col = yc || xc;
        if (!col) return null;
        const nums = data.map(r => Number(r[col])).filter(n => !isNaN(n));
        if (!nums.length) return null;
        const val = ag === 'mean'
          ? nums.reduce((s, v) => s + v, 0) / nums.length
          : nums.reduce((s, v) => s + v, 0);
        return { h: ['Metric', 'Value'], r: [[chart.title || col, Math.round(val * 100) / 100]] };
      }

      /* Scatter / bubble: raw row pairs capped at top_n */
      if (type === 'scatter' || type === 'bubble') {
        const xcol = xc, ycol = yc;
        if (!xcol || !ycol) return null;
        const pairs = data
          .filter(r => r[xcol] != null && r[ycol] != null)
          .slice(0, chart.top_n || 500)
          .map(r => [r[xcol], r[ycol]]);
        if (!pairs.length) return null;
        return { h: [xcol, ycol], r: pairs };
      }

      /* Stacked charts with y_columns array (legacy multi-series format) */
      if ((type === 'stacked_bar' || type === 'stacked_area') &&
          Array.isArray(chart.y_columns) && chart.y_columns.length && xc) {
        const yvs = chart.y_columns.filter(Boolean);
        const xvs = [...new Set(data.map(r => String(r[xc] != null ? r[xc] : '(blank)')))];
        const rows = xvs.map(x => {
          const xRows = data.filter(r => String(r[xc] != null ? r[xc] : '(blank)') === x);
          return [x, ...yvs.map(yv => {
            const nums = xRows.map(r => Number(r[yv])).filter(n => !isNaN(n));
            return nums.reduce((s, v) => s + v, 0);
          })];
        });
        return { h: [xc, ...yvs], r: rows };
      }

      /* Sankey / hierarchy: show as two-column source→target count */
      if (type === 'sankey' || type === 'hierarchy' || type === 'icicle' || type === 'sunburst') {
        const src = xc, tgt = cc || yc;
        if (!src || !tgt) {
          if (xc) { /* fall through to single-series below */ }
          else return null;
        } else {
          const pairs = new Map();
          data.forEach(r => {
            const k = String(r[src] != null ? r[src] : '') + ' → ' + String(r[tgt] != null ? r[tgt] : '');
            pairs.set(k, (pairs.get(k) || 0) + 1);
          });
          return {
            h: ['Flow', 'Count'],
            r: [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => [k, v])
          };
        }
      }

      /* Heatmap: pivot on x vs color_column */
      if (type === 'heatmap') {
        if (xc && cc) {
          /* reuse color_column pivot logic below */
        } else if (xc && yc) {
          /* treat y_column as color */
        }
      }

      /* Funnel / waterfall-like: category + value sorted by value desc */
      if (type === 'funnel') {
        if (!xc) return null;
        const map3 = new Map();
        data.forEach(r => {
          const k = String(r[xc] != null ? r[xc] : '(blank)');
          if (!map3.has(k)) map3.set(k, { n: 0, s: 0, v: [] });
          const g = map3.get(k); g.n++;
          if (yc) { const n = Number(r[yc]); if (!isNaN(n)) { g.s += n; g.v.push(n); } }
        });
        const cy3 = g => yc ? _agg(g.v, ag) : g.n;
        return { h: [xc, yc || 'Count'], r: [...map3.entries()].map(([x, g]) => [x, cy3(g)]).sort((a, b) => b[1] - a[1]) };
      }

      if (!xc) return null;

      /* Multi-series via color_column */
      if (cc) {
        const cats = [...new Set(data.map(r => String(r[cc] != null ? r[cc] : '')))].sort();
        const xvs  = [...new Set(data.map(r => String(r[xc] != null ? r[xc] : '')))].sort();
        const bm   = {};
        data.forEach(r => {
          const x = String(r[xc] != null ? r[xc] : ''), c2 = String(r[cc] != null ? r[cc] : '');
          if (!bm[x]) bm[x] = {};
          if (!bm[x][c2]) bm[x][c2] = { n: 0, s: 0, v: [] };
          const g = bm[x][c2]; g.n++;
          if (yc) { const n = Number(r[yc]); if (!isNaN(n)) { g.s += n; g.v.push(n); } }
        });
        const cy = g => { switch (ag) { case 'count': return g.n; case 'mean': return g.v.length ? g.s / g.v.length : 0; default: return _agg(g.v, ag); } };
        const eg = { n: 0, s: 0, v: [] };
        return { h: [xc, ...cats], r: xvs.map(x => [x, ...cats.map(c2 => cy((bm[x] && bm[x][c2]) || eg))]) };
      }

      /* Single-series aggregation (bar, line, area, pie, donut, treemap, etc.) */
      const map2 = new Map();
      data.forEach(r => {
        const k = String(r[xc] != null ? r[xc] : '(blank)');
        if (!map2.has(k)) map2.set(k, { n: 0, s: 0, v: [] });
        const g = map2.get(k); g.n++;
        if (yc) { const n = Number(r[yc]); if (!isNaN(n)) { g.s += n; g.v.push(n); } }
      });
      const cy2 = g => yc ? _agg(g.v, ag) : g.n;
      return { h: [xc, yc || 'Count'], r: [...map2.entries()].map(([x, g]) => [x, cy2(g)]).sort((a, b) => b[1] - a[1]) };
    };

    /* ── Colour palette ── */
    const C = {
      NAVY: '1F4E79', PURPLE: '5B21B6', TEAL: '0F766E', AMBER: '92400E', GREEN: '166534',
      GREY: '374151', MGREY: '6B7280', LBLUE: 'DBEAFE', LPURPLE: 'EDE9FE',
      LTEAL: 'CCFBF1', LAMBER: 'FEF3C7', LGREEN: 'DCFCE7', LGREY: 'F3F4F6',
      WHITE: 'FFFFFF', STRIPE: 'F9FAFB',
    };
    const KPI_ACC = [
      { fg: C.NAVY, bg: C.LBLUE }, { fg: C.PURPLE, bg: C.LPURPLE },
      { fg: C.TEAL, bg: C.LTEAL }, { fg: C.AMBER, bg: C.LAMBER },
      { fg: C.GREEN, bg: C.LGREEN },
    ];

    const TABLE_TYPES = new Set(['table', 'matrix', 'multi_row_card']);
    const NATIVE_CHART_TYPES = new Set(['bar', 'horizontal_bar', 'stacked_bar', 'line', 'area',
      'stacked_area', 'pie', 'donut', 'scatter', 'bubble', 'combo', 'histogram', 'waterfall',
      'treemap', 'funnel', 'gauge']);

    /* ── Build worksheet ── */
    const wb     = XLSX.utils.book_new();
    const rows   = [];
    const rmeta  = [];
    const merges = [];
    let   R      = 0;

    const push = (vals, m) => { rows.push(vals); rmeta.push(m || {}); R++; };

    push([title], { t: 'title' });
    push(['Exported: ' + new Date().toLocaleString() + '   |   ' + data.length.toLocaleString() + ' rows'], { t: 'subtitle' });
    push([], {}); push([], {});

    /* ── KPI SUMMARY ── */
    const kpis = spec.kpi_cards || [];
    if (kpis.length) {
      push(['KPI SUMMARY'], { t: 'section' });
      push([], {});
      const PER_ROW = 4;
      for (let i = 0; i < kpis.length; i += PER_ROW) {
        const slice = kpis.slice(i, i + PER_ROW);
        const acc   = slice.map((_, j) => KPI_ACC[(i + j) % KPI_ACC.length]);
        push(slice.flatMap(() => ['', '', '']), { t: 'kpi_top', acc });
        const lblRow = R;
        push(slice.flatMap(k => [k.title || k.column || 'KPI', '', '']), { t: 'kpi_lbl', acc });
        const vals = slice.map(k => { try { return fmtKpiVal(computeKPI(data, k), k); } catch (_) { return '—'; } });
        const valRow = R;
        push(vals.flatMap(v => [v, '', '']), { t: 'kpi_val', acc });
        push(slice.flatMap(() => ['', '', '']), { t: 'kpi_bot', acc });
        push([], {});
        /* Merge label+value cells across 2 cols per card for a card-like look */
        slice.forEach((_, ki) => {
          merges.push({ s: { r: lblRow, c: ki * 3 }, e: { r: lblRow, c: ki * 3 + 1 } });
          merges.push({ s: { r: valRow, c: ki * 3 }, e: { r: valRow, c: ki * 3 + 1 } });
        });
      }
      push([], {});
    }

    /* ── CHARTS ── */
    const chartAnchors = [];
    const IMG_ROWS     = 20;
    const visCharts    = (spec.charts || []).filter(c => c.type !== 'slicer').map(_fixChart2);

    for (const chart of visCharts) {
      const chartTitle = chart.title || chart.type || 'Chart';

      push([chartTitle], { t: 'section' });

      /* Reserve rows for the native chart graphic */
      const imgFromRow = R;
      for (let i = 0; i < IMG_ROWS; i++) push([], { t: 'img_ph' });
      push([], {});

      /* Aggregated data table */
      const d = aggChart(chart);
      let dataHdrRow0 = -1, dataEndRow0 = -1, dataHeaders = [];

      if (d && d.h && d.r && d.r.length) {
        push(['Chart Data: ' + chartTitle], { t: 'data_section' });
        push(d.h, { t: 'hdr' });
        dataHdrRow0 = R - 1;          // 0-based row of column header
        d.r.forEach((row, ri) =>
          push(row, { t: 'data', alt: ri % 2 === 1, last: ri === d.r.length - 1 })
        );
        dataEndRow0  = R - 1;         // 0-based last data row
        dataHeaders  = d.h;
      } else if (!TABLE_TYPES.has(chart.type)) {
        push(['(no data available)'], { t: 'muted' });
      }

      chartAnchors.push({ fromRow: imgFromRow, toRow: imgFromRow + IMG_ROWS,
        dataHdrRow0, dataEndRow0, headers: dataHeaders, chart });

      push([], {}); push([], {});
    }

    /* ── Build worksheet object ── */
    const ws = XLSX.utils.aoa_to_sheet(rows);

    /* Cell styles */
    const bT = c => ({ style: 'thin',   color: { rgb: c } });
    const bH = c => ({ style: 'hair',   color: { rgb: c } });
    const bM = c => ({ style: 'medium', color: { rgb: c } });

    rows.forEach((row, ri) => {
      const m = rmeta[ri];
      if (!m || !m.t) return;
      row.forEach((_, ci) => {
        const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
        if (!ws[addr]) return;
        const v = ws[addr].v, isN = typeof v === 'number';
        let s = null;
        switch (m.t) {
          case 'title':
            s = { font: { bold: true, sz: 20, color: { rgb: C.NAVY }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: C.LBLUE } },
                  alignment: { horizontal: 'left', vertical: 'center' },
                  border: { bottom: { style: 'medium', color: { rgb: C.NAVY } } } }; break;
          case 'subtitle':
            s = { font: { sz: 9, italic: true, color: { rgb: C.MGREY }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: C.LGREY } },
                  alignment: { horizontal: 'left' } }; break;
          case 'section':
            s = { font: { bold: true, sz: 13, color: { rgb: C.WHITE }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: C.NAVY } },
                  alignment: { horizontal: 'left', vertical: 'middle' } }; break;
          case 'data_section':
            s = { font: { bold: true, sz: 10, color: { rgb: C.GREY }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: C.LGREY } },
                  alignment: { horizontal: 'left', vertical: 'middle' },
                  border: { bottom: bT(C.MGREY) } }; break;
          case 'kpi_top': case 'kpi_bot': {
            const ki = Math.floor(ci / 3);
            const a  = (m.acc || [])[ki] || KPI_ACC[0];
            if (ci % 3 >= 2) return;
            const bdr = {};
            if (m.t === 'kpi_top') bdr.top    = bM(a.fg);
            if (m.t === 'kpi_bot') bdr.bottom  = bM(a.fg);
            if (ci % 3 === 0)      bdr.left   = bM(a.fg);
            if (ci % 3 === 1)      bdr.right  = bM(a.fg);
            s = { fill: { patternType: 'solid', fgColor: { rgb: a.bg } }, border: bdr }; break;
          }
          case 'kpi_lbl': {
            const ki = Math.floor(ci / 3);
            const a  = (m.acc || [])[ki] || KPI_ACC[0];
            if (ci % 3 >= 2) return;
            const bdr = {};
            if (ci % 3 === 0) bdr.left  = bM(a.fg);
            if (ci % 3 === 1) bdr.right = bM(a.fg);
            s = { font: { bold: true, sz: 9, color: { rgb: a.fg }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: a.bg } },
                  alignment: { horizontal: 'center', vertical: 'bottom', wrapText: false },
                  border: bdr }; break;
          }
          case 'kpi_val': {
            const ki = Math.floor(ci / 3);
            const a  = (m.acc || [])[ki] || KPI_ACC[0];
            if (ci % 3 >= 2) return;
            const bdr = {};
            if (ci % 3 === 0) bdr.left  = bM(a.fg);
            if (ci % 3 === 1) bdr.right = bM(a.fg);
            s = { font: { bold: true, sz: 22, color: { rgb: a.fg }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: a.bg } },
                  alignment: { horizontal: 'center', vertical: 'center' },
                  border: bdr }; break;
          }
          case 'hdr':
            s = { font: { bold: true, sz: 10, color: { rgb: C.WHITE }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: C.TEAL } },
                  alignment: { horizontal: isN ? 'right' : 'center', vertical: 'middle' },
                  border: { bottom: bT(C.TEAL), top: bT(C.TEAL),
                            left: bT(C.TEAL), right: bT(C.TEAL) } }; break;
          case 'data': {
            const last = m.last;
            s = { font: { bold: last, sz: 10, color: { rgb: last ? C.WHITE : C.GREY }, name: 'Calibri' },
                  fill: { patternType: 'solid', fgColor: { rgb: last ? C.TEAL : (m.alt ? C.STRIPE : C.WHITE) } },
                  alignment: { horizontal: isN ? 'right' : 'left', vertical: 'center' },
                  border: { bottom: bH(last ? C.TEAL : 'E5E7EB') } }; break;
          }
          case 'muted':
            s = { font: { italic: true, sz: 10, color: { rgb: C.MGREY }, name: 'Calibri' },
                  alignment: { horizontal: 'left' } }; break;
          default: return;
        }
        if (s) ws[addr].s = s;
      });
    });

    /* Row heights */
    ws['!rows'] = rows.map((_, ri) => {
      const t = rmeta[ri].t;
      if (t === 'title')        return { hpt: 36 };
      if (t === 'section')      return { hpt: 28 };
      if (t === 'data_section') return { hpt: 22 };
      if (t === 'kpi_val')      return { hpt: 44 };
      if (t === 'kpi_lbl')      return { hpt: 22 };
      if (t === 'kpi_top' || t === 'kpi_bot') return { hpt: 6 };
      if (t === 'hdr')          return { hpt: 22 };
      if (t === 'img_ph')       return { hpt: 15 };
      return { hpt: 18 };
    });

    /* Column widths — wide enough for matrix/multi-row-card columns */
    ws['!cols'] = Array.from({ length: 30 }, (_, i) => {
      if (i === 0)  return { wch: 30 };
      if (i < 12)   return { wch: 16 };
      if (i < 20)   return { wch: 14 };
      return { wch: 12 };
    });

    /* Cell merges (KPI cards) */
    if (merges.length) ws['!merges'] = merges;

    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    /* ── Raw Data sheet ── */
    if (raw.length && cols.length) {
      const rr = [cols, ...raw.slice(0, 30000).map(r => cols.map(c => {
        const v = r[c] != null ? r[c] : '';
        return colTypes[c] === 'number' && v !== '' ? Number(v) : v;
      }))];
      const wr = XLSX.utils.aoa_to_sheet(rr);
      cols.forEach((_, ci) => {
        const a = XLSX.utils.encode_cell({ r: 0, c: ci });
        if (wr[a]) wr[a].s = { font: { bold: true, sz: 10, color: { rgb: C.WHITE }, name: 'Calibri' },
          fill: { patternType: 'solid', fgColor: { rgb: C.NAVY } }, alignment: { horizontal: 'center' } };
      });
      wr['!cols'] = cols.map(() => ({ wch: 16 }));
      wr['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rr.length - 1, c: cols.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, wr, 'Raw Data');
    }

    /* ── Write XLSX ── */
    let wbArr;
    try   { wbArr = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true }); }
    catch { wbArr = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }); }

    /* ── Inject chart PNG screenshots via JSZip ── */
    let finalArr = wbArr;

    if (typeof JSZip !== 'undefined' && typeof Plotly !== 'undefined') {
      try {
        if (btn) btn.textContent = 'Capturing charts…';

        /* Capture PNG from each rendered chart element */
        const chartImages = [];
        for (const anchor of chartAnchors) {
          const { chart } = anchor;
          const type = (chart.type || '').toLowerCase();
          const TABLE_LIKE = new Set(['table', 'matrix', 'multi_row_card', 'slicer']);
          if (TABLE_LIKE.has(type)) { chartImages.push(null); continue; }

          const el = document.getElementById(chart.id);
          let dataUrl = null;
          if (el && typeof Plotly.toImage === 'function') {
            try {
              dataUrl = await Plotly.toImage(el, {
                format: 'png', width: 900, height: 420, scale: 1.5
              });
            } catch (_) { /* chart may not be rendered — skip */ }
          }
          chartImages.push(dataUrl); // null if not captured
        }

        /* base64 → Uint8Array */
        const b64ToBytes = b64 => {
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return arr;
        };

        const zip = await JSZip.loadAsync(wbArr);
        let ctXml     = await zip.file('[Content_Types].xml').async('text');
        const WS_XML  = 'xl/worksheets/sheet1.xml';
        let wsXml     = await zip.file(WS_XML).async('text');
        const WR_PATH = 'xl/worksheets/_rels/sheet1.xml.rels';
        const wrFile  = zip.file(WR_PATH);
        let wrXml = wrFile ? await wrFile.async('text')
          : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

        let drawParts = '';
        let drawRels  = '';
        let imgCount  = 0;

        chartImages.forEach((dataUrl, i) => {
          if (!dataUrl) return;
          const anchor = chartAnchors[i];
          const { fromRow, toRow, chart } = anchor;

          imgCount++;
          const imgIdx  = imgCount;
          const relId   = 'rIdImg' + imgIdx;
          const b64     = dataUrl.replace(/^data:image\/png;base64,/, '');

          zip.file('xl/media/image' + imgIdx + '.png', b64ToBytes(b64));

          drawParts +=
            '<xdr:twoCellAnchor editAs="twoCell">' +
              '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>9144</xdr:colOff>' +
                '<xdr:row>' + fromRow + '</xdr:row><xdr:rowOff>9144</xdr:rowOff></xdr:from>' +
              '<xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff>' +
                '<xdr:row>' + toRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
              '<xdr:pic>' +
                '<xdr:nvPicPr>' +
                  '<xdr:cNvPr id="' + (300 + imgIdx) + '" name="Chart ' + imgIdx + '"/>' +
                  '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>' +
                '</xdr:nvPicPr>' +
                '<xdr:blipFill>' +
                  '<a:blip r:embed="' + relId + '"/>' +
                  '<a:stretch><a:fillRect/></a:stretch>' +
                '</xdr:blipFill>' +
                '<xdr:spPr>' +
                  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
                  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
                '</xdr:spPr>' +
              '</xdr:pic>' +
              '<xdr:clientData/>' +
            '</xdr:twoCellAnchor>';

          drawRels +=
            '<Relationship Id="' + relId + '"' +
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
            ' Target="../media/image' + imgIdx + '.png"/>';
        });

        if (imgCount > 0) {
          /* Add PNG content type if not present */
          if (!ctXml.includes('Extension="png"'))
            ctXml = ctXml.replace('</Types>',
              '<Default Extension="png" ContentType="image/png"/></Types>');

          zip.file('xl/drawings/drawing1.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<xdr:wsDr' +
            ' xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
            ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            drawParts + '</xdr:wsDr>');

          zip.file('xl/drawings/_rels/drawing1.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            drawRels + '</Relationships>');

          if (!ctXml.includes('drawing1.xml'))
            ctXml = ctXml.replace('</Types>',
              '<Override PartName="/xl/drawings/drawing1.xml"' +
              ' ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');

          zip.file('[Content_Types].xml', ctXml);

          if (!wsXml.includes('xmlns:r='))
            wsXml = wsXml.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
          if (!wsXml.includes('<drawing '))
            wsXml = wsXml.replace('</worksheet>', '<drawing r:id="rIdDraw1"/></worksheet>');
          zip.file(WS_XML, wsXml);

          if (!wrXml.includes('rIdDraw1'))
            wrXml = wrXml.replace('</Relationships>',
              '<Relationship Id="rIdDraw1"' +
              ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"' +
              ' Target="../drawings/drawing1.xml"/></Relationships>');
          zip.file(WR_PATH, wrXml);
        }

        finalArr = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

      } catch (zipErr) {
        console.warn('[xl] Image injection failed, downloading data-only:', zipErr.message || zipErr);
        finalArr = wbArr;
      }
    }

    const blob = new Blob([finalArr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    _triggerDownload(blob, safe + '_' + _datestamp() + '.xlsx');

  } catch (err) {
    console.error('[excel-export] FATAL:', err);
    alert('Export failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

function _uniqueVals(data, col) {
  const seen = new Set();
  data.forEach(r => { const v = String(r[col] != null ? r[col] : ''); if (v) seen.add(v); });
  return [...seen].sort();
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _datestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function _showExcelModal(msg) {
  const el = document.getElementById('excel-modal-msg');
  if (el) el.textContent = msg;
  const m  = document.getElementById('modal-excel-guard');
  if (m)  m.classList.remove('hidden');
}

function closeExcelModal() {
  const m = document.getElementById('modal-excel-guard');
  if (m) m.classList.add('hidden');
}
