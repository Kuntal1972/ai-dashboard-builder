/**
 * chart-renderer.js — Plotly.js chart rendering engine
 * Depends on: state.js (AppState), data-processor.js (aggregateData, shortNumber)
 * External: Plotly (loaded via CDN in index.html)
 */

/* ════════════════════════════
   GLOBAL RESIZE HANDLER
   Single debounced listener — replaces the per-chart listeners that caused
   accumulating duplicate handlers on every renderDashboard() call.
   ════════════════════════════ */
(function _installGlobalResizeHandler() {
  let _resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      /* Relayout every active Plotly chart in the grid */
      const charts = document.querySelectorAll('.plotly-chart');
      charts.forEach(function (el) {
        if (el.id && el._fullLayout) {
          try { Plotly.relayout(el, { autosize: true }); } catch (_) {}
        }
      });
    }, 120);
  });
})();

/* ════════════════════════════
   PLOTLY BASE LAYOUT
   ════════════════════════════ */

function getBaseLayout() {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor:  'rgba(0,0,0,0)',
    font: { color: '#e2e8f0', size: 12, family: 'Segoe UI, system-ui, sans-serif' },
    margin: { t: 10, b: 60, l: 90, r: 20 },
    showlegend: true,
    legend: { font: { color: '#94a3b8', size: 11 }, bgcolor: 'rgba(0,0,0,0)' },
    xaxis: { gridcolor: '#2e2e50', zerolinecolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 11 }, tickformat: ',.2f' },
    yaxis: { gridcolor: '#2e2e50', zerolinecolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 11 }, tickformat: ',.2f' },
    hoverlabel: { bgcolor: '#252540', bordercolor: '#7c3aed', font: { color: '#e2e8f0' } }
  };
}

function getPlotlyConfig(chartTitle) {
  const cfg = AppState.config?.chart ?? {};
  return {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['sendDataToCloud', 'select2d', 'lasso2d', 'autoScale2d'],
    toImageButtonOptions: {
      format:   cfg.exportFormat ?? 'png',
      width:    cfg.exportWidth  ?? 1400,
      height:   cfg.exportHeight ?? 700,
      filename: chartTitle || 'chart'
    }
  };
}

/* ════════════════════════════
   COLOR HELPERS
   ════════════════════════════ */

function getColors() {
  return AppState.config?.chart?.defaultColors ?? [
    '#7c3aed','#06b6d4','#10b981','#f59e0b',
    '#ef4444','#8b5cf6','#3b82f6','#ec4899',
    '#14b8a6','#f97316','#a3e635','#fb923c'
  ];
}

function getColorScale(scheme) {
  const scales = AppState.config?.chart?.colorScales ?? {};
  return scales[scheme] ?? 'Portland';
}

/* ════════════════════════════
   MAIN RENDER FUNCTION
   ════════════════════════════ */

/**
 * Render a single chart into its DOM container.
 * @param {Object}   spec  - Chart specification from Claude
 * @param {Object[]} data  - Filtered dataset
 */
function renderChart(spec, data) {
  const el = document.getElementById(spec.id);
  if (!el) return;

  if (spec.type === 'table') {
    try {
      renderTableChart(spec, data, el);
    } catch (err) {
      el.innerHTML = `<div class="chart-error">⚠️ Table render error: ${err.message}</div>`;
      console.error('Table render error:', spec, err);
    }
    return;
  }

  if (spec.type === 'multi_row_card') {
    try {
      renderMultiRowCard(spec, data, el);
    } catch (err) {
      el.innerHTML = `<div class="chart-error">⚠️ Multi-row card error: ${err.message}</div>`;
      console.error('Multi-row card error:', spec, err);
    }
    return;
  }

  if (spec.type === 'slicer') {
    try {
      renderButtonSlicer(spec, el);
    } catch (err) {
      el.innerHTML = `<div class="chart-error">⚠️ Slicer error: ${err.message}</div>`;
      console.error('Slicer error:', spec, err);
    }
    return;
  }

  if (spec.type === 'matrix') {
    try {
      renderMatrixChart(spec, data, el);
    } catch (err) {
      el.innerHTML = `<div class="chart-error">⚠️ Matrix render error: ${err.message}</div>`;
      console.error('Matrix render error:', spec, err);
    }
    return;
  }

  try {
    const layout = getBaseLayout();
    layout.colorway = getColors();
    const traces = buildTraces(spec, data, layout);
    Plotly.newPlot(spec.id, traces, layout, getPlotlyConfig(spec.title));
  } catch (err) {
    el.innerHTML = `<div class="chart-error">
      ⚠️ Render error: ${err.message}<br>
      <small>Type: ${spec.type} | x: ${spec.x_column} | y: ${spec.y_column}</small>
    </div>`;
    console.error('Chart render error:', spec, err);
  }
}

/* ════════════════════════════
   TRACE BUILDERS
   ════════════════════════════ */

function buildTraces(spec, data, layout) {
  const { type } = spec;

  switch (type) {
    case 'pie':
    case 'donut':      return buildPieTraces(spec, data, layout);
    case 'treemap':    return buildTreemapTraces(spec, data, layout);
    case 'funnel':     return buildFunnelTraces(spec, data);
    case 'scatter':    return buildScatterTraces(spec, data);
    case 'bubble':     return buildBubbleTraces(spec, data, layout);
    case 'histogram':  return buildHistogramTraces(spec, data, layout);
    case 'box':        return buildBoxTraces(spec, data);
    case 'marimekko':  return buildMarimekkoTraces(spec, data, layout);
    case 'heatmap':    return buildHeatmapTraces(spec, data, layout);
    case 'icicle':     return buildIcicleTraces(spec, data, layout);
    case 'sunburst':   return buildSunburstTraces(spec, data, layout);
    case 'waterfall':  return buildWaterfallTraces(spec, data, layout);
    case 'gauge':      return buildGaugeTraces(spec, data, layout);
    case 'combo':      return buildComboTraces(spec, data, layout);
    case 'choropleth':
    case 'filled_map':
    case 'map':        return buildChoroplethTraces(spec, data, layout);
    case 'scattergeo': return buildScatterGeoTraces(spec, data, layout);
    case 'sankey':     return buildSankeyTraces(spec, data, layout);
    case 'gantt':      return buildGanttTraces(spec, data, layout);
    case 'bullet':     return buildBulletTraces(spec, data, layout);
    default:           return buildBarLineAreaTraces(spec, data, layout);
  }
}

/* ── Sankey ── */
function _hexToRgba(hex, alpha) {
  const h = (hex || '#888888').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 136;
  const g = parseInt(h.slice(2, 4), 16) || 136;
  const b = parseInt(h.slice(4, 6), 16) || 136;
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildSankeyTraces(spec, data, layout) {
  const srcCol = spec.x_column;
  const tgtCol = spec.y_column;
  const valCol = spec._value_column || spec.target_column;

  if (!srcCol) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  // Auto-pick target column if missing
  const effectiveTgt = tgtCol
    || Object.keys(data[0] || {}).find(k => k !== srcCol && typeof data[0][k] === 'string');
  if (!effectiveTgt) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  // ── Aggregate flows in one pass ────────────────────────────────────────
  const linkMap   = {};
  const tgtTotals = {};
  const srcTotals = {};
  data.forEach(r => {
    const src = String(r[srcCol]       ?? '').trim();
    const tgt = String(r[effectiveTgt] ?? '').trim();
    if (!src || !tgt || src === tgt) return;
    const addVal = (valCol && r[valCol] != null) ? (Number(r[valCol]) || 1) : 1;
    const key = `${src}|||${tgt}`;
    if (!linkMap[key]) linkMap[key] = { src, tgt, val: 0 };
    linkMap[key].val += addVal;
    srcTotals[src]    = (srcTotals[src] || 0) + addVal;
    tgtTotals[tgt]    = (tgtTotals[tgt] || 0) + addVal;
  });

  // ── Top-20 per side (keeps layout fast and readable) ──────────────────
  const NODE_LIMIT = 20;
  const topSrcs = new Set(Object.entries(srcTotals).sort((a,b)=>b[1]-a[1]).slice(0,NODE_LIMIT).map(e=>e[0]));
  const topTgts = new Set(Object.entries(tgtTotals).sort((a,b)=>b[1]-a[1]).slice(0,NODE_LIMIT).map(e=>e[0]));

  const links = Object.values(linkMap).filter(l => l.val > 0 && topSrcs.has(l.src) && topTgts.has(l.tgt));
  if (!links.length) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  // ── Node lists — sources left, targets right ───────────────────────────
  const srcSet  = new Set(links.map(l => l.src));
  const srcNodes = [...srcSet].sort((a,b) => (srcTotals[b]||0) - (srcTotals[a]||0));
  const tgtNodes = [...new Set(links.map(l => l.tgt))]
    .filter(n => !srcSet.has(n))
    .sort((a,b) => (tgtTotals[b]||0) - (tgtTotals[a]||0));
  const nodeList = [...srcNodes, ...tgtNodes];
  if (!nodeList.length) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);
  const nodeIdx = Object.fromEntries(nodeList.map((n,i) => [n,i]));

  // ── Currency-aware value formatter ────────────────────────────────────
  const isCurrency = valCol && /price|revenue|sales|amount|cost|pay|salary|income|profit|budget|spend|earn|value/i.test(valCol);
  const fmtVal = v => {
    if (v == null || isNaN(v)) return '';
    const abs = Math.abs(v);
    let s;
    if      (abs >= 1e9) s = `${(v/1e9).toFixed(2)}B`;
    else if (abs >= 1e6) s = `${(v/1e6).toFixed(1)}M`;
    else if (abs >= 1e3) s = `${(v/1e3).toFixed(1)}K`;
    else                 s = v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    return isCurrency ? `$${s}` : s;
  };

  // ── "Name\nValue" labels ──────────────────────────────────────────────
  const LABEL_MAX = 22;
  const trunc = s => s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + '…' : s;
  const displayLabels = nodeList.map(n => {
    const name  = trunc(n);
    const total = srcTotals[n] != null ? srcTotals[n] : (tgtTotals[n] || 0);
    const vStr  = fmtVal(total);
    return vStr ? `${name}\n${vStr}` : name;
  });

  // ── Vibrant palette — one distinct colour per source node ─────────────
  const PALETTE = [
    '#4e9af1','#f0a500','#7bc67e','#e05c5c','#9b59b6',
    '#1abc9c','#e67e22','#3498db','#e74c3c','#2ecc71',
    '#f39c12','#16a085','#8e44ad','#d35400','#27ae60'
  ];
  const srcColorMap = {};
  srcNodes.forEach((n,i) => { srcColorMap[n] = PALETTE[i % PALETTE.length]; });

  // Pre-compute dominant source per target node — O(n), not O(n²)
  const tgtDomSrc = {};
  links.forEach(l => {
    if (!tgtDomSrc[l.tgt] || l.val > tgtDomSrc[l.tgt].val)
      tgtDomSrc[l.tgt] = { src: l.src, val: l.val };
  });

  const nodeColors = nodeList.map(n => {
    if (srcColorMap[n]) return srcColorMap[n];
    const dom = tgtDomSrc[n]?.src;
    return dom && srcColorMap[dom]
      ? _hexToRgba(srcColorMap[dom], 0.62)
      : 'rgba(110,110,155,0.80)';
  });

  // ── Dynamic margins — source labels on left, target labels on right ───
  const maxSrcLen = srcNodes.reduce((mx,n) => {
    const lbl = trunc(n); const v = fmtVal(srcTotals[n]||0);
    return Math.max(mx, lbl.length + (v ? v.length+1 : 0));
  }, 0);
  const maxTgtLen = tgtNodes.reduce((mx,n) => {
    const lbl = trunc(n); const v = fmtVal(tgtTotals[n]||0);
    return Math.max(mx, lbl.length + (v ? v.length+1 : 0));
  }, 0);
  const leftMargin  = Math.max(170, maxSrcLen * 9 + 40);
  const rightMargin = Math.max(170, maxTgtLen * 9 + 40);

  delete layout.xaxis;  // MUST delete — setting to undefined causes Plotly 'anchor' crash
  delete layout.yaxis;
  layout.margin        = { t: 36, b: 36, l: leftMargin, r: rightMargin };
  layout.showlegend    = false;
  layout.font          = { color: '#ffffff', size: 12, family: 'Segoe UI, system-ui, sans-serif' };
  layout.paper_bgcolor = 'rgba(0,0,0,0)';
  layout.plot_bgcolor  = 'rgba(0,0,0,0)';

  // Pre-build link color array (flat loop — fastest)
  const linkColors = links.map(l => _hexToRgba(srcColorMap[l.src] || '#888888', 0.45));

  return [{
    type:        'sankey',
    orientation: 'h',
    arrangement: 'snap',         // 'snap' renders faster than 'freeform'
    node: {
      pad:       22,
      thickness: 28,
      line:      { color: 'rgba(255,255,255,0.25)', width: 1 },
      label:     displayLabels,
      color:     nodeColors,
      // Single template — Plotly fills %{label} and %{value} per-node (fast, no array build)
      hovertemplate: '<b>%{label}</b><br>Flow: <b>%{value:,.0f}</b><extra></extra>'
    },
    link: {
      source: links.map(l => nodeIdx[l.src]),
      target: links.map(l => nodeIdx[l.tgt]),
      value:  links.map(l => Math.max(l.val, 0.001)),
      color:  linkColors,
      // Single template — Plotly fills source/target/value automatically (fast, no array build)
      hovertemplate: '<b>%{source.label} → %{target.label}</b><br>Value: <b>%{value:,.0f}</b><extra></extra>'
    },
    textfont: { color: '#ffffff', size: 12, family: 'Segoe UI, system-ui, sans-serif' }
  }];
}

/* ── Gantt ── */
function _parseDate(val) {
  if (!val) return null;
  // Handle common formats: "2024-01-15", "01/15/2024", "Jan 15 2024", timestamps
  let d = new Date(val);
  if (!isNaN(d)) return d;
  // Try MM/DD/YYYY
  const mdy = String(val).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) d = new Date(`${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`);
  return isNaN(d) ? null : d;
}

function buildGanttTraces(spec, data, layout) {
  const taskCol  = spec.x_column;
  const startCol = spec.y_column;
  const endCol   = spec.end_column;
  const colorCol = spec.color_column;

  if (!taskCol) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  const colors = getColors();

  // ── Date-based Gantt (preferred: start + end columns) ──────────────────
  if (startCol && endCol) {
    const taskMap = {};
    data.forEach(r => {
      const task  = String(r[taskCol] ?? '').trim();
      const start = _parseDate(r[startCol]);
      const end   = _parseDate(r[endCol]);
      if (!task || !start || !end || end <= start) return;
      if (!taskMap[task]) taskMap[task] = { start, end, group: String(r[colorCol] ?? '') };
      else {
        if (start < taskMap[task].start) taskMap[task].start = start;
        if (end   > taskMap[task].end)   taskMap[task].end   = end;
      }
    });

    const entries = Object.entries(taskMap)
      .sort((a, b) => a[1].start - b[1].start)   // sort by start date ascending
      .slice(0, 35);

    if (entries.length) {
      const groups = [...new Set(entries.map(([, d]) => d.group))];

      // ── CORRECT Plotly Gantt pattern:
      //    x    = END   date (numeric ms timestamp)  ← bar's right edge
      //    base = START date (numeric ms timestamp)  ← bar's left edge
      //    xaxis.type = 'date' tells Plotly to interpret ms as dates
      const taskNames  = entries.map(([t])    => t);
      const startTimes = entries.map(([, d])  => d.start.getTime());
      const endTimes   = entries.map(([, d])  => d.end.getTime());
      const barColors  = entries.map(([, d])  => colors[groups.indexOf(d.group) % colors.length]);
      const customdata = entries.map(([task, d]) => [
        d.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        d.end.toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' }),
        Math.round((d.end - d.start) / 86400000)
      ]);

      layout.xaxis = {
        type: 'date',
        tickformat: '%b %d, %Y',
        tickfont: { color: '#94a3b8', size: 10 },
        gridcolor: '#2e2e50',
        zerolinecolor: '#2e2e50',
        tickangle: -30
      };
      layout.yaxis = {
        autorange:  'reversed',
        tickfont:   { color: '#e2e8f0', size: 10 },
        gridcolor:  '#2e2e50'
      };
      layout.margin     = { t: 20, b: 80, l: 200, r: 30 };
      layout.showlegend = false;
      layout.bargap     = 0.35;

      return [{
        type: 'bar',
        orientation: 'h',
        x:          endTimes,
        y:          taskNames,
        base:       startTimes,
        customdata,
        marker:     { color: barColors, opacity: 0.85 },
        hovertemplate: '<b>%{y}</b><br>Start: %{customdata[0]}<br>End: %{customdata[1]}<br>Duration: %{customdata[2]} days<extra></extra>',
        showlegend: false
      }];
    }
  }

  // ── Start-only Gantt: milestone scatter on date axis ──────────────────
  if (startCol) {
    const taskMap2 = {};
    data.forEach(r => {
      const task  = String(r[taskCol] ?? '').trim();
      const start = _parseDate(r[startCol]);
      if (!task || !start) return;
      if (!taskMap2[task] || start < taskMap2[task]) taskMap2[task] = start;
    });
    const entries2 = Object.entries(taskMap2)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 30);
    if (entries2.length) {
      layout.xaxis      = { type: 'date', tickformat: '%b %Y', gridcolor: '#2e2e50' };
      layout.yaxis      = { autorange: 'reversed', tickfont: { color: '#e2e8f0', size: 10 } };
      layout.margin     = { t: 10, b: 60, l: 200, r: 30 };
      layout.showlegend = false;
      return [{
        type: 'scatter', mode: 'markers',
        x: entries2.map(([, d]) => d.getTime()),
        y: entries2.map(([t])   => t),
        marker: { color: colors[0], size: 12, symbol: 'diamond' },
        hovertemplate: '<b>%{y}</b><br>%{x|%b %d, %Y}<extra></extra>'
      }];
    }
  }

  // Last resort: aggregate data as horizontal bar
  if (startCol) {
    const entries3 = aggregateData(data, taskCol, startCol, 'sum').slice(0, 20);
    layout.yaxis  = { ...getBaseLayout().yaxis, autorange: 'reversed' };
    layout.margin = { t: 10, b: 60, l: 160, r: 20 };
    return [{
      type: 'bar', orientation: 'h',
      x: entries3.map(e => e.y),
      y: entries3.map(e => e.x),
      marker: { color: colors[0], opacity: 0.85 },
      hovertemplate: '%{y}: %{x:,.0f}<extra></extra>'
    }];
  }

  // No usable date column — show a friendly message instead of silent bar fallback
  layout.annotations = [{
    text: startCol
      ? 'No parseable dates found in the start column'
      : 'Gantt chart requires a date column (Start Date / End Date)',
    showarrow: false,
    font: { color: '#94a3b8', size: 13 },
    xref: 'paper', yref: 'paper', x: 0.5, y: 0.5
  }];
  delete layout.xaxis; delete layout.yaxis;
  return [{ type: 'scatter', x: [], y: [], showlegend: false }];
}

/* ── Bullet ── */
function buildBulletTraces(spec, data, layout) {
  const catCol    = spec.x_column;
  const actualCol = spec.y_column;
  const targetCol = spec.target_column;
  const agg       = spec.aggregation || 'sum';

  if (!actualCol && !catCol) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  const aggFn = vals => {
    if (!vals.length) return 0;
    if (agg === 'mean')  return vals.reduce((s, v) => s + v, 0) / vals.length;
    if (agg === 'count') return vals.length;
    if (agg === 'max')   return Math.max(...vals);
    if (agg === 'min')   return Math.min(...vals);
    return vals.reduce((s, v) => s + v, 0);
  };

  // Group by category
  const grouped = {};
  data.forEach(r => {
    const cat = catCol ? String(r[catCol] ?? 'Total').trim() : 'Total';
    if (!cat) return;
    if (!grouped[cat]) grouped[cat] = { actual: [], target: [] };
    if (actualCol && r[actualCol] != null) grouped[cat].actual.push(Number(r[actualCol]) || 0);
    if (targetCol && r[targetCol] != null) grouped[cat].target.push(Number(r[targetCol]) || 0);
  });

  const cats    = Object.keys(grouped).slice(0, 20);
  const actuals = cats.map(c => aggFn(grouped[c].actual));
  const targets = cats.map(c => grouped[c].target.length ? aggFn(grouped[c].target) : null);
  const maxVal  = Math.max(...actuals, ...targets.filter(t => t != null), 1) * 1.25;
  const colors  = getColors();

  layout.barmode  = 'overlay';
  layout.xaxis    = { ...getBaseLayout().xaxis, range: [0, maxVal] };
  layout.margin   = { t: 10, b: 60, l: 160, r: 20 };

  const traces = [
    // Full-width background (max range)
    { type: 'bar', orientation: 'h',
      x: cats.map(() => maxVal), y: cats,
      marker: { color: 'rgba(255,255,255,0.06)' },
      showlegend: false, hoverinfo: 'skip', name: '' },
    // Comparative range (~80% of max)
    { type: 'bar', orientation: 'h',
      x: cats.map(() => maxVal * 0.8), y: cats,
      marker: { color: 'rgba(255,255,255,0.10)' },
      showlegend: false, hoverinfo: 'skip', name: '' },
    // Actual value bar (narrow, bold)
    { type: 'bar', orientation: 'h',
      x: actuals, y: cats,
      name: actualCol || 'Actual',
      marker: { color: colors[0], opacity: 0.95 },
      hovertemplate: `<b>%{y}</b><br>${actualCol || 'Actual'}: %{x:,.2f}<extra></extra>` }
  ];

  // Target markers as diamond scatter
  if (targets.some(t => t != null)) {
    traces.push({
      type: 'scatter', mode: 'markers',
      x: targets, y: cats,
      name: targetCol || 'Target',
      marker: { color: '#f59e0b', symbol: 'line-ew-open', size: 18, line: { color: '#f59e0b', width: 3 } },
      hovertemplate: `<b>%{y}</b><br>${targetCol || 'Target'}: %{x:,.2f}<extra></extra>`
    });
  }

  return traces;
}

/* ── Pie / Donut ── */
function buildPieTraces(spec, data, layout) {
  const colors = getColors();
  let entries = aggregateData(data, spec.x_column, spec.y_column, spec.aggregation || 'sum');
  entries = sortAndLimit(entries, spec);

  layout.margin = { t: 10, b: 10, l: 10, r: 10 };

  return [{
    type: 'pie',
    labels: entries.map(e => e.x),
    values: entries.map(e => e.y),
    hole: spec.type === 'donut' ? 0.42 : 0,
    marker: { colors },
    textinfo: 'label+percent',
    textfont: { color: '#e2e8f0', size: 11 }
  }];
}

/* ── Treemap ── */
function buildTreemapTraces(spec, data, layout) {
  layout.margin = { t: 10, b: 10, l: 10, r: 10 };

  /* ── Two-level hierarchy: x_column = group, color_column = sub-group ── */
  if (spec.color_column && spec.x_column) {
    const parentCol = spec.x_column;
    const childCol  = spec.color_column;
    const valCol    = spec.y_column;
    const agg       = spec.aggregation || 'sum';

    // Accumulate (parent, child) → aggregated value
    const pairMap     = new Map(); // "parent|||child" → value
    const pairCount   = new Map(); // for count aggregation
    const parentTotals = new Map();

    for (const row of data) {
      const p = row[parentCol] != null ? String(row[parentCol]) : null;
      const c = row[childCol]  != null ? String(row[childCol])  : null;
      if (!p || !c) continue;
      const key = `${p}|||${c}`;
      const v = valCol ? (Number(row[valCol]) || 0) : 1;
      pairMap.set(key,   (pairMap.get(key)   || 0) + (agg === 'count' ? 1 : v));
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }

    // Compute parent totals as sum of their children
    for (const [key, val] of pairMap) {
      const p = key.split('|||')[0];
      parentTotals.set(p, (parentTotals.get(p) || 0) + val);
    }

    const ids      = [];
    const labels   = [];
    const parents  = [];
    const values   = [];

    // Level 1 — parent nodes (groups)
    for (const [p, total] of parentTotals) {
      ids.push(p);
      labels.push(p);
      parents.push('');
      values.push(total);
    }

    // Level 2 — child nodes (sub-groups under each parent)
    for (const [key, val] of pairMap) {
      const [p, c] = key.split('|||');
      ids.push(`${p}__${c}`);   // unique ID (display label may repeat across parents)
      labels.push(c);
      parents.push(p);
      const childVal = agg === 'mean' ? val / (pairCount.get(key) || 1) : val;
      values.push(childVal > 0 ? childVal : 0.001); // Plotly needs positive values
    }

    // For mean agg: parent values must also be mean (not sum) to keep branchvalues consistent
    if (agg === 'mean') {
      for (let i = 0; i < parentTotals.size; i++) {
        const p = ids[i]; // parent ids are first
        // Recalculate parent value as average of its children's means
        const childIndices = ids.map((id, idx) => parents[idx] === p ? idx : -1).filter(idx => idx >= 0);
        if (childIndices.length) {
          values[i] = childIndices.reduce((s, idx) => s + values[idx], 0) / childIndices.length;
        }
      }
    }

    const allVals   = values.filter(v => v > 0);
    const colorMin  = allVals.length ? Math.min(...allVals) : 0;
    const colorMax  = allVals.length ? Math.max(...allVals) : 1;

    return [{
      type: 'treemap',
      ids, labels, parents, values,
      branchvalues: agg === 'mean' ? 'remainder' : 'total',
      textinfo:  'label+value+percent parent',
      hovertemplate: '<b>%{label}</b><br>%{value:,.0f}<br>%{percentParent:.1%} of %{parent}<extra></extra>',
      marker: {
        colors:     values,
        colorscale: getColorScale(spec.color_scheme || 'Viridis'),
        cmin: colorMin, cmax: colorMax,
        showscale: true,
        colorbar:  { thickness: 10, tickfont: { color: '#94a3b8', size: 10 } }
      },
      textfont:{ color: '#fff', size: 12 }
    }];
  }

  /* ── Flat (single-level) treemap ── */
  let entries = aggregateData(data, spec.x_column, spec.y_column, spec.aggregation || 'sum');
  if (spec.top_n) entries = entries.slice(0, spec.top_n);

  // Plotly treemap requires strictly positive values — filter zeros/negatives
  entries = entries.filter(e => typeof e.y === 'number' && e.y > 0);
  if (!entries.length) {
    // Fallback: count per category when aggregated values are all zero/missing
    entries = aggregateData(data, spec.x_column, null, 'count').filter(e => e.y > 0);
  }

  console.log('[treemap] spec:', spec.type, 'x:', spec.x_column, 'y:', spec.y_column,
              'agg:', spec.aggregation, 'entries:', entries.length);

  const vals   = entries.map(e => e.y);
  const minVal = Math.min(...vals);
  const maxVal = Math.max(...vals);

  return [{
    type: 'treemap',
    labels:      entries.map(e => String(e.x)),
    values:      vals,
    parents:     entries.map(() => ''),
    textinfo:    'label+value+percent root',
    hovertemplate: '<b>%{label}</b><br>Value: %{value:,.0f}<br>%{percentRoot:.1%} of total<extra></extra>',
    marker: {
      colors:     vals,
      colorscale: getColorScale(spec.color_scheme || 'Viridis'),
      cmin:       minVal,
      cmax:       maxVal,
      showscale:  true,
      colorbar:   { thickness: 10, tickfont: { color: '#94a3b8', size: 10 } }
    },
    textfont: { color: '#fff', size: 13 }
  }];
}

/* ── Icicle (Hierarchy Tree / Org Chart) ── */
function buildIcicleTraces(spec, data, layout) {
  layout.margin = { t: 30, b: 10, l: 10, r: 10 };

  const parentCol  = spec.x_column;
  const childCol   = spec.color_column;   // optional second level (sub-group)
  const valCol     = spec.y_column;
  const agg        = spec.aggregation || 'sum';
  const colorScale = getColorScale(spec.color_scheme || 'Blues');

  if (!parentCol) {
    layout.annotations = [{ text: 'Hierarchy tree requires a category column',
      showarrow: false, font: { color: '#94a3b8', size: 14 },
      xref: 'paper', yref: 'paper', x: 0.5, y: 0.5 }];
    return [{ type: 'scatter', x: [], y: [], showlegend: false }];
  }

  // ── Two-level: parentCol → childCol hierarchy ────────────────────────────
  if (childCol && childCol !== parentCol) {
    const pairSum   = new Map();   // "p|||c" → aggregated value
    const pairCount = new Map();   // "p|||c" → row count (for mean)
    const parentSum = new Map();   // parent → total of children (sum, not mean)

    for (const row of data) {
      const p = row[parentCol] != null ? String(row[parentCol]) : null;
      const c = row[childCol]  != null ? String(row[childCol])  : null;
      if (!p || !c) continue;
      const key = `${p}|||${c}`;
      const v   = (valCol ? (Number(row[valCol]) || 0) : 1);
      // Always accumulate raw sum (used for branchvalues:'total' parent sizing)
      pairSum.set(key,   (pairSum.get(key)   || 0) + v);
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }
    // Parent values = sum of raw child values (needed for branchvalues:'total')
    for (const [key, s] of pairSum)
      parentSum.set(key.split('|||')[0], (parentSum.get(key.split('|||')[0]) || 0) + s);

    const grandTotal = [...parentSum.values()].reduce((a, b) => a + b, 0);
    if (grandTotal <= 0) {
      layout.annotations = [{ text: 'No positive values to display',
        showarrow: false, font: { color: '#94a3b8', size: 14 },
        xref: 'paper', yref: 'paper', x: 0.5, y: 0.5 }];
      return [{ type: 'scatter', x: [], y: [], showlegend: false }];
    }

    const ids = [], labels = [], parents = [], values = [], colors = [];

    // Root (hidden anchor — value = grand total for branchvalues:'total')
    ids.push('__root__'); labels.push('All'); parents.push(''); values.push(grandTotal); colors.push(grandTotal);

    // Level 1 — parent nodes (value = sum of their children)
    for (const [p, tot] of parentSum) {
      ids.push(p); labels.push(p); parents.push('__root__');
      values.push(tot); colors.push(tot);
    }
    // Level 2 — leaf nodes
    for (const [key, rawSum] of pairSum) {
      const [p, c] = key.split('|||');
      const leafVal = agg === 'mean'
        ? rawSum / (pairCount.get(key) || 1)
        : (agg === 'count' ? pairCount.get(key) : rawSum);
      ids.push(`${p}__${c}`); labels.push(c); parents.push(p);
      values.push(Math.max(leafVal, 0.001)); colors.push(leafVal);
    }

    const leafColors = colors.slice(1 + parentSum.size).filter(v => v > 0);
    const cMin = leafColors.length ? Math.min(...leafColors) : 0;
    const cMax = leafColors.length ? Math.max(...leafColors) : 1;

    return [{
      type: 'icicle',
      ids, labels, parents, values,
      branchvalues: 'total',
      tiling: { orientation: 'v', pad: 3 },
      textinfo: 'label+percent parent',
      hovertemplate: '<b>%{label}</b><br>Value: %{value:,.0f}<br>%{percentParent:.1%} of %{parent}<extra></extra>',
      root: { color: 'rgba(30,41,59,0.6)' },
      marker: {
        colors, colorscale: colorScale,
        cmin: cMin, cmax: cMax,
        showscale: true,
        colorbar: { thickness: 10, tickfont: { color: '#94a3b8', size: 10 } }
      },
      pathbar: { visible: true, side: 'top', thickness: 22,
                 textfont: { color: '#e2e8f0', size: 11 } },
      textfont: { color: '#fff', size: 11 }
    }];
  }

  // ── Single-level: flat icicle ────────────────────────────────────────────
  let entries = aggregateData(data, parentCol, valCol, agg);
  if (spec.top_n) entries = entries.slice(0, spec.top_n);
  entries = entries.filter(e => typeof e.y === 'number' && e.y > 0);
  if (!entries.length) {
    // Fallback: count per category
    entries = aggregateData(data, parentCol, null, 'count').filter(e => e.y > 0);
  }
  if (!entries.length) {
    layout.annotations = [{ text: 'No data to display',
      showarrow: false, font: { color: '#94a3b8', size: 14 },
      xref: 'paper', yref: 'paper', x: 0.5, y: 0.5 }];
    return [{ type: 'scatter', x: [], y: [], showlegend: false }];
  }

  const total  = entries.reduce((s, e) => s + e.y, 0);
  const vals   = entries.map(e => e.y);
  const minVal = Math.min(...vals);
  const maxVal = Math.max(...vals);

  const ids = [], labels = [], parents = [], values = [], colors = [];

  // Root node — value MUST equal sum of children for branchvalues:'total'
  ids.push('__root__'); labels.push('All'); parents.push(''); values.push(total); colors.push(total);
  entries.forEach(e => {
    ids.push(String(e.x)); labels.push(String(e.x));
    parents.push('__root__'); values.push(e.y); colors.push(e.y);
  });

  return [{
    type: 'icicle',
    ids, labels, parents, values,
    branchvalues: 'total',
    tiling: { orientation: 'v', pad: 3 },
    textinfo: 'label+value+percent root',
    hovertemplate: '<b>%{label}</b><br>Value: %{value:,.0f}<br>%{percentRoot:.1%} of total<extra></extra>',
    root: { color: 'rgba(30,41,59,0.6)' },
    marker: {
      colors, colorscale: colorScale,
      cmin: minVal, cmax: maxVal,
      showscale: true,
      colorbar: { thickness: 10, tickfont: { color: '#94a3b8', size: 10 } }
    },
    pathbar: { visible: true, side: 'top', thickness: 22,
               textfont: { color: '#e2e8f0', size: 11 } },
    textfont: { color: '#fff', size: 11 }
  }];
}

/* ── Sunburst ── */
function buildSunburstTraces(spec, data, layout) {
  layout.margin = { t: 10, b: 10, l: 10, r: 10 };

  const parentCol = spec.x_column;
  const childCol  = spec.color_column;   // second level (depth)
  const valCol    = spec.y_column;
  const agg       = spec.aggregation || 'sum';

  if (!parentCol) return buildPieTraces(spec, data, layout);  // fallback

  /* ── Two-level sunburst (parent → child) ── */
  if (childCol) {
    const pairMap    = new Map();
    const pairCount  = new Map();
    const parentTots = new Map();

    for (const row of data) {
      const p = row[parentCol] != null ? String(row[parentCol]) : null;
      const c = row[childCol]  != null ? String(row[childCol])  : null;
      if (!p || !c) continue;
      const key = `${p}|||${c}`;
      const v = valCol ? (Number(row[valCol]) || 0) : 1;
      pairMap.set(key,   (pairMap.get(key)   || 0) + (agg === 'count' ? 1 : v));
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }
    for (const [key, val] of pairMap) {
      const p = key.split('|||')[0];
      parentTots.set(p, (parentTots.get(p) || 0) + val);
    }

    const ids = [], labels = [], parents = [], values = [];

    for (const [p, total] of parentTots) {
      ids.push(p); labels.push(p); parents.push(''); values.push(total);
    }
    for (const [key, val] of pairMap) {
      const [p, c] = key.split('|||');
      const childVal = agg === 'mean' ? val / (pairCount.get(key) || 1) : val;
      ids.push(`${p}__${c}`); labels.push(c); parents.push(p);
      values.push(childVal > 0 ? childVal : 0.001);
    }

    return [{
      type: 'sunburst',
      ids, labels, parents, values,
      branchvalues: 'total',
      textinfo: 'label+percent parent',
      hovertemplate: '<b>%{label}</b><br>%{value:,.0f}<br>%{percentParent:.1%} of %{parent}<extra></extra>',
      marker: {
        colors: values,
        colorscale: getColorScale(spec.color_scheme || 'Portland'),
        showscale: false
      },
      leaf: { opacity: 0.85 },
      textfont: { color: '#fff', size: 11 }
    }];
  }

  /* ── Single-level sunburst ── */
  let entries = aggregateData(data, parentCol, valCol, agg);
  if (spec.top_n) entries = entries.slice(0, spec.top_n);
  entries = entries.filter(e => typeof e.y === 'number' && e.y > 0);
  if (!entries.length) entries = aggregateData(data, parentCol, null, 'count').filter(e => e.y > 0);

  const colors = getColors();
  return [{
    type: 'sunburst',
    ids:     entries.map(e => String(e.x)),
    labels:  entries.map(e => String(e.x)),
    parents: entries.map(() => ''),
    values:  entries.map(e => Math.max(e.y, 0.001)),
    textinfo: 'label+percent root',
    hovertemplate: '<b>%{label}</b><br>%{value:,.0f}<br>%{percentRoot:.1%} of total<extra></extra>',
    marker: { colors: entries.map((_, i) => colors[i % colors.length]), line: { width: 1, color: 'rgba(255,255,255,0.2)' } },
    leaf: { opacity: 0.85 },
    textfont: { color: '#fff', size: 11 }
  }];
}

/* ── Funnel ── */
function buildFunnelTraces(spec, data) {
  let entries = aggregateData(data, spec.x_column, spec.y_column, spec.aggregation || 'sum');
  entries.sort((a, b) => b.y - a.y);

  return [{
    type: 'funnel',
    y:      entries.map(e => e.x),
    x:      entries.map(e => e.y),
    marker: { color: getColors() },
    textinfo: 'value+percent initial'
  }];
}

/* ── Scatter ── */
function buildScatterTraces(spec, data) {
  const colors = getColors();

  if (spec.color_column) {
    const cats = [...new Set(data.map(r => r[spec.color_column]))];
    return cats.map((cat, i) => {
      const sub = data.filter(r => r[spec.color_column] === cat);
      return {
        type: 'scatter', mode: 'markers', name: String(cat),
        x: sub.map(r => r[spec.x_column]),
        y: sub.map(r => Number(r[spec.y_column])),
        marker: { size: 8, color: colors[i % colors.length], opacity: 0.75,
                  line: { width: 0.5, color: 'rgba(255,255,255,0.2)' } }
      };
    });
  }

  return [{
    type: 'scatter', mode: 'markers',
    x: data.map(r => r[spec.x_column]),
    y: data.map(r => Number(r[spec.y_column])),
    marker: { size: 8, color: colors[0], opacity: 0.75 }
  }];
}

/* ── Histogram ── */
function buildHistogramTraces(spec, data, layout) {
  const colors = getColors();
  layout.bargap = 0.05;

  return [{
    type: 'histogram',
    x: data.map(r => Number(r[spec.x_column])).filter(n => !isNaN(n)),
    marker: { color: colors[0], opacity: 0.85 },
    nbinsx: AppState.config?.ui?.histogramBins ?? 25
  }];
}

/* ── Box Plot ── */
function buildBoxTraces(spec, data) {
  const colors = getColors();

  if (spec.x_column && spec.y_column) {
    const cats = [...new Set(data.map(r => r[spec.x_column]))];
    return cats.map((cat, i) => ({
      type: 'box', name: String(cat),
      y: data.filter(r => r[spec.x_column] === cat).map(r => Number(r[spec.y_column])),
      marker: { color: colors[i % colors.length] },
      line:   { color: colors[i % colors.length] },
      boxmean: true
    }));
  }

  return [{
    type: 'box', name: spec.y_column,
    y: data.map(r => Number(r[spec.y_column])).filter(n => !isNaN(n)),
    marker: { color: colors[0] }, boxmean: true
  }];
}

/* ── Marimekko (Mosaic) Chart ── */
function buildMarimekkoTraces(spec, data, layout) {
  const xCol     = spec.x_column;
  const colorCol = spec.color_column;
  const valCol   = spec.y_column;
  const colors   = getColors();

  if (!xCol) return buildBarLineAreaTraces({ ...spec, type: 'bar' }, data, layout);

  // Aggregate: grid[xCat][colorCat] = sum of valCol (or count)
  const xOrder = [], xSeen = {}, colorOrder = [], colorSeen = {};
  const grid = {}, totByX = {};

  data.forEach(r => {
    const xv = String(r[xCol] ?? ''); if (!xv) return;
    const cv = colorCol ? String(r[colorCol] ?? '') : 'Total';
    const n  = valCol ? Number(r[valCol]) : 1;
    if (!xSeen[xv])    { xSeen[xv] = true;    xOrder.push(xv); }
    if (!colorSeen[cv]){ colorSeen[cv] = true; colorOrder.push(cv); }
    if (!grid[xv]) grid[xv] = {};
    grid[xv][cv]   = (grid[xv][cv]   || 0) + (isNaN(n) ? 1 : n);
    totByX[xv]     = (totByX[xv]     || 0) + (isNaN(n) ? 1 : n);
  });

  const grand = Object.values(totByX).reduce((a, b) => a + b, 0) || 1;

  // Column positions (x axis = cumulative % of grand total)
  const xInfo = {};
  let cumX = 0;
  xOrder.forEach(xv => {
    const share = (totByX[xv] || 0) / grand * 100;
    xInfo[xv] = { center: cumX + share / 2, width: share };
    cumX += share;
  });

  // Build one bar trace per color category; manually stack via `base`
  const cumHeights = {}; // track stacked height per xCat
  xOrder.forEach(xv => { cumHeights[xv] = 0; });

  const traces = colorOrder.map((cv, ci) => {
    const xs = [], ys = [], bases = [], ws = [], texts = [];
    xOrder.forEach(xv => {
      const xTotal = totByX[xv] || 1;
      const cellV  = (grid[xv] && grid[xv][cv]) || 0;
      const pct    = cellV / xTotal * 100;
      xs.push(xInfo[xv].center);
      ys.push(pct);
      bases.push(cumHeights[xv]);
      ws.push(Math.max(0.2, xInfo[xv].width * 0.97));
      texts.push(`<b>${xv}</b><br>${cv}: ${shortNumber(cellV)} (${pct.toFixed(1)}%)`);
      cumHeights[xv] += pct;
    });
    return {
      type: 'bar', name: cv, x: xs, y: ys, base: bases, width: ws,
      text: texts, hoverinfo: 'text', textposition: 'inside',
      textfont: { size: 9, color: '#fff' },
      marker: { color: colors[ci % colors.length], line: { color: '#0f0f1a', width: 0.6 } }
    };
  });

  // Custom x-axis tick labels showing category name + share %
  layout.xaxis = {
    tickvals: xOrder.map(xv => xInfo[xv].center),
    ticktext: xOrder.map(xv => `${xv} (${((totByX[xv]||0)/grand*100).toFixed(1)}%)`),
    gridcolor: '#2e2e50', tickfont: { color: '#94a3b8', size: 10 },
    range: [0, 100], showgrid: false
  };
  layout.yaxis  = { title: 'Share %', range: [0, 105], gridcolor: '#2e2e50',
                    tickfont: { color: '#94a3b8', size: 11 }, ticksuffix: '%' };
  layout.barmode = 'overlay';
  layout.showlegend = true;
  layout.margin  = { t: 10, b: 80, l: 60, r: 20 };

  return traces;
}

/* ── Heatmap ── */
function buildHeatmapTraces(spec, data, layout) {
  // Auto-heal missing columns using AppState if available
  if (!spec.x_column || !spec.y_column) {
    const cols    = (AppState && AppState.columns) ? AppState.columns : Object.keys(data[0] || {});
    const types   = (AppState && AppState.colTypes) ? AppState.colTypes : {};
    const strCols = cols.filter(c => types[c] !== 'number');
    if (!spec.x_column) spec = { ...spec, x_column: strCols[0] || cols[0] };
    if (!spec.y_column) spec = { ...spec, y_column: strCols.find(c => c !== spec.x_column) || strCols[0] || cols[1] || cols[0] };
  }

  if (!spec.x_column || !spec.y_column) {
    layout.annotations = [{ text: 'Heatmap needs two categorical / date columns', showarrow: false,
      font: { color: '#94a3b8', size: 14 }, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5 }];
    delete layout.xaxis; delete layout.yaxis;
    return [{ type: 'scatter', x: [], y: [], showlegend: false }];
  }

  const MAX_CATS = 40;   // cap to prevent giant matrices freezing the browser

  // Get sorted unique values, capped at MAX_CATS
  const allX = [...new Set(data.map(r => String(r[spec.x_column] ?? '(blank)')))].sort();
  const allY = [...new Set(data.map(r => String(r[spec.y_column] ?? '(blank)')))].sort();
  const xVals = allX.slice(0, MAX_CATS);
  const yVals = allY.slice(0, MAX_CATS);

  // Build cell index for O(n) aggregation instead of O(n*m) filter
  const valCol = spec.value_column || spec.z_column || null;
  const useSum = valCol && data.some(r => r[valCol] != null);
  const agg    = spec.aggregation === 'mean' ? 'mean' : 'sum';

  const xSet = new Set(xVals);
  const ySet = new Set(yVals);

  // cellMap[yv][xv] = { sum, count }
  const cellMap = {};
  yVals.forEach(yv => { cellMap[yv] = {}; xVals.forEach(xv => { cellMap[yv][xv] = { sum: 0, count: 0 }; }); });

  data.forEach(r => {
    const xv = String(r[spec.x_column] ?? '(blank)');
    const yv = String(r[spec.y_column] ?? '(blank)');
    if (!xSet.has(xv) || !ySet.has(yv)) return;
    const cell = cellMap[yv][xv];
    cell.count++;
    if (useSum) cell.sum += Number(r[valCol]) || 0;
  });

  const z = yVals.map(yv =>
    xVals.map(xv => {
      const cell = cellMap[yv][xv];
      if (!useSum)      return cell.count;
      if (agg === 'mean') return cell.count ? cell.sum / cell.count : 0;
      return cell.sum;
    })
  );

  layout.margin.b = 90;
  layout.margin.l = 110;
  // Remove number format from axes — heatmap axes are categorical
  delete layout.xaxis.tickformat;
  delete layout.yaxis.tickformat;
  layout.xaxis.tickangle = -35;

  const cappedNote = (allX.length > MAX_CATS || allY.length > MAX_CATS)
    ? ` (top ${MAX_CATS} shown)` : '';
  const zLabel = useSum ? (valCol || 'Value') : 'Count';

  return [{
    type: 'heatmap', x: xVals, y: yVals, z,
    colorscale: getColorScale(spec.color_scheme || 'YlOrRd'),
    hoverongaps: false,
    hovertemplate: `<b>%{x}</b> × <b>%{y}</b><br>${zLabel}: <b>%{z:,.0f}</b>${cappedNote}<extra></extra>`,
    showscale: true
  }];
}

/* ── Data table renderer ── */

/* ── Button Slicer ── */
function renderButtonSlicer(spec, el) {
  const col    = spec.x_column;
  if (!col) { el.innerHTML = '<div class="chart-error">Slicer requires x_column</div>'; return; }

  /* Always show ALL unique values from the raw dataset so you can always re-select */
  const allRows = AppState.rawData || [];
  const values  = [...new Set(allRows.map(r => r[col]).filter(v => v != null && v !== ''))]
                    .sort((a, b) => String(a).localeCompare(String(b)));
  const selected = new Set(Array.isArray(AppState.filters[col]) ? AppState.filters[col] : []);
  const allActive = selected.size === 0;

  /* "All" clear button + one button per unique value */
  const allBtn = `<button class="slicer-btn${allActive ? ' active' : ''}" data-val="__all__">All</button>`;
  const valBtns = values.map(v => {
    const vs = String(v);
    return `<button class="slicer-btn${selected.has(vs) ? ' active' : ''}" data-val="${escAttr(vs)}">${vs}</button>`;
  }).join('');

  el.style.cssText = '';
  el.innerHTML = `<div class="slicer-btn-wrap" data-slicer-col="${escAttr(col)}" onclick="handleSlicerClick(this,event)">${allBtn}${valBtns}</div>`;
}

/* ── Multi-Row Card ── */
function renderMultiRowCard(spec, data, el) {
  const groupCol = spec.x_column;
  const colors   = getColors();

  /* Build metrics list — from spec.metrics[] if present, otherwise infer from y_column */
  let metrics = Array.isArray(spec.metrics) && spec.metrics.length ? spec.metrics : null;
  if (!metrics) {
    /* Fallback: build default metrics from y_column */
    const yCol = spec.y_column;
    const agg  = spec.aggregation || 'sum';
    metrics = [];
    metrics.push({ label: 'Count', column: null, aggregation: 'count', format: 'number' });
    if (yCol) {
      metrics.push({ label: `Total ${yCol}`, column: yCol, aggregation: 'sum',  format: 'currency' });
      metrics.push({ label: `Avg ${yCol}`,   column: yCol, aggregation: 'mean', format: 'currency' });
    }
  }

  /* Compute a single metric value for a set of rows */
  const computeMetric = (rows, m) => {
    const agg = m.aggregation;
    const col = m.column;

    /* Row count — no column needed */
    if (agg === 'count' || !col) return rows.length;

    /* Distinct count — works on any column type */
    if (agg === 'count_distinct') {
      return new Set(rows.map(r => r[col]).filter(v => v != null && v !== '')).size;
    }

    /* Date columns: min/max compare as strings (ISO dates sort lexicographically) */
    const isDateCol = AppState?.colTypes?.[col] === 'date';
    if (isDateCol) {
      const vals = rows.map(r => r[col]).filter(v => v != null && v !== '');
      if (!vals.length) return null;
      if (agg === 'min') return vals.reduce((a, b) => (a < b ? a : b));
      if (agg === 'max') return vals.reduce((a, b) => (a > b ? a : b));
      /* count / count_distinct handled above; anything else on a date → count */
      return vals.length;
    }

    /* Numeric aggregations — use toNum() so comma-formatted values like "72,000" parse correctly */
    const nums = rows.map(r => toNum(r[col])).filter(n => !isNaN(n));
    if (!nums.length) return 0;
    switch (agg) {
      case 'sum':    return nums.reduce((s, v) => s + v, 0);
      case 'mean':   return nums.reduce((s, v) => s + v, 0) / nums.length;
      case 'median': { const s = [...nums].sort((a,b)=>a-b); const mid=Math.floor(s.length/2); return s.length%2?s[mid]:(s[mid-1]+s[mid])/2; }
      case 'max':    return Math.max(...nums);
      case 'min':    return Math.min(...nums);
      default:       return nums.reduce((s, v) => s + v, 0);
    }
  };

  /* Format a computed value for display */
  const fmtVal = (v, fmt) => {
    if (v === null || v === undefined) return '—';

    /* Date string (ISO format) — format as readable date */
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      try {
        return new Date(v + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      } catch { return v; }
    }

    /* Non-numeric string (e.g. if column value itself is the result) */
    const n = Number(v);
    if (isNaN(n)) return String(v);

    if (fmt === 'currency')   return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (fmt === 'percentage') return (n * 100).toFixed(1) + '%';
    /* Integer vs decimal */
    return Number.isInteger(n)
      ? n.toLocaleString('en-US')
      : n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  /* Groups to display */
  const groups = groupCol
    ? [...new Set(data.map(r => r[groupCol]).filter(v => v != null && v !== ''))].sort()
    : ['(All)'];

  el.style.cssText = '';   // let table-card CSS handle layout

  /* Header */
  const headerCells = [
    `<th class="mrc-th mrc-th-group">${groupCol || ''}</th>`,
    ...metrics.map((m, i) =>
      `<th class="mrc-th mrc-th-metric" style="border-top:3px solid ${colors[i % colors.length]}">${m.label}</th>`
    )
  ].join('');

  /* Body rows */
  const bodyRows = groups.map((grp, gi) => {
    const rows = groupCol ? data.filter(r => r[groupCol] === grp) : data;
    const metricCells = metrics.map((m, i) => {
      const val = computeMetric(rows, m);
      return `<td class="mrc-td mrc-td-metric">
        <span class="mrc-dot" style="background:${colors[i % colors.length]}"></span>
        <span class="mrc-num">${fmtVal(val, m.format)}</span>
      </td>`;
    }).join('');
    return `<tr class="mrc-row${gi % 2 === 1 ? ' mrc-alt' : ''}">
      <td class="mrc-td mrc-td-group">${grp}</td>
      ${metricCells}
    </tr>`;
  }).join('');

  /* Total row */
  const totalCells = metrics.map((m, i) => {
    const val = computeMetric(data, m);
    return `<td class="mrc-td mrc-td-total">
      <span class="mrc-dot" style="background:${colors[i % colors.length]}"></span>
      <span class="mrc-num">${fmtVal(val, m.format)}</span>
    </td>`;
  }).join('');

  el.innerHTML = `
    <div class="mrc-wrap">
      <table class="mrc-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>
          ${bodyRows}
          <tr class="mrc-row mrc-total-row">
            <td class="mrc-td mrc-td-group mrc-total-label">Total</td>
            ${totalCells}
          </tr>
        </tbody>
      </table>
    </div>`;
}

function renderTableChart(spec, data, el) {
  // Resolve columns: spec.columns array → fallback to x/y columns → fallback to all AppState columns (up to 8)
  let cols = [];
  if (Array.isArray(spec.columns) && spec.columns.length) {
    cols = spec.columns.filter(c => AppState.columns.includes(c));
    // If Claude used slightly wrong names, try case-insensitive match
    if (!cols.length) {
      cols = spec.columns.map(c =>
        AppState.columns.find(ac => ac.toLowerCase() === c.toLowerCase()) || c
      ).filter(c => AppState.columns.includes(c));
    }
  }
  if (!cols.length && spec.x_column) cols = [spec.x_column, spec.y_column].filter(Boolean);
  if (!cols.length) cols = AppState.columns.slice(0, 8);

  const maxRows = spec.top_n || 200;
  const rows    = data.slice(0, maxRows);

  el.style.cssText = '';  // let CSS handle positioning — .table-card .plotly-chart rules apply

  let thead = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
  let tbody = rows.map(r =>
    `<tr>${cols.map(c => {
      const v = r[c] ?? '';
      const isNum = AppState.colTypes[c] === 'number';
      const display = (isNum && typeof v === 'number') ? v.toLocaleString() : v;
      return `<td class="${isNum ? 'n' : ''}">${display}</td>`;
    }).join('')}</tr>`
  ).join('');

  el.innerHTML = `
    <div class="dt-wrap">
      <table class="dt-table">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
      <div class="dt-footer">Showing ${rows.length.toLocaleString()} of ${data.length.toLocaleString()} rows</div>
    </div>`;
}

/* ── Matrix / pivot table ── */
function renderMatrixChart(spec, data, el) {
  const rowCol = spec.x_column;
  const colCol = spec.color_column;   // column dimension
  const valCol = spec.y_column;
  const agg    = spec.aggregation || 'count';

  // No column dimension → fall back to flat table
  if (!rowCol || !colCol) { renderTableChart(spec, data, el); return; }

  const rowVals = [...new Set(data.map(r => String(r[rowCol] ?? '(blank)')))].sort();
  const colVals = [...new Set(data.map(r => String(r[colCol] ?? '(blank)')))].sort();
  if (!colVals.length) { renderTableChart(spec, data, el); return; }

  const aggCell = (rows) => {
    if (agg === 'count') return rows.length;
    const vals = valCol ? rows.map(r => Number(r[valCol])).filter(n => !isNaN(n)) : [];
    if (agg === 'count_distinct') return valCol ? new Set(rows.map(r => r[valCol])).size : rows.length;
    if (agg === 'mean')  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    if (agg === 'max')   return vals.length ? Math.max(...vals) : 0;
    if (agg === 'min')   return vals.length ? Math.min(...vals) : 0;
    return vals.reduce((s, v) => s + v, 0);   // sum (default)
  };

  const fmt = v => (typeof v === 'number')
    ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
    : String(v ?? '');

  // Pre-group data for performance
  const byRow = {};
  rowVals.forEach(rv => { byRow[rv] = data.filter(r => String(r[rowCol] ?? '(blank)') === rv); });

  const matrixVal = (rv, cv) => {
    const sub = byRow[rv].filter(r => String(r[colCol] ?? '(blank)') === cv);
    return aggCell(sub);
  };

  const rowTotal  = rv => aggCell(byRow[rv]);
  const colTotal  = cv => aggCell(data.filter(r => String(r[colCol] ?? '(blank)') === cv));
  const grandTotal = aggCell(data);

  // Limit display to avoid huge tables (max 200 rows, 30 cols)
  const dispRows = rowVals.slice(0, 200);
  const dispCols = colVals.slice(0, 30);

  const thead = `<tr>
    <th class="matrix-row-hdr">${rowCol}</th>
    ${dispCols.map(cv => `<th class="matrix-col-hdr">${cv}</th>`).join('')}
    <th class="matrix-total">Total</th>
  </tr>`;

  const tbody = dispRows.map(rv => `<tr>
    <td class="matrix-row-label">${rv}</td>
    ${dispCols.map(cv => `<td class="n">${fmt(matrixVal(rv, cv))}</td>`).join('')}
    <td class="matrix-total n">${fmt(rowTotal(rv))}</td>
  </tr>`).join('');

  const totalRow = `<tr class="matrix-totals-row">
    <td class="matrix-row-label"><strong>Total</strong></td>
    ${dispCols.map(cv => `<td class="n"><strong>${fmt(colTotal(cv))}</strong></td>`).join('')}
    <td class="matrix-total n"><strong>${fmt(grandTotal)}</strong></td>
  </tr>`;

  el.style.cssText = '';
  el.innerHTML = `
    <div class="dt-wrap">
      <table class="dt-table matrix-table">
        <thead>${thead}</thead>
        <tbody>${tbody}${totalRow}</tbody>
      </table>
      <div class="dt-footer">${dispRows.length} rows × ${dispCols.length} cols${rowVals.length > 200 ? ` (of ${rowVals.length})` : ''}</div>
    </div>`;
}

/* ── Bubble chart ── */
function buildBubbleTraces(spec, data, layout) {
  const colors     = getColors();
  const xIsNumeric = AppState?.colTypes?.[spec.x_column] === 'number';
  const yIsNumeric = AppState?.colTypes?.[spec.y_column] === 'number';

  // Clear forced numeric tickformat for categorical x-axis
  if (!xIsNumeric && layout.xaxis) layout.xaxis.tickformat = '';
  if (layout.yaxis) layout.yaxis.tickformat = '';

  /* One bubble per data row — raw individual points.
     For categorical x (e.g. Country) each employee becomes its own bubble
     clustered at their country position.  Size = size_column if set,
     otherwise a fixed constant so bubbles don't vary by row-order. */
  const sizeCol  = spec.size_column;
  const rawSizes = sizeCol ? data.map(r => Number(r[sizeCol]) || 0) : null;
  const maxSize  = rawSizes ? (Math.max(...rawSizes) || 1) : 1;
  const scaleSz  = v => Math.max(8, Math.sqrt(Math.abs(v) / maxSize) * 60);

  const makeTrace = (rows, name, color) => {
    const t = {
      type: 'scatter', mode: 'markers', name,
      x: rows.map(r => xIsNumeric ? Number(r[spec.x_column]) : r[spec.x_column]),
      y: rows.map(r => yIsNumeric ? Number(r[spec.y_column]) : r[spec.y_column]),
      marker: {
        size:     rawSizes ? rows.map(r => scaleSz(Number(r[sizeCol]) || 0)) : 14,
        sizemode: 'area', color, opacity: 0.65,
        line: { width: 1, color: 'rgba(255,255,255,0.25)' }
      },
      hovertemplate: xIsNumeric
        ? `${spec.x_column}: %{x:,.0f}<br>${spec.y_column}: %{y:,.0f}<extra></extra>`
        : `<b>%{x}</b><br>${spec.y_column}: %{y:,.0f}<extra></extra>`
    };
    if (sizeCol) t.hovertemplate = t.hovertemplate.replace('<extra>', `<br>${sizeCol}: %{marker.size}<extra>`);
    return t;
  };

  if (spec.color_column) {
    const cats = [...new Set(data.map(r => r[spec.color_column]))];
    if (cats.length <= 20) {
      return cats.map((cat, i) =>
        makeTrace(data.filter(r => r[spec.color_column] === cat), String(cat), colors[i % colors.length])
      );
    }
    // High-cardinality color column — fall through to single-trace gradient path
  }
  const t = makeTrace(data, spec.title || 'Bubbles', colors[0]);
  if (rawSizes) {
    t.marker.color      = rawSizes;
    t.marker.colorscale  = getColorScale(spec.color_scheme || 'viridis');
    t.marker.showscale   = true;
    t.marker.colorbar    = { tickfont: { color: '#94a3b8' } };
  }
  return [t];
}

/* ── Choropleth (Filled Map / Map Visual) ── */
function _geoLayout(layout) {
  layout.margin = { t: 10, b: 10, l: 10, r: 10 };
  layout.xaxis  = { visible: false };
  layout.yaxis  = { visible: false };
  layout.geo    = {
    bgcolor:        '#0d0d1f',
    landcolor:      '#1e2040',
    subunitcolor:   '#2e2e50',
    countrycolor:   '#2e2e50',
    showland:       true,
    showcoastlines: true,
    coastlinecolor: '#3e3e60',
    showocean:      true,
    oceancolor:     '#0d0d1f',
    showlakes:      false,
    showcountries:  true,
    showframe:      false,
    resolution:     50,
    projection:     { type: 'natural earth' }
  };
}

/* Normalise country names to Plotly's expected forms.
   Covers the most common HR-dataset variants. */
function _normaliseCountry(name) {
  if (!name) return name;
  const map = {
    'usa': 'United States', 'us': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States',
    'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'great britain': 'United Kingdom',
    'uae': 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates',
    'south korea': 'South Korea', 'republic of korea': 'South Korea', 'korea': 'South Korea',
    'north korea': 'North Korea',
    'russia': 'Russia', 'russian federation': 'Russia',
    'iran': 'Iran', 'islamic republic of iran': 'Iran',
    'taiwan': 'Taiwan', 'republic of china': 'Taiwan',
    'czech republic': 'Czechia', 'czechia': 'Czechia',
    'vietnam': 'Vietnam', 'viet nam': 'Vietnam',
    'burma': 'Myanmar', 'myanmar': 'Myanmar',
    'bolivia': 'Bolivia', 'plurinational state of bolivia': 'Bolivia',
    'venezuela': 'Venezuela', 'bolivarian republic of venezuela': 'Venezuela',
    'tanzania': 'Tanzania', 'united republic of tanzania': 'Tanzania',
    'moldova': 'Moldova', 'republic of moldova': 'Moldova',
    'macedonia': 'North Macedonia', 'north macedonia': 'North Macedonia',
    'laos': 'Laos', "lao people's democratic republic": 'Laos',
    'ivory coast': "Côte d'Ivoire", "cote d'ivoire": "Côte d'Ivoire",
    'congo': 'Republic of the Congo', 'drc': 'Democratic Republic of the Congo',
    'dr congo': 'Democratic Republic of the Congo',
  };
  const key = name.trim().toLowerCase();
  return map[key] || name;
}

function buildChoroplethTraces(spec, data, layout) {
  const agg     = spec.y_column ? (spec.aggregation || 'sum') : 'count';
  let entries   = aggregateData(data, spec.x_column, spec.y_column, agg);
  if (spec.top_n) entries = entries.slice(0, spec.top_n);
  _geoLayout(layout);

  console.log('[choropleth] spec:', spec.type, 'x:', spec.x_column, 'y:', spec.y_column, 'agg:', agg, 'entries:', entries.length);

  const locs     = entries.map(e => _normaliseCountry(String(e.x)));
  const zVals    = entries.map(e => (typeof e.y === 'number' && isFinite(e.y)) ? e.y : 0);
  const zMin     = zVals.length ? Math.min(...zVals) : 0;
  const zMax     = zVals.length ? Math.max(...zVals) : 1;

  /* Always build a count-per-location map for the hover tooltip */
  const countMap = {};
  if (spec.x_column) {
    data.forEach(r => {
      const loc = r[spec.x_column];
      if (loc != null && loc !== '') countMap[String(loc)] = (countMap[String(loc)] || 0) + 1;
    });
  }

  /* Auto-detect ISO-3 alpha codes (e.g. 'USA', 'GBR') vs full country names */
  const iso3Count  = locs.filter(l => /^[A-Z]{3}$/.test(l)).length;
  const locationmode = (iso3Count / Math.max(locs.length, 1)) > 0.6 ? 'ISO-3' : 'country names';

  /* 'Blues' is invisible on dark backgrounds — use Plasma (dark→bright) as default */
  const colorscale = spec.color_scheme ? getColorScale(spec.color_scheme) : 'Plasma';

  /* Build hover text: primary metric + employee count (when available) */
  const metricLabel = spec.y_column || 'Count';
  const aggLabel    = agg === 'mean' ? 'Avg ' : agg === 'sum' ? 'Total ' : agg === 'count' ? '' : '';
  const hoverText   = entries.map(e => {
    const metricFmt = typeof e.y === 'number' ? e.y.toLocaleString(undefined, { maximumFractionDigits: 0 }) : e.y;
    const cnt       = countMap[String(e.x)];
    const countLine = (cnt != null && agg !== 'count') ? `<br>Employees: ${cnt.toLocaleString()}` : '';
    return `<b>${e.x}</b><br>${aggLabel}${metricLabel}: ${metricFmt}${countLine}`;
  });

  return [{
    type:           'choropleth',
    locationmode,
    locations:      locs,
    z:              zVals,
    zmin:           zMin,
    zmax:           zMax,
    text:           hoverText,
    hovertemplate:  '%{text}<extra></extra>',
    colorscale,
    autocolorscale: false,
    showscale:      true,
    colorbar: {
      thickness: 12,
      tickfont:  { color: '#94a3b8', size: 10 },
      title:     { text: `${aggLabel}${metricLabel}`, font: { color: '#94a3b8', size: 11 } }
    },
    marker: { line: { color: '#2e2e50', width: 0.5 } }
  }];
}

/* ── Scatter Geo (Bubble Map) ──────────────────────────────────────────
   Bubble SIZE  = row count per location  (total employees / records)
   Bubble COLOUR= aggregated y_column     (e.g. mean salary, sum revenue)
   Plotly looks up country centroids automatically via locationmode:'country names'
   — no lat/lon columns are needed.
   ──────────────────────────────────────────────────────────────────── */
function buildScatterGeoTraces(spec, data, layout) {
  _geoLayout(layout);

  const locCol = spec.x_column;
  if (!locCol) return [];

  /* Per-location: count rows + accumulate y_column numerics */
  const countMap = {};
  const numMap   = {};

  data.forEach(r => {
    const loc = r[locCol];
    if (loc == null || loc === '') return;
    const k = String(loc);
    countMap[k] = (countMap[k] || 0) + 1;
    if (spec.y_column) {
      const n = toNum(r[spec.y_column]);   // toNum strips commas/currency symbols; Number() would return NaN
      if (!isNaN(n)) { (numMap[k] = numMap[k] || []).push(n); }
    }
  });

  const locations = Object.keys(countMap).map(_normaliseCountry);
  // Re-index maps under normalised keys
  const normCountMap = {}, normNumMap = {};
  Object.keys(countMap).forEach(k => {
    const nk = _normaliseCountry(k);
    normCountMap[nk] = (normCountMap[nk] || 0) + countMap[k];
    if (numMap[k]) normNumMap[nk] = [...(normNumMap[nk] || []), ...numMap[k]];
  });
  if (!locations.length) return [];

  console.log('[scattergeo] spec:', spec.type, 'x:', spec.x_column, 'y:', spec.y_column, 'locations:', locations.length);

  /* Aggregate y_column per location */
  const agg    = spec.aggregation || 'mean';
  const aggFn  = (nums) => {
    if (!nums || !nums.length) return 0;
    switch (agg) {
      case 'sum':    return nums.reduce((s, v) => s + v, 0);
      case 'mean':   return nums.reduce((s, v) => s + v, 0) / nums.length;
      case 'max':    return Math.max(...nums);
      case 'min':    return Math.min(...nums);
      case 'median': { const s = [...nums].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
      default:       return nums.reduce((s, v) => s + v, 0);
    }
  };

  const counts = locations.map(loc => normCountMap[loc] || 0);
  const values = locations.map(loc => spec.y_column ? aggFn(normNumMap[loc]) : (normCountMap[loc] || 0));

  /* Size ∝ sqrt(count) so area is proportional to count */
  const maxCount = Math.max(...counts, 1);
  const sizes    = counts.map(c => Math.max(7, Math.sqrt(c / maxCount) * 55));

  /* Rich tooltips: always show headcount; show y metric if set */
  const aggLabel = { sum:'Total', mean:'Avg', median:'Median', max:'Max', min:'Min', count:'Count' }[agg] || agg;
  const fmt      = v => (typeof v === 'number')
    ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : String(v);

  const texts = locations.map((loc, i) => {
    let tip = `<b>${loc}</b><br>Employees: ${fmt(counts[i])}`;
    if (spec.y_column) tip += `<br>${aggLabel} ${spec.y_column}: ${fmt(values[i])}`;
    return tip;
  });

  return [{
    type:         'scattergeo',
    mode:         'markers',
    locations,
    locationmode: 'country names',
    text:         texts,
    hovertemplate: '%{text}<extra></extra>',
    marker: {
      size:       sizes,
      sizemode:   'diameter',
      color:      values,
      colorscale: getColorScale(spec.color_scheme || 'Viridis'),
      showscale:  true,
      colorbar: {
        thickness: 12,
        tickfont:  { color: '#94a3b8', size: 10 },
        title: {
          text: spec.y_column ? `${aggLabel} ${spec.y_column}` : 'Count',
          font: { color: '#94a3b8', size: 11 }
        }
      },
      line:    { width: 0.5, color: 'rgba(255,255,255,0.3)' },
      opacity: 0.85
    }
  }];
}

/* ── Waterfall ── */
function buildWaterfallTraces(spec, data, layout) {
  let entries = aggregateData(data, spec.x_column, spec.y_column, spec.aggregation || 'sum');
  if (spec.top_n) entries = entries.slice(0, spec.top_n);

  // Sort descending so the biggest contributors appear first
  entries.sort((a, b) => b.y - a.y);

  console.log('[waterfall] spec:', spec.type, 'x:', spec.x_column, 'y:', spec.y_column,
              'agg:', spec.aggregation, 'entries:', entries.length);

  layout.xaxis.tickangle  = -35;
  layout.margin.b         = 90;
  layout.xaxis.tickformat = '';

  const xVals   = entries.map(e => String(e.x));
  const yVals   = entries.map(e => e.y);
  // All data bars are 'relative' (each contributes its value); final 'Total' bar sums all
  const measure = [...entries.map(() => 'relative'), 'total'];

  return [{
    type: 'waterfall', orientation: 'v',
    x:        [...xVals, 'Total'],
    y:        [...yVals, null],          // Plotly auto-computes the Total bar value
    measure,
    connector:  { line: { color: 'rgba(124,58,237,0.5)', width: 1 } },
    increasing: { marker: { color: '#10b981' } },
    decreasing: { marker: { color: '#ef4444' } },
    totals:     { marker: { color: '#7c3aed' } },
    textposition: 'outside',
    texttemplate: '%{y:,.0f}'
  }];
}

/* ── Gauge / KPI indicator ── */
function buildGaugeTraces(spec, data, layout) {
  const agg = spec.aggregation || 'sum';
  const col  = spec.y_column || spec.x_column;
  let value  = 0;

  if (agg === 'count') {
    value = data.length;
  } else if (agg === 'count_distinct' && col) {
    value = new Set(data.map(r => r[col]).filter(v => v != null)).size;
  } else if (col) {
    const nums = data.map(r => Number(r[col])).filter(n => !isNaN(n));
    if      (agg === 'mean')   value = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
    else if (agg === 'median') { const s = [...nums].sort((a,b)=>a-b); value = s.length ? s[Math.floor(s.length/2)] : 0; }
    else if (agg === 'max')    value = nums.length ? Math.max(...nums) : 0;
    else if (agg === 'min')    value = nums.length ? Math.min(...nums) : 0;
    else                       value = nums.reduce((s, v) => s + v, 0);
  }

  /* ── Axis range ───────────────────────────────────────────────────────
     Priority 1: explicit min_value / max_value from spec (user-defined)
     Priority 2: auto-calculate based on aggregation type
     For count/sum the aggregated value can far exceed any individual row
     value, so always base the auto range on the computed value itself.
  ──────────────────────────────────────────────────────────────────── */
  let rangeMin = spec.min_value != null ? Number(spec.min_value) : 0;
  let rangeMax;

  if (spec.max_value != null) {
    rangeMax = Number(spec.max_value);
  } else if (agg === 'count' || agg === 'count_distinct' || agg === 'sum') {
    rangeMax = value > 0 ? value * 1.25 : 100;
  } else {
    /* Mean/median/max/min: use data distribution for context */
    const allNums = col ? data.map(r => Number(r[col])).filter(n => !isNaN(n)) : [];
    const dataMax = allNums.length ? Math.max(...allNums) : 0;
    rangeMax = Math.max(dataMax * 1.05, value > 0 ? value * 1.25 : 100);
    if (spec.min_value == null)
      rangeMin = Math.min(0, allNums.length ? Math.min(...allNums) : 0);
  }

  /* Safety guardrail: value must always sit inside [rangeMin, rangeMax] */
  if (value > rangeMax) rangeMax = value * 1.1;
  if (value < rangeMin) rangeMin = value * 0.9;

  /* ── Target / benchmark ─────────────────────────────────────────────── */
  const target = spec.target_value != null ? Number(spec.target_value) : null;

  /* ── Number formatting ──────────────────────────────────────────────── */
  const isCurrency  = spec.format === 'currency';
  const absVal      = Math.abs(value);
  const valueformat = absVal >= 1e6 ? ',.3s' : ',.0f';
  const prefix      = isCurrency ? '$' : '';

  layout.margin     = { t: 40, b: 20, l: 30, r: 30 };
  layout.xaxis      = { visible: false };
  layout.yaxis      = { visible: false };
  layout.showlegend = false;

  const span = rangeMax - rangeMin;

  /* Color zones: amber below target / green above target when target is set;
     purple gradient otherwise                                              */
  const steps = target != null ? [
    { range: [rangeMin, target],  color: 'rgba(245,158,11,0.20)' },   // amber: below target
    { range: [target,  rangeMax], color: 'rgba(16,185,129,0.20)'  }    // green: above target
  ] : [
    { range: [rangeMin,              rangeMin + span * 0.5], color: 'rgba(124,58,237,0.12)' },
    { range: [rangeMin + span * 0.5, rangeMin + span * 0.8], color: 'rgba(124,58,237,0.22)' },
    { range: [rangeMin + span * 0.8, rangeMax],              color: 'rgba(124,58,237,0.32)' }
  ];

  return [{
    type:  'indicator',
    mode:  'gauge+number',
    value,
    title:  { text: spec.title || col || '', font: { color: '#e2e8f0', size: 13 } },
    number: { font: { color: '#e2e8f0', size: 36 }, valueformat, prefix },
    gauge: {
      axis: {
        range:    [rangeMin, rangeMax],
        tickcolor: '#94a3b8',
        tickfont:  { color: '#94a3b8', size: 10 }
      },
      bar:         { color: '#7c3aed', thickness: 0.7 },
      bgcolor:     'rgba(0,0,0,0)',
      bordercolor: '#2e2e50',
      borderwidth: 1,
      steps,
      threshold: {
        line:      { color: '#f59e0b', width: 3 },
        thickness: 0.75,
        value:     target != null ? target : value   // yellow line = target (or value if no target)
      }
    }
  }];
}

/* ── Combo: bar series + line series (dual series, optional y2) ── */
function buildComboTraces(spec, data, layout) {
  const colors       = getColors();
  const agg          = (!spec.y_column) ? 'count' : (spec.aggregation || 'sum');
  const useDateGroup = spec.x_column && isDateColumn(spec.x_column);
  const isStacked    = (spec.stack_mode === 'stack' || spec.stack_mode === 'percent')
                        && spec.color_column;

  layout.xaxis.tickformat = '';
  if (!useDateGroup) { layout.xaxis.tickangle = -35; layout.margin.b = 90; }
  if (agg === 'count') layout.yaxis.tickformat = ',d';

  const traces = [];

  if (isStacked) {
    /* ── Stacked bars: one trace per unique value of color_column ── */
    const cats = [...new Set(data.map(r => r[spec.color_column]).filter(v => v != null))].sort();
    cats.forEach((cat, i) => {
      const sub = data.filter(r => r[spec.color_column] === cat);
      const entries = useDateGroup
        ? aggregateByMonth(sub, spec.x_column, spec.y_column, agg)
        : aggregateData(sub, spec.x_column, spec.y_column, agg);
      traces.push({
        type: 'bar', name: String(cat),
        x: entries.map(e => e.x),
        y: entries.map(e => e.y),
        marker: { color: colors[i % colors.length], opacity: 0.85 }
      });
    });
    layout.barmode = 'stack';
    if (spec.stack_mode === 'percent') layout.barnorm = 'percent';
  } else {
    /* ── Simple single-series bars ── */
    const barEntries = useDateGroup
      ? aggregateByMonth(data, spec.x_column, spec.y_column, agg)
      : sortAndLimit(aggregateData(data, spec.x_column, spec.y_column, agg), spec);
    traces.push({
      type: 'bar', name: spec.y_column || 'Count',
      x: barEntries.map(e => e.x),
      y: barEntries.map(e => e.y),
      marker: { color: colors[0], opacity: 0.82 }
    });
  }

  /* ── Line series on secondary y-axis ── */
  const lineCol = spec.y2_column;
  if (lineCol && AppState.colTypes?.[lineCol] === 'number') {
    /* Same column on both axes → mean avoids double-summing.
       Bars are row-counting (count agg) → use sum for the line so a numeric y2 column
       (e.g. Annual Salary) shows a real total rather than a row-count that mirrors the bars. */
    const lineAgg = (lineCol === spec.y_column) ? 'mean'
                  : (spec.aggregation === 'count') ? 'sum'
                  : (spec.aggregation || 'sum');
    const lineEntries = useDateGroup
      ? aggregateByMonth(data, spec.x_column, lineCol, lineAgg)
      : aggregateData(data, spec.x_column, lineCol, lineAgg);
    const lineColor = colors[traces.length % colors.length];
    traces.push({
      type: 'scatter', mode: 'lines+markers', name: lineCol,
      x: lineEntries.map(e => e.x),
      y: lineEntries.map(e => e.y),
      yaxis: 'y2',
      line:   { color: lineColor, width: 2.5 },
      marker: { size: 6, color: lineColor }
    });
    layout.yaxis2 = {
      overlaying: 'y', side: 'right',
      gridcolor: 'rgba(46,46,80,0)', zerolinecolor: '#2e2e50',
      tickfont: { color: '#94a3b8', size: 11 }
    };
  }
  return traces;
}

/* ── Date helpers ── */

/**
 * Extract a sortable YYYY-MM key from any common date string.
 * Falls back to the original string so non-date values pass through.
 */
function toMonthKey(v) {
  const s = String(v ?? '').trim();
  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  // DD-MM-YYYY or DD/MM/YYYY
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}`;
  // MM/DD/YYYY (US)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}`;
  return s; // already "Jan 2024", "Q1 2024", etc.
}

function isDateColumn(col) {
  return AppState.colTypes[col] === 'date';
}

/**
 * Aggregate data grouping date x_column by YYYY-MM, sorted chronologically.
 */
function aggregateByMonth(data, xCol, yCol, agg) {
  const mapped = data.map(r => ({ ...r, [xCol]: toMonthKey(r[xCol]) }));
  const entries = aggregateData(mapped, xCol, yCol, agg);
  return entries.sort((a, b) => a.x.localeCompare(b.x));
}

/* ── Bar / Line / Area ── */
function buildBarLineAreaTraces(spec, data, layout) {
  const colors = getColors();
  // When no y_column is provided, the intent is always to count rows — never sum nothing
  const agg    = (!spec.y_column) ? 'count' : (spec.aggregation || 'sum');
  const isLine = spec.type === 'line' || spec.type === 'area';
  const plotType = isLine ? 'scatter' : 'bar';
  const useDateGroup = spec.x_column && isDateColumn(spec.x_column);
  const traces = [];

  // Axis setup depends on orientation (horizontal flips which axis carries values vs categories)
  if (spec.orientation === 'h') {
    layout.yaxis.tickformat = '';                                    // y = categories (strings)
    layout.xaxis.tickformat = (agg === 'count') ? ',d' : '';        // x = values
    layout.margin.l = 130;                                          // room for category labels
  } else {
    layout.xaxis.tickformat = '';                                    // x = categories
    if (agg === 'count') layout.yaxis.tickformat = ',d';            // y = values
    if (!isLine) { layout.xaxis.tickangle = -35; layout.margin.b = 90; }
  }

  if (spec.color_column) {
    const cats = [...new Set(data.map(r => r[spec.color_column]))];
    cats.forEach((cat, i) => {
      const sub = data.filter(r => r[spec.color_column] === cat);
      let entries = useDateGroup
        ? aggregateByMonth(sub, spec.x_column, spec.y_column, agg)
        : aggregateData(sub, spec.x_column, spec.y_column, agg);
      if (!useDateGroup && spec.sort_by === 'y')
        entries.sort((a, b) => spec.sort_order === 'asc' ? a.y - b.y : b.y - a.y);

      const t = { type: plotType, name: String(cat), marker: { color: colors[i % colors.length] } };
      applyOrientation(t, entries, spec);
      applyLineAreaStyle(t, spec.type, colors[i % colors.length], i, spec.stack_mode);
      traces.push(t);
    });
    if (spec.type === 'bar') {
      if (spec.stack_mode === 'percent') {
        layout.barmode = 'stack';
        layout.barnorm = 'percent';
        // For horizontal bars the value axis is x; for vertical it is y
        const pctAxis = spec.orientation === 'h' ? 'xaxis' : 'yaxis';
        layout[pctAxis].ticksuffix = '%';
        layout[pctAxis].tickformat = '.0f';
        // Clear any conflicting format that was set by the orientation block above
        if (spec.orientation === 'h') layout.xaxis.tickformat = '.0f';
        else                          layout.yaxis.tickformat = '.0f';
      } else if (spec.stack_mode === 'stack') {
        layout.barmode = 'stack';
      } else {
        layout.barmode = 'group';
      }
    }

  } else {
    let entries = useDateGroup
      ? aggregateByMonth(data, spec.x_column, spec.y_column, agg)
      : aggregateData(data, spec.x_column, spec.y_column, agg);

    if (!useDateGroup) entries = sortAndLimit(entries, spec);

    // Date/monthly charts: single consistent color; category charts: cycle palette
    const barColor = useDateGroup
      ? colors[2]
      : entries.map((_, i) => colors[i % colors.length]);

    const t = { type: plotType, marker: { color: barColor, opacity: 0.88 } };
    applyOrientation(t, entries, spec);
    applyLineAreaStyle(t, spec.type, colors[0], 0, spec.stack_mode);

    if (spec.show_values) {
      t.text         = entries.map(e => shortNumber(e.y));
      t.textposition = 'outside';
      t.textfont     = { color: '#e2e8f0', size: 10 };
    }

    traces.push(t);
  }

  return traces;
}

/* ── Helpers ── */

function applyOrientation(trace, entries, spec) {
  if (spec.orientation === 'h') {
    trace.y          = entries.map(e => e.x);
    trace.x          = entries.map(e => e.y);
    trace.orientation = 'h';
  } else {
    trace.x = entries.map(e => e.x);
    trace.y = entries.map(e => e.y);
  }
}

function applyLineAreaStyle(trace, type, color, idx, stackMode) {
  if (type === 'line' || type === 'area') {
    trace.mode   = 'lines+markers';
    trace.line   = { color, width: 2.5 };
    trace.marker = { size: 6, color };
    if (type === 'area') {
      if (stackMode === 'stack') {
        trace.stackgroup = 'one';
        trace.fill       = 'tonexty';
        trace.fillcolor  = hexToRgba(color, 0.35);
      } else {
        trace.fill      = idx === 0 ? 'tozeroy' : 'tonexty';
        trace.fillcolor = hexToRgba(color, 0.08);
      }
    }
  }
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function sortAndLimit(entries, spec) {
  if (spec.sort_by === 'y') {
    entries.sort((a, b) => spec.sort_order === 'asc' ? a.y - b.y : b.y - a.y);
  }
  if (spec.top_n) entries = entries.slice(0, spec.top_n);
  return entries;
}

/* ════════════════════════════
   BULK EXPORT
   ════════════════════════════ */

function exportAllCharts() {
  const spec = AppState.currentSpec;
  if (!spec?.charts?.length) { toast('No charts to export.', 'error'); return; }

  const cfg = AppState.config?.chart ?? {};
  spec.charts.forEach(c => {
    const el = document.getElementById(c.id);
    if (el) Plotly.downloadImage(el, {
      format:   cfg.exportFormat ?? 'png',
      width:    cfg.exportWidth  ?? 1400,
      height:   cfg.exportHeight ?? 700,
      filename: c.title || c.id
    });
  });
  toast('Exporting charts as PNG files…', 'info');
}
