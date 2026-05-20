/**
 * chart-renderer.js — Plotly.js chart rendering engine
 * Depends on: state.js (AppState), data-processor.js (aggregateData, shortNumber)
 * External: Plotly (loaded via CDN in index.html)
 */

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
    renderTableChart(spec, data, el);
    return;
  }

  try {
    const layout = getBaseLayout();
    layout.colorway = getColors();
    const traces = buildTraces(spec, data, layout);
    Plotly.newPlot(spec.id, traces, layout, getPlotlyConfig(spec.title));

    // Reflow on window resize
    window.addEventListener('resize', () => {
      const e2 = document.getElementById(spec.id);
      if (e2) Plotly.relayout(e2, { autosize: true });
    });
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
    case 'donut':    return buildPieTraces(spec, data, layout);
    case 'treemap':  return buildTreemapTraces(spec, data, layout);
    case 'funnel':   return buildFunnelTraces(spec, data);
    case 'scatter':  return buildScatterTraces(spec, data);
    case 'histogram':return buildHistogramTraces(spec, data, layout);
    case 'box':      return buildBoxTraces(spec, data);
    case 'heatmap':  return buildHeatmapTraces(spec, data, layout);
    default:         return buildBarLineAreaTraces(spec, data, layout);
  }
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
  let entries = aggregateData(data, spec.x_column, spec.y_column, spec.aggregation || 'sum');
  if (spec.top_n) entries = entries.slice(0, spec.top_n);

  layout.margin = { t: 10, b: 10, l: 10, r: 10 };

  return [{
    type: 'treemap',
    labels:  entries.map(e => e.x),
    values:  entries.map(e => e.y),
    parents: entries.map(() => ''),
    marker:  { colorscale: getColorScale(spec.color_scheme), showscale: false },
    textfont:{ color: '#fff' }
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

/* ── Heatmap ── */
function buildHeatmapTraces(spec, data, layout) {
  const xVals = [...new Set(data.map(r => String(r[spec.x_column] ?? '(blank)')))].sort();
  const yVals = [...new Set(data.map(r => String(r[spec.y_column] ?? '(blank)')))].sort();

  const z = yVals.map(yv =>
    xVals.map(xv =>
      data.filter(r => String(r[spec.x_column]) === xv && String(r[spec.y_column]) === yv).length
    )
  );

  layout.margin.b = 90;
  layout.margin.l = 110;

  return [{
    type: 'heatmap', x: xVals, y: yVals, z,
    colorscale: getColorScale(spec.color_scheme || 'viridis'),
    hoverongaps: false
  }];
}

/* ── Data table renderer ── */

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

  // Make the container behave like a scrollable block (not Plotly's absolute fill)
  el.style.cssText = 'position:relative;overflow:auto;height:100%;';

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
  const agg    = spec.aggregation || 'sum';
  const isLine = spec.type === 'line' || spec.type === 'area';
  const plotType = isLine ? 'scatter' : 'bar';
  const useDateGroup = spec.x_column && isDateColumn(spec.x_column);
  const traces = [];

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
      applyLineAreaStyle(t, spec.type, colors[i % colors.length], i);
      traces.push(t);
    });
    if (spec.type === 'bar') layout.barmode = 'group';

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
    applyLineAreaStyle(t, spec.type, colors[0], 0);

    if (spec.show_values) {
      t.text         = entries.map(e => shortNumber(e.y));
      t.textposition = 'outside';
      t.textfont     = { color: '#e2e8f0', size: 10 };
    }

    if (spec.orientation === 'h') layout.margin.l = 130;
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

function applyLineAreaStyle(trace, type, color, idx) {
  if (type === 'line' || type === 'area') {
    trace.mode   = 'lines+markers';
    trace.line   = { color, width: 2.5 };
    trace.marker = { size: 6, color };
    if (type === 'area') {
      trace.fill      = idx === 0 ? 'tozeroy' : 'tonexty';
      trace.fillcolor = hexToRgba(color, 0.08);
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
