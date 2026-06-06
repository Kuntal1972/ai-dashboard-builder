/* ══ Table injection guarantee ════════════════════════════ */

/* Extracts the legend/color column from the prompt text (client-side mirror of server logic) */
function _extractColorColumnFromPrompt(prompt) {
  if (!prompt) return null;
  const catCols = AppState.columns.filter(c => AppState.colTypes[c] !== 'number');
  const norm = s => s.toLowerCase().replace(/[\s_\-]+/g, '');
  const patterns = [
    /using\s+([\w\s]{2,25}?)\s+(?:in\s+(?:the\s+)?)?(?:the\s+)?legend/i,
    /legend\s*[:\-]\s*([\w\s]{2,25}?)(?:\s+to\b|\s+as\b|[,;.]|$)/i,
    /([\w\s]{2,25}?)\s+(?:as|for)\s+(?:the\s+)?legend/i,
    /(?:split|group|color|colour)\s+by\s+([\w\s]{2,25}?)(?:\s+(?:in|for|as)\b|[,;.]|$)/i,
    /color[-\s]coded\s+by\s+([\w\s]{2,25}?)(?:[,;.]|$)/i,
  ];
  for (const pat of patterns) {
    const m = pat.exec(prompt);
    if (!m) continue;
    const hint = (m[1] || '').trim();
    if (hint.length < 2) continue;
    const hn = norm(hint);
    const col = catCols.find(c => c.toLowerCase() === hint.toLowerCase())
      || catCols.find(c => norm(c) === hn)
      || catCols.find(c => norm(c).includes(hn) || (hn.length > 3 && hn.includes(norm(c))));
    if (col) return col;
  }
  return null;
}

function _extractTableColumnsFromPrompt(prompt) {
  const p = (prompt || '').toLowerCase();
  if (/\ball\s+(?:the\s+)?columns?\b|\ball\s+data\b|\bfull\s+(?:table|dataset)\b/i.test(p)) return AppState.columns.slice();
  const norm = s => s.toLowerCase().replace(/[\s_\-]+/g, '');
  const tableMatch = p.match(/\b(?:data\s*)?table\b/);
  if (!tableMatch) return AppState.columns.slice(0, 10);
  const win = p.slice(Math.max(0, tableMatch.index - 20), tableMatch.index + 200);
  const matched = AppState.columns.filter(col => {
    const cn = norm(col);
    if (cn.length < 3) return false;
    return win.includes(col.toLowerCase()) || win.includes(cn);
  });
  return matched.length >= 1 ? matched : AppState.columns.slice(0, 10);
}

function _injectTableIfRequested(spec, prompt) {
  if (!/\bdata\s*table\b|\btable\s*(?:chart|visual|view)?\b|\bmatrix\b/i.test((prompt || '').toLowerCase())) return;
  if (spec.charts?.some(c => c.type === 'table')) return;
  (spec.charts = spec.charts || []).push({
    id: 'inj_table', title: 'Data Table', type: 'table',
    x_column: null, y_column: null, y2_column: null,
    color_column: null, size_column: null, stack_mode: null,
    columns: _extractTableColumnsFromPrompt(prompt), aggregation: 'none',
    orientation: 'v', sort_by: 'none', sort_order: 'desc',
    top_n: 100, width: 2
  });
}

/* ══ Slicer injection — guarantee button slicers appear when requested ══
   Claude sometimes returns filter entries instead of slicer charts.
   This scans the prompt for slicer keywords and injects chart entries
   for any requested columns that Claude missed.
══════════════════════════════════════════════════════════════════════ */
function _injectSlicersIfRequested(spec, prompt) {
  if (!prompt) return;
  const p = prompt.toLowerCase();

  /* Only proceed if the user explicitly asked for a slicer */
  if (!/\bslicer\b/i.test(p)) return;

  spec.charts = spec.charts || [];

  /* Find all column names mentioned after "slicer for/on/by" */
  const slicerPattern = /\b(?:button\s+|interactive\s+|tile\s+)?slicer\s+(?:for|on|by)\s+([\w][\w\s,&]{2,80}?)(?:\s*[.!?]|$)/gi;
  const cols = AppState.columns || [];
  const foundCols = [];

  let m;
  while ((m = slicerPattern.exec(p)) !== null) {
    const parts = m[1].split(/,|\band\b/i).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      /* Case-insensitive match against actual column names */
      const col = cols.find(c => c.toLowerCase() === part.toLowerCase())
               || cols.find(c => c.toLowerCase().includes(part.toLowerCase()) || part.toLowerCase().includes(c.toLowerCase()));
      if (col && !foundCols.includes(col)) foundCols.push(col);
    }
  }

  /* Inject any missing slicer cards */
  foundCols.forEach((col, i) => {
    if (!spec.charts.some(c => c.type === 'slicer' && c.x_column === col)) {
      spec.charts.unshift({
        id: `inj_slicer_${i}_${col.replace(/\W/g, '_')}`,
        title: col,
        type: 'slicer',
        x_column: col,
        y_column: null, y2_column: null, color_column: null,
        size_column: null, stack_mode: null, columns: [],
        aggregation: 'none', orientation: 'v',
        sort_by: 'none', sort_order: 'asc', top_n: null, width: 2
      });
    }
  });
}

/* ══ Advanced chart post-processing (Claude API mode) ══════════════
   Patches specs where Claude may have omitted required fields:
   – Stacked area needs color_column to display multiple series.
   – Combo needs y2_column for the line series.
   – Multi-row card normalised to type="multi_row_card".
   Called after extractSpec() before renderDashboard().
════════════════════════════════════════════════════════════════════ */
function _postProcessAdvancedCharts(spec, prompt = '') {
  if (!spec?.charts) return;
  const cols     = AppState.columns || [];
  const colTypes = AppState.colTypes || {};
  const catCols  = cols.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date');
  const numCols  = cols.filter(c => colTypes[c] === 'number');

  spec.charts.forEach(c => {
    /* Normalise type strings Claude might output with wrong casing / spacing */
    if (/multi.?row.?card/i.test(c.type))  c.type = 'multi_row_card';
    if (/^slicer$/i.test(c.type))          c.type = 'slicer';
    if (/choropleth|filled.?map/i.test(c.type)) c.type = 'choropleth';
    if (/scatter.?geo|bubble.?map/i.test(c.type)) c.type = 'scattergeo';
    if (/^map$/i.test(c.type))             c.type = 'choropleth';
    /* Normalise alternative names Claude might use */
    if (/^column\s*chart$/i.test(c.type))  c.type = 'bar';
    if (/^doughnut$/i.test(c.type))        c.type = 'donut';
    if (/^heat.?map$/i.test(c.type))       c.type = 'heatmap';
    if (/^scatter.?plot$/i.test(c.type))   c.type = 'scatter';
    if (/^bubble.?chart$/i.test(c.type))   c.type = 'bubble';
    if (/^word.?cloud$/i.test(c.type))     c.type = 'table';   // not supported → fallback
    if (/^box[\s_-]?(?:and[\s_-]?whisker|plot|chart)?$/i.test(c.type)
        || /^whisker/i.test(c.type))                          c.type = 'box';
    if (/^marimekko|^ma?rimekko|^mekko|^mosaic[\s_-]?chart$/i.test(c.type)) c.type = 'marimekko';
    if (/^gauge\s*(?:chart|visual)?$/i.test(c.type)
        || /^kpi\s+(?:visual|indicator|gauge)$/i.test(c.type)
        || /^speedometer$/i.test(c.type)
        || /^indicator\s*(?:chart)?$/i.test(c.type)) c.type = 'gauge';

    /* Fix: box plot — y_column must be numeric, aggregation must be "none" */
    if (c.type === 'box') {
      c.aggregation = 'none';
      // y_column must be numeric (the values to distribute)
      if (!c.y_column || colTypes[c.y_column] !== 'number') {
        c.y_column = numCols[0] || null;
      }
      // x_column should be categorical (the grouping dimension), not numeric
      if (c.x_column && colTypes[c.x_column] === 'number') {
        c.x_column = catCols[0] || null;
      }
    }

    /* Fix: marimekko — ensure x_column (category), color_column (segment), y_column (numeric or null) */
    if (c.type === 'marimekko') {
      c.width = 2;
      // x_column must be categorical
      if (!c.x_column || colTypes[c.x_column] === 'number') {
        c.x_column = catCols[0] || cols[0] || null;
      }
      // color_column must be a different categorical column
      if (!c.color_column || colTypes[c.color_column] === 'number' || c.color_column === c.x_column) {
        c.color_column = catCols.find(col => col !== c.x_column) || null;
      }
      // y_column: null for count, or a numeric column
      if (c.aggregation === 'count') {
        c.y_column = null;
      } else if (c.y_column && colTypes[c.y_column] !== 'number') {
        c.y_column = numCols[0] || null;
      }
    }

    /* Fix: histogram must have aggregation="none" and numeric x_column */
    if (c.type === 'histogram') {
      c.aggregation = 'none';
      if (c.x_column && colTypes[c.x_column] !== 'number') {
        /* Claude put a categorical on x — swap for first numeric */
        c.x_column = numCols[0] || c.x_column;
      }
      if (!c.x_column) c.x_column = numCols[0] || cols[0] || null;
      c.y_column = null;
    }

    /* Fix: scatter must have numeric x_column and aggregation="none" */
    if (c.type === 'scatter' || c.type === 'bubble') {
      c.aggregation = 'none';
    }

    /* Geographic charts: ensure x_column is set to a plausible location column */
    if ((c.type === 'choropleth' || c.type === 'scattergeo') && !c.x_column) {
      const geoCol = catCols.find(col =>
        /country|region|state|province|city|location|territory|geography|geo\b/i.test(col)
      ) || catCols[0] || cols[0] || null;
      if (geoCol) c.x_column = geoCol;
    }

    /* Combo with categorical color_column but no stack_mode → almost certainly a stacked
       combo request where Claude forgot to set stack_mode. Auto-detect it. */
    if (c.type === 'combo' && c.color_column && !c.stack_mode
        && colTypes[c.color_column] !== 'number') {
      c.stack_mode = 'stack';
    }

    /* Stacked area: color_column is required for multiple series to actually stack */
    if (c.type === 'area' && c.stack_mode === 'stack' && !c.color_column) {
      const cc = catCols.find(cat => cat !== c.x_column);
      if (cc) c.color_column = cc;
    }

    /* Combo: y2_column is required for the line overlay */
    if (c.type === 'combo' && !c.y2_column) {
      const colorIsNum = c.color_column && colTypes[c.color_column] === 'number';
      const isStackedCombo = c.stack_mode === 'stack' || c.stack_mode === 'percent';

      if (colorIsNum && !isStackedCombo) {
        /* Claude put the line column into color_column by mistake — promote it */
        c.y2_column    = c.color_column;
        c.color_column = null;
      } else if (!isStackedCombo || !c.color_column) {
        /* Simple combo or stacked without color: auto-pick a second numeric for the line */
        const y2 = numCols.find(n => n !== c.y_column);
        if (y2) c.y2_column = y2;
      }
      /* Stacked combo WITH color_column: color_column is the stack dimension, keep it.
         Auto-pick y2_column from remaining numerics for the line series. */
      if (isStackedCombo && c.color_column && !c.y2_column) {
        const y2 = numCols.find(n => n !== c.y_column);
        if (y2) c.y2_column = y2;
      }
    }

    /* Treemap / waterfall / icicle: ensure both axes are set */
    if (c.type === 'treemap' || c.type === 'waterfall' || c.type === 'icicle') {
      if (!c.x_column) c.x_column = catCols[0] || cols[0] || null;
      if (!c.y_column) c.y_column = numCols[0] || null;
    }
    /* Normalise icicle type strings */
    if (/^icicle$/i.test(c.type))                             c.type = 'icicle';
    if (/^hierarchy\s*tree$|^org\s*chart$/i.test(c.type))    c.type = 'icicle';

    /* Bubble / Scatter: y_column MUST be numeric.
       x_column may be categorical (e.g. "Country on x, Salary on y") — Plotly handles
       categorical x-axes for scatter traces natively.
       Only fall back x to numeric when BOTH x and y are non-numeric (completely wrong spec). */
    if (c.type === 'bubble' || c.type === 'scatter') {
      const yIsNum = c.y_column && colTypes[c.y_column] === 'number';
      const xIsNum = c.x_column && colTypes[c.x_column] === 'number';
      if (!c.y_column || !yIsNum) {
        /* y must always be numeric */
        c.y_column = numCols.find(n => n !== c.x_column) || numCols[0] || null;
      }
      if (!c.x_column || (!xIsNum && !yIsNum)) {
        /* Only replace x when neither axis was numeric (both wrong) */
        c.x_column = numCols.find(n => n !== c.y_column) || numCols[0] || null;
      }
    }

    /* Bubble: pick a meaningful size_column — skip ID / serial-number columns.
       buildBubbleTraces uses fixed size 14 if no size_column is set. */
    if (c.type === 'bubble' && !c.size_column) {
      const isIdLike = n => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
        n.toLowerCase().replace(/[\s_\-]+/g, ' ')
      );
      const sz = numCols.find(n => n !== c.x_column && n !== c.y_column && !isIdLike(n))
              || numCols.find(n => n !== c.x_column && n !== c.y_column);
      if (sz) c.size_column = sz;
    }

    /* Bar charts: correct Claude API's habit of emitting orientation:'h' for simple
       "X by Y" bar queries that should be vertical columns.
       ONLY force 'v' when:
         • No explicit grouping (color_column) — clustered/grouped bars are intentionally horizontal
         • No explicit stack_mode — stacked bars may need 'h'
         • orientation was 'h' (the wrong default Claude sometimes emits)
         • User did NOT explicitly ask for horizontal bars or use Power BI "bar chart" convention
       Preserve 'h' orientation for: horizontal bar button, bar chart button, rankings, etc. */
    if (c.type === 'bar'
        && c.orientation === 'h'
        && !c.color_column
        && !c.stack_mode
        && c.x_column
        && colTypes[c.x_column] !== 'number'
        && colTypes[c.x_column] !== 'date'
        && !/\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(prompt)) {
      // Only correct to 'v' when no ranking/top-N context is present
      // (rankings are typically horizontal bars)
      if (!c.top_n && !/\branking\b|\btop\s*\d/i.test(c.title || '')) {
        c.orientation = 'v';
      }
    }

    /* Gauge: x_column must be null; y_column must be numeric when agg ≠ count */
    if (c.type === 'gauge') {
      c.x_column = null;   // gauge never groups by a dimension
      if (c.aggregation !== 'count' && (!c.y_column || colTypes[c.y_column] !== 'number')) {
        c.y_column = numCols[0] || null;
      }
      if (c.aggregation === 'count') c.y_column = null;
    }

    /* multi_row_card: ensure metrics array exists with at least one entry */
    if (c.type === 'multi_row_card' && (!c.metrics || !c.metrics.length)) {
      const metrics = [];
      const idCol = cols.find(col => /\bid\b|employee.*id|person.*id/i.test(col)) || cols[0];
      if (idCol) metrics.push({ label: 'Total Records', column: idCol, aggregation: 'count', format: 'number' });
      numCols.slice(0, 3).forEach(col => {
        const fmt = /salary|pay|revenue|income|cost|price|budget|earn|wage|bonus|profit|amount|value/i.test(col)
          ? 'currency' : /rate|pct|percent|ratio/i.test(col) ? 'percent' : 'number';
        metrics.push({ label: col, column: col, aggregation: 'sum', format: fmt });
      });
      if (metrics.length) c.metrics = metrics;
    }
  });
}

/* ══ Client-side bar-chart post-processing (Claude API mode) ══════════
   Catches "using X in the legend" → color_column, and ensures
   orientation is correct for clustered bar / column chart prompts.
   Called after extractSpec() so it can patch what Claude missed.
════════════════════════════════════════════════════════════════════ */
function _postProcessBarChart(spec, prompt) {
  if (!spec || !spec.charts || !prompt) return;
  if (!/\bbar\s+chart\b|\bclustered\s+bar\b|\bcolumn\s+chart\b/i.test(prompt)) return;
  const barChart = spec.charts.find(c => c.type === 'bar');
  if (!barChart) return;

  const cols = AppState.columns || [];
  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase();
    return cols.find(c => c.toLowerCase() === t)
        || cols.find(c => c.toLowerCase().includes(t) || t.includes(c.toLowerCase()))
        || null;
  };

  // Patch color_column from "using X in the legend" if Claude missed it
  if (!barChart.color_column) {
    const legendM = /\busing\s+([\w ][\w ]{1,25}?)\s+(?:in\s+(?:the\s+)?)?legend\b/i.exec(prompt)
                 || /\blegend\s*[:\-]\s*([\w ][\w ]{1,25}?)(?:\s|[,;.]|$)/i.exec(prompt)
                 || /\bcolor(?:ed)?\s+by\s+([\w ][\w ]{1,25}?)(?:\s|[,;.]|$)/i.exec(prompt);
    if (legendM) {
      const col = findCol(legendM[1].trim());
      if (col) barChart.color_column = col;
    }
  }

  // Patch orientation: default to vertical ('v') so categories appear on x-axis.
  // Only use horizontal for explicit "horizontal bar" requests.
  if (!barChart.orientation) {
    barChart.orientation = /\bhorizontal\s+bar\b/i.test(prompt) ? 'h' : 'v';
  }
}

/* ══ Full dashboard render ════════════════════════════════ */

function renderDashboard(spec) {
  const data   = getFilteredData();
  const grid   = document.getElementById('charts-grid');
  const colSet = new Set(AppState.columns);

  const hint = document.getElementById('ready-hint');
  if (hint) hint.style.display = 'none';

  const firstNum = AppState.columns.find(c => AppState.colTypes[c] === 'number') || AppState.columns[0];
  const firstStr = AppState.columns.find(c => AppState.colTypes[c] === 'string') || AppState.columns[0];

  // Case-insensitive column name lookup (handles casing mismatches from Claude / auto-generate)
  const fixCol = (name, fallback) => {
    if (!name) return name;
    if (colSet.has(name)) return name;
    const ci = AppState.columns.find(c => c.toLowerCase() === name.toLowerCase());
    return ci || fallback;
  };

  // Never drop KPIs — fix bad columns in-place
  const validKpis = (spec.kpi_cards || []).map(k => {
    if (!colSet.has(k.column)) k = { ...k, column: firstNum };
    // Validate value_column for top_label too
    if (k.value_column && !colSet.has(k.value_column)) k = { ...k, value_column: firstNum };
    // Validate comparison sub-spec column
    if (k.comparison?.column) {
      const fc = fixCol(k.comparison.column, firstNum);
      if (fc !== k.comparison.column) k = { ...k, comparison: { ...k.comparison, column: fc } };
    }
    // Validate secondary sub-spec column (count aggregation doesn't need a real column)
    if (k.secondary && k.secondary.aggregation !== 'count' && k.secondary.column) {
      const fs = fixCol(k.secondary.column, firstNum);
      if (fs !== k.secondary.column) k = { ...k, secondary: { ...k.secondary, column: fs } };
    }
    return k;
  });

  // Never drop charts — fix bad columns in-place using fixCol (case-insensitive + type-aware)
  const validCharts = (spec.charts || []).map(c => {
    // bubble/scatter/histogram need a numeric x-axis; all other chart types use a categorical x
    const needsNumericX = ['bubble', 'scatter', 'histogram'].includes(c.type);
    const xFallback     = needsNumericX ? firstNum : firstStr;

    let fixedX    = c.x_column    ? fixCol(c.x_column,    xFallback) : c.x_column;
    // Gantt/heatmap/sunburst y_column is a date or categorical, not numeric — use a string fallback
    // to avoid forcing a numeric column that would break these chart types
    const firstStrCol = AppState.columns.find(col => AppState.colTypes[col] !== 'number') || firstStr;
    const yFallback = (c.type === 'gantt' || c.type === 'heatmap' || c.type === 'sunburst' || c.type === 'icicle') ? firstStrCol : firstNum;
    let fixedY    = c.y_column    ? fixCol(c.y_column,    yFallback)  : c.y_column;
    // For bubble/scatter: y must be numeric; x may be categorical (e.g. Country on x-axis).
    // Only force numeric x when BOTH axes resolved to non-numeric (completely wrong spec).
    if (needsNumericX && fixedY && AppState.colTypes?.[fixedY] !== 'number') fixedY = firstNum;
    if (needsNumericX && fixedX && AppState.colTypes?.[fixedX] !== 'number' &&
        AppState.colTypes?.[fixedY] !== 'number') fixedX = firstNum;
    // For combo charts y2_column drives the line series. If the name Claude gave doesn't
    // resolve exactly (e.g. "Average Annual Salary" vs actual "Annual Salary"), fall back to
    // the best available numeric column (≠ y_column) so the line trace is never silently lost.
    const y2Fallback = (c.type === 'combo')
      ? (AppState.columns.find(col => AppState.colTypes[col] === 'number' && col !== fixedY) || firstNum)
      : null;
    const fixedY2   = c.y2_column      ? fixCol(c.y2_column,      y2Fallback) : c.y2_column;
    const fixedSize = c.size_column    ? fixCol(c.size_column,    null)        : c.size_column;
    const fixedColor= c.color_column   ? fixCol(c.color_column,   null)        : null;
    // Gantt: fix end_column (date column) so casing mismatches don't silently drop end dates
    const fixedEnd  = c.end_column     ? fixCol(c.end_column,     null)        : c.end_column;
    // Bullet: fix target_column
    const fixedTgt  = c.target_column  ? fixCol(c.target_column,  firstNum)    : c.target_column;

    const changed = fixedX !== c.x_column || fixedY !== c.y_column ||
                    fixedY2 !== c.y2_column || fixedSize !== c.size_column ||
                    fixedColor !== c.color_column ||
                    fixedEnd !== c.end_column || fixedTgt !== c.target_column;
    return changed
      ? { ...c, x_column: fixedX, y_column: fixedY, y2_column: fixedY2,
                size_column: fixedSize, color_column: fixedColor,
                end_column: fixedEnd, target_column: fixedTgt }
      : c;
  });

  let html = '';
  if (validKpis.length) {
    html += `<div class="kpi-row">${validKpis.map(k => {
      let display = '—', compDisplay = '', secDisplay = '';
      try {
        const val = computeKPI(data, k);
        display = formatKPIValue(val, k);
      } catch (e) {
        console.error('KPI render error:', k.title, e);
      }
      // Render comparison sub-value (e.g. "vs Median: $68,500")
      if (k.comparison && k.comparison.column) {
        try {
          const cv = computeKPI(data, k.comparison);
          compDisplay = formatKPIValue(cv, k.comparison);
        } catch(e) { console.error('KPI comparison error:', e); }
      }
      // Render secondary sub-value (e.g. "Headcount: 150")
      if (k.secondary && (k.secondary.column || k.secondary.aggregation === 'count')) {
        try {
          const sv = computeKPI(data, k.secondary);
          secDisplay = formatKPIValue(sv, k.secondary);
        } catch(e) { console.error('KPI secondary error:', e); }
      }
      const dbgText = k.aggregation === 'top_label'
        ? `top(${k.column}) by ${k.value_column}`
        : `${k.aggregation}(${k.column})`;
      return `<div class="kpi-card">
        <div class="kpi-label">${k.title}</div>
        <div class="kpi-value">${display}</div>
        ${compDisplay ? `<div class="kpi-sub">↔ ${k.comparison.label}: <strong>${compDisplay}</strong></div>` : ''}
        ${secDisplay ? `<div class="kpi-sub">📊 ${k.secondary.label}: <strong>${secDisplay}</strong></div>` : ''}
        <div class="kpi-dbg">${dbgText} · fmt:${k.format}</div>
      </div>`;
    }).join('')}</div>`;
  }

  validCharts.forEach(c => {
    const dbgText      = `x:${c.x_column} | y:${c.y_column} | ${c.aggregation}`;
    const isTableLike  = ['table', 'matrix', 'multi_row_card'].includes(c.type);
    const isSlicerCard = c.type === 'slicer';
    const isSankeyCard = c.type === 'sankey';
    html += `<div class="chart-card${c.width === 2 ? ' wide' : ''}${isTableLike ? ' table-card' : ''}${isSlicerCard ? ' slicer-card' : ''}${isSankeyCard ? ' sankey-card' : ''}" id="card-${c.id}">
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

/* ══ Button slicer click handler ══════════════════════════ */

function handleSlicerClick(wrap, event) {
  const btn = event.target.closest('.slicer-btn');
  if (!btn) return;
  const col = wrap.dataset.slicerCol;
  const val = btn.dataset.val;

  if (val === '__all__') {
    AppState.filters[col] = [];
  } else {
    const current = Array.isArray(AppState.filters[col]) ? [...AppState.filters[col]] : [];
    const idx = current.indexOf(val);
    if (idx === -1) current.push(val);
    else current.splice(idx, 1);
    AppState.filters[col] = current;
  }

  /* Partial re-render: update slicer button states in-place,
     replot only the non-slicer charts — no full HTML rebuild */
  _refreshChartsAfterFilter();
}

function _refreshChartsAfterFilter() {
  const spec = AppState.currentSpec;
  if (!spec) return;
  const data = getFilteredData();

  (spec.charts || []).forEach(c => {
    if (c.type === 'slicer') {
      /* Update active/inactive states without recreating buttons */
      const wrap = document.querySelector(`#${c.id} .slicer-btn-wrap`);
      if (!wrap) return;
      const selected = new Set(Array.isArray(AppState.filters[c.x_column]) ? AppState.filters[c.x_column] : []);
      wrap.querySelectorAll('.slicer-btn').forEach(btn => {
        const v = btn.dataset.val;
        btn.classList.toggle('active', v === '__all__' ? selected.size === 0 : selected.has(v));
      });
    } else {
      /* Re-render chart content with fresh filtered data */
      const el = document.getElementById(c.id);
      if (!el) return;
      try { if (typeof Plotly !== 'undefined') Plotly.purge(c.id); } catch (_) {}
      setTimeout(() => renderChart(c, data), 0);
    }
  });

  renderFilterBar(spec);
  renderSlicers(spec);
}

/* ══ Build ═══════════════════════════════════════════════ */

async function buildDashboard() {
  if (AppState.mode === 'powerbi') return _buildPowerBI();

  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt)           { toast('Describe your dashboard requirements first.', 'error'); return; }
  if (!AppState.rawData) { toast('Upload a data file first.', 'error'); return; }
  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  if (!key) {
    showLoading('Generating dashboard…', 'Running local analysis (no API key configured)');
    addLogEntry('user', prompt);
    try {
      const spec = autoGenerateSpec(prompt);
      _postProcessAdvancedCharts(spec, prompt);
      AppState.currentSpec = spec;
      AppState.filters     = {};
      addLogEntry('assistant', `Auto-built: "${spec.title}" — ${spec.charts?.length||0} charts, ${spec.kpi_cards?.length||0} KPIs`);
      renderDashboard(spec);
      document.getElementById('btn-refine').disabled = false;
      document.getElementById('btn-download-pbix').disabled = false;
      document.getElementById('prompt-input').value = '';
      toast('Dashboard built! (Local mode — add a Claude API key in ⚙ Settings for full AI power)', 'warn');
      setStatus(`Dashboard: "${spec.title}" — ${spec.charts?.length||0} charts`);
    } catch (err) {
      addLogEntry('assistant', `Error: ${err.message}`);
      toast(`Error: ${err.message}`, 'error');
      console.error('Auto-generate error:', err);
    } finally { hideLoading(); }
    return;
  }
  console.info('[Build] mode:', AppState.mode, '| model:', localStorage.getItem('claude_model') || 'claude-sonnet-4-6', '| rows:', AppState.rawData?.length, '| key:', key ? key.slice(0,12) + '…' : 'MISSING');

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
    _injectTableIfRequested(spec, prompt);
    _injectSlicersIfRequested(spec, prompt);
    _postProcessAdvancedCharts(spec, prompt);
    _postProcessBarChart(spec, prompt);
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
    _injectTableIfRequested(spec, prompt);
    _injectSlicersIfRequested(spec, prompt);
    _postProcessAdvancedCharts(spec, prompt);
    _postProcessBarChart(spec, prompt);
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
    const previewSpec = convertPbiSpecToPreview(spec, prompt);
    _injectTableIfRequested(previewSpec, prompt);
    _postProcessAdvancedCharts(previewSpec, prompt);   // fix axes, size_column, geo cols, etc.

    // Diagnostic toast — shows raw server response
    const k0raw = spec.kpi_cards[0];
    const k0pre = previewSpec.kpi_cards[0];
    if (k0raw) {
      const rawComp = k0raw.comparison ? `comp=${k0raw.comparison.aggregation}(${k0raw.comparison.column})` : 'RAW:no-comp';
      const rawSec  = k0raw.secondary  ? `sec=${k0raw.secondary.aggregation}(${k0raw.secondary.column})`   : 'RAW:no-sec';
      toast(`SERVER→ "${k0raw.title}" | ${rawComp} | ${rawSec}`, 'info');
    }
    if (k0pre) {
      const preComp = k0pre.comparison ? `comp=✓` : 'PREVIEW:no-comp';
      const preSec  = k0pre.secondary  ? `sec=✓`  : 'PREVIEW:no-sec';
      toast(`PREVIEW→ "${k0pre.title}" | ${preComp} | ${preSec}`, 'info');
    }

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
    a.download = AppState.lastPbitFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);

    addLogEntry('assistant', `Power BI dashboard built: "${spec.title}" — downloading ${result.fileName}`);
    document.getElementById('btn-refine').disabled = false;
    document.getElementById('btn-download-pbix').disabled = false;
    document.getElementById('prompt-input').value = '';
    toast('Power BI template downloaded! Open in Power BI Desktop → data loads automatically → File › Save As to save as .pbix ✓', 'success');
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
  if (!prompt) return [];
  const p = prompt.toLowerCase();
  const types = new Set();

  /* ── Explicit type keywords ── */
  const explicit = /\b(line|area|donut|pie|bar|col(?:umn)?|scatter|bubble|funnel|histogram|waterfall|treemap|combo|matrix|choropleth|scattergeo|gauge)\s*(?:chart|graph|plot|visual|map)?\b/g;
  let m;
  while ((m = explicit.exec(p)) !== null) {
    types.add(/^col(?:umn)?$/.test(m[1]) ? 'bar' : m[1]);
  }

  /* ── Natural language → type ── */
  if (!types.size || /\btrend\b|\bover\s+time\b|\btime\s+series\b|\bby\s+(month|date|week|day|year|quarter)\b|\bmonthly\b|\bweekly\b|\bdaily\b/.test(p)) {
    if (/\btrend\b|\bover\s+time\b|\btime\s+series\b|\bby\s+(month|date|week|day|year|quarter)\b|\bmonthly\b|\bweekly\b|\bdaily\b/.test(p) && !types.has('line') && !types.has('area')) {
      types.add('area');
    }
  }
  if (/\bdistribution\b|\bfrequency\b|\bspread\b|\bhistogram\b|\brange\s+of\b|\bbinned\b/.test(p) && !types.has('histogram')) {
    types.add('histogram');
  }
  if (/\bbreakdown\b|\bproportion\b|\bshare\b|\bcomposition\b|\bpercentage\s+of\b|\bpie\s+chart\b/.test(p) && !types.has('pie') && !types.has('donut')) {
    types.add('donut');
  }
  if (/\bcorrelat(e|ion)\b|\brelationship\s+between\b|\bx\s+(vs|versus)\s+y\b/.test(p) && !types.has('scatter') && !types.has('bubble')) {
    types.add('scatter');
  }
  if (/\bwaterfall\b|\bbridge\s+chart\b|\bvariance\b|\bincrement(al)?\b/.test(p) && !types.has('waterfall')) {
    types.add('waterfall');
  }
  if (/\btreemap\b|\btree\s*map\b|\bnested\s+rect\b|\bdecomposition\s+tree\b/.test(p) && !types.has('treemap')) {
    types.add('treemap');
  }
  if (/\bhierarchy\s*tree\b|\borg\s*chart\b|\bicicle\b|\bhierarchy\b/.test(p) && !types.has('icicle') && !types.has('treemap')) {
    types.add('icicle');
  }
  if (/\bcombo\b|\bdual[\s-]axis\b|\bbar\s+(and|&|with)\s+line\b|\bline\s+(and|&|with)\s+(?:stacked\s+|clustered\s+)?(bar|col(?:umn)?)\b|\b(?:stacked\s+|clustered\s+)?(bar|col(?:umn)?)\s+(and|&|with)\s+line\b/.test(p) && !types.has('combo')) {
    types.add('combo');
  }
  if (/\bmulti[-\s]?row\s+card\b|\bmetrics\s+card\b|\bsummary\s+card\b|\bkpi\s+card\b/.test(p) && !types.has('multi_row_card')) {
    types.add('multi_row_card');
  }
  if (/\bchoropleth\b|\bfilled\s+map\b|\bby\s+country\b|\bby\s+region\b|\bby\s+state\b|\bgeographic\b|\bgeo\s+map\b/.test(p) && !types.has('choropleth')) {
    // Only auto-infer choropleth from implicit geo keywords (by country/region/state) when the
    // user has NOT explicitly mentioned a different chart type (bar, column, col, stacked, etc.).
    // If the user says "stacked col chart by country" they want a bar, not a map.
    const _isExplicitGeo   = /\bchoropleth\b|\bfilled\s+map\b|\bgeographic\b|\bgeo\s+map\b/i.test(p);
    const _hasOtherType    = /\bstacked\b|\bbar\b|\bcol(?:umn)?\b|\bline\b|\barea\b|\bpie\b|\bdonut\b|\bscatter\b|\bhistogram\b|\bwaterfall\b|\btreemap\b|\bcombo\b|\bmatrix\b|\bgauge\b|\bfunnel\b/i.test(p);
    if (_isExplicitGeo || !_hasOtherType) {
      types.add('choropleth');
    }
  }
  if (/\bfunnel\b|\bconversion\b|\bpipeline\s+stage\b|\bstage\s+conversion\b/.test(p) && !types.has('funnel')) {
    types.add('funnel');
  }
  if (/\bdata\s*table\b|\btable\s*(chart|visual|view)\b|\bshow\s+all\s+(columns?|data)\b|\braw\s+data\b/.test(p) && !types.has('table') && !types.has('matrix')) {
    types.add('table');
  }
  if (/\bmatrix\b|\bcross[-\s]tab\b|\bpivot\s*(table|chart|visual)?\b/.test(p) && !types.has('matrix')) {
    types.add('matrix');
  }
  if (/\bgauge\b|\bkpi\s+(?:visual|indicator|gauge)\b|\bspeedometer\b|\bindicator\s+chart\b/.test(p) && !types.has('gauge')) {
    types.add('gauge');
  }

  return [...types];
}

function convertPbiSpecToPreview(spec, prompt) {
  const promptTypes = prompt ? _chartTypesFromPrompt(prompt) : [];
  // PBI specs come from the server with EXPLICITLY resolved columns (table_name is a server-only field).
  // For these specs we MUST NOT re-extract color_column or orientation from the full multi-line prompt —
  // doing so causes cross-chart contamination (e.g. "using OrderStatus in the legend" on line 1 bleeds
  // into every bar chart).  For Claude-API specs (no table_name) the fallback extraction is still needed.
  const _isPbiSpec = !!spec.table_name;

  return {
    title: spec.title,
    description: spec.description,
    kpi_cards: (spec.kpi_cards || []).map(k => ({
      title:        k.title,
      column:       k._column        || k.column      || AppState.columns.find(c => AppState.colTypes[c] === 'number') || AppState.columns[0],
      aggregation:  k._aggregation   || k.aggregation || 'sum',
      format:       k.format || 'number',
      value_column: k._value_column  || k.value_column || undefined,
      // Pass through rich comparison/secondary sub-specs
      ...(k.comparison ? { comparison: k.comparison } : {}),
      ...(k.secondary  ? { secondary:  k.secondary  } : {})
    })),
    charts: (spec.charts || []).map((c, i) => {
      // Start with server-resolved type; allow override only for single-chart prompts that
      // asked for a specific advanced type the old tool schema didn't support (e.g. histogram,
      // waterfall, treemap, multi_row_card) — but only when chart count equals promptTypes count.
      let type = c.type || 'bar';
      const _advancedOverrides = ['histogram','waterfall','treemap','icicle','multi_row_card','combo','choropleth','scattergeo','bubble','matrix','gauge'];
      if (promptTypes.length > 0 && spec.charts && spec.charts.length === promptTypes.length) {
        const wanted = promptTypes[i];
        if (wanted && _advancedOverrides.includes(wanted) && !_advancedOverrides.includes(type)) {
          type = wanted;
        }
      }
      // Also: normalise type strings that claude-agent might output with wrong casing/spacing
      if (/multi.?row.?card/i.test(type))  type = 'multi_row_card';
      if (/choropleth|filled.?map/i.test(type)) type = 'choropleth';
      if (/scatter.?geo|bubble.?map/i.test(type)) type = 'scattergeo';
      const rawAgg = c._aggregation || c.aggregation || 'sum';
      // bubble/scatter/histogram: x-axis fallback prefers numeric; all other types prefer categorical
      const needsNumericX = ['bubble', 'scatter', 'histogram'].includes(type);
      // multi_row_card / gauge: preserve null x_column.
      //   multi_row_card null → "show totals for all records"
      //   gauge null → no grouping dimension (gauge just aggregates all data)
      const xCol = (type === 'multi_row_card' || type === 'gauge')
        ? (c._category_column !== undefined ? c._category_column : c.x_column)
        : (c._category_column || c.x_column ||
            AppState.columns.find(col => needsNumericX
              ? AppState.colTypes[col] === 'number'
              : AppState.colTypes[col] !== 'number'
            ) || AppState.columns[0]);
      // Preserve null y_column for count-based charts — don't fill with a fallback numeric col.
      // Exception: heatmap and matrix always use y_column as a dimension axis, never as a metric,
      // so their y_column must be preserved even when aggregation is 'count'.
      const _yIsAxis = type === 'heatmap' || type === 'matrix';
      const yCol = (!_yIsAxis && rawAgg === 'count') ? null
                 : (c._y_column || c.y_column ||
                    (_yIsAxis
                      ? (AppState.columns.find(col => AppState.colTypes[col] !== 'number') || AppState.columns[0])
                      : (AppState.columns.find(col => AppState.colTypes[col] === 'number')  || AppState.columns[0])
                    ));
      // For matrix charts color_column is the column-dimension — always preserve it
      // For bar charts, fall back to prompt extraction if not set by server
      // For PBI specs: server sends color_column as null (explicit "no legend") or a value.
      // c.color_column != null means server deliberately set a legend column → use it.
      // c.color_column === null means server said "no legend" → never override with prompt.
      // For Claude specs (no table_name): fall back to prompt extraction as before.
      const colorCol = (c.color_column != null)
        ? c.color_column
        : (!_isPbiSpec && type === 'bar' && /\bcluster(?:ed)?\b|\bgrouped\b|\blegend\b|\bstacked\b|\bsplit\s+by\b/i.test(prompt || '')
            ? _extractColorColumnFromPrompt(prompt) : null);

      return {
        id:          c.id || `chart${i + 1}`,
        title:       c.title,
        type,
        x_column:    xCol,
        y_column:    yCol,
        aggregation: needsNumericX ? 'none'
                   : (c._aggregation || c.aggregation || 'sum'),
        width:       c.width || 1,
        // For PBI specs: orientation is always explicitly set by server ('v' or 'h') — never override.
        // For Claude specs: fall back to prompt-based detection if orientation is missing.
        orientation: c.orientation ||
          (type === 'bar' && (
            /\btop\b|\branking?\b/i.test(c.title) ||
            (!_isPbiSpec && /\w[\w\s]{0,25}?\s+on\s+the\s+[Yy][-\s]?axis|\bhorizontal\s+bar\b/i.test(prompt || ''))
          ) ? 'h' : 'v'),
        ...(c.stack_mode  ? { stack_mode:   c.stack_mode }  : {}),
        ...(c.y2_column   ? { y2_column:    c.y2_column }   : {}),
        ...(c.size_column ? { size_column:  c.size_column } : {}),
        sort_by:     (type === 'bubble' || type === 'scatter') ? 'none' : (colorCol ? 'none' : 'y'),
        sort_order:  'desc',
        top_n:       c.top_n || null,
        ...(colorCol ? { color_column: colorCol } : {}),
        ...(type === 'table'  && c.columns ? { columns: c.columns } : {}),
        ...(type === 'multi_row_card' && c.columns  ? { columns:  c.columns  } : {}),
        ...(type === 'multi_row_card' && c.metrics  ? { metrics:  c.metrics  } : {}),
        ...(type === 'matrix' ? { color_column: colorCol || c.color_column } : {}),
        // Gauge-specific optional fields — pass through if present
        ...(type === 'gauge' && c.min_value    != null ? { min_value:    c.min_value    } : {}),
        ...(type === 'gauge' && c.max_value    != null ? { max_value:    c.max_value    } : {}),
        ...(type === 'gauge' && c.target_value != null ? { target_value: c.target_value } : {}),
        ...(type === 'gauge' && c.format               ? { format:       c.format       } : {}),
        // Gantt-specific: preserve end_column and color_column (start/end dates + task grouping)
        ...(type === 'gantt' && c.end_column  ? { end_column:  c.end_column  } : {}),
        // Heatmap-specific: preserve value_column / z_column if server set one
        ...(type === 'heatmap' && c.value_column ? { value_column: c.value_column } : {}),
        ...(type === 'heatmap' && c.z_column     ? { z_column:     c.z_column     } : {}),
        // Bullet-specific: preserve target_column
        ...(type === 'bullet' && c.target_column ? { target_column: c.target_column } : {})
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
  if (expr.includes('MEDIANX') || expr.includes('MEDIAN(')) return 'median';
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

  // Charts grid — restore original ready hint
  document.getElementById('charts-grid').innerHTML = '';
  const hint = document.getElementById('ready-hint');
  if (hint) hint.style.display = '';

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
  document.getElementById('btn-download-excel').disabled = true;

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
