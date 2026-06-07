/**
 * prompt-generator.js — Auto-generates a dashboard prompt from the loaded dataset.
 * Depends on: state.js (AppState), ui-helpers.js (toast)
 */

function generateDashboardPrompt() {
  if (!AppState.rawData || !AppState.columns.length) {
    toast('Upload a dataset first to generate a prompt', 'warn');
    return;
  }

  const types  = AppState.colTypes;
  const sample = AppState.rawData.slice(0, 500);

  /* ── Classify columns ─────────────────────────────── */
  const numCols  = AppState.columns.filter(c => types[c] === 'number');
  const dateCols = AppState.columns.filter(c => types[c] === 'date');
  const strCols  = AppState.columns.filter(c => types[c] === 'string');

  const uniqueCount = col =>
    new Set(sample.map(r => r[col]).filter(v => v != null && v !== '')).size;

  // Sort low-cardinality string cols first (best for grouping)
  const catCols   = strCols.filter(c => uniqueCount(c) <= 25)
                           .sort((a, b) => uniqueCount(a) - uniqueCount(b));
  const hiCatCols = strCols.filter(c => uniqueCount(c) > 25);

  if (!numCols.length && !strCols.length) {
    toast('Dataset needs at least one numeric or categorical column', 'warn');
    return;
  }

  /* ── Keyword classifiers ──────────────────────────── */
  const matches = (col, kws) => kws.some(k => col.toLowerCase().includes(k));

  const sumCols = numCols.filter(c => matches(c,
    ['revenue','sales','amount','total','profit','income','cost','price','value','gross','net','spend','budget','fee']));
  const avgCols = numCols.filter(c => matches(c,
    ['rate','margin','ratio','pct','percent','avg','average','score','rating','index']));
  const cntCols = numCols.filter(c => matches(c,
    ['qty','quantity','units','count','volume']));
  const idCols  = strCols.filter(c => matches(c, ['id','key','code','ref','uuid']));

  const primaryNum   = sumCols[0] || numCols[0];
  const secondaryNum = sumCols[1] || avgCols[0] || numCols[1];
  const tertiaryNum  = sumCols[2] || numCols[2];

  /* ── KPI Cards (4–5) ──────────────────────────────── */
  const kpis    = [];
  const kpiUsed = new Set();

  const addKpi = (agg, col) => {
    if (kpis.length >= 5 || !col || kpiUsed.has(col)) return;
    kpis.push(`${agg} ${col}`);
    kpiUsed.add(col);
  };

  // Sum the top value columns
  for (const c of sumCols.slice(0, 2)) addKpi('total', c);

  // Count — prefer a meaningful string col (skip pure ID cols)
  const countTarget = strCols.filter(c => !idCols.includes(c))[0] || strCols[0];
  if (countTarget && !kpiUsed.has(countTarget)) {
    kpis.push(`count of ${countTarget}`);
    kpiUsed.add(countTarget);
  }

  // Average rate / margin / score
  for (const c of avgCols.slice(0, 1)) addKpi('average', c);

  // Total quantity
  for (const c of cntCols.slice(0, 1)) addKpi('total', c);

  // Fill remaining slots from numeric cols
  for (const c of numCols) {
    if (kpis.length >= 5) break;
    addKpi('total', c);
  }

  /* ── Charts (6–8) ─────────────────────────────────── */
  const charts = [];

  // 1. Area trend — date × primary num
  if (dateCols.length && primaryNum) {
    charts.push(`Area chart for ${primaryNum} trend over ${dateCols[0]}`);
  }

  // 2. Bar — first category × primary num
  if (catCols.length && primaryNum) {
    charts.push(`Bar chart for total ${primaryNum} by ${catCols[0]}`);
  }

  // 3. Donut — mix / share
  if (catCols.length && primaryNum) {
    charts.push(`Donut chart for ${primaryNum} share by ${catCols[0]}`);
  }

  // 4. Horizontal bar — top-10 ranking
  const rankCol = catCols[1] || hiCatCols[0] || catCols[0];
  if (rankCol && primaryNum) {
    charts.push(`Horizontal bar chart for top 10 ${rankCol} by ${primaryNum}`);
  }

  // 5. Second metric over category or date
  if (secondaryNum && secondaryNum !== primaryNum) {
    if (catCols.length) {
      charts.push(`Bar chart for total ${secondaryNum} by ${catCols[0]}`);
    } else if (dateCols.length) {
      charts.push(`Line chart for ${secondaryNum} over ${dateCols[0]}`);
    }
  }

  // 6. Scatter — two numerics
  if (primaryNum && secondaryNum && primaryNum !== secondaryNum) {
    charts.push(`Scatter plot of ${primaryNum} vs ${secondaryNum}`);
  }

  // 7. Second category breakdown
  if (catCols.length > 1 && primaryNum) {
    charts.push(`Bar chart for total ${primaryNum} by ${catCols[1]}`);
  } else if (tertiaryNum && catCols.length) {
    charts.push(`Bar chart for total ${tertiaryNum} by ${catCols[0]}`);
  }

  // 8. Summary data table
  const tableCols = [...catCols.slice(0, 2), ...numCols.slice(0, 3)]
    .filter((v, i, a) => a.indexOf(v) === i);
  if (tableCols.length >= 2) {
    charts.push(`Data table showing ${tableCols.join(', ')}`);
  }

  const finalCharts = charts.slice(0, 8);

  /* ── Box and Whisker Plot ─────────────────────────── */
  // Best numeric: prefer a price/salary/amount column; fall back to first useful numeric
  const boxNum = numCols.find(c => matches(c, ['price','salary','wage','amount','revenue','cost','score','rating','value','spend']))
              || numCols.find(c => !matches(c, ['id','no','num','serial','rank','index','row','sr','qty','count','quantity']))
              || numCols[0];
  // Best grouping: prefer a low-cardinality categorical (2–15 unique values)
  const boxCat = catCols.find(c => { const u = uniqueCount(c); return u >= 2 && u <= 15; })
              || catCols[0];
  const boxLines = [];
  if (boxNum && boxCat) {
    boxLines.push(`– Box and Whisker Plot showing the distribution of ${boxNum} by ${boxCat}`);
  } else if (boxNum) {
    boxLines.push(`– Box and Whisker Plot showing the distribution of ${boxNum}`);
  }

  /* ── Marimekko Chart ──────────────────────────────── */
  // Needs two different categorical columns and one numeric
  const marimekkoLines = [];
  if (catCols.length >= 2 && primaryNum) {
    const mCat1 = catCols[0];
    const mCat2 = catCols.find(c => c !== mCat1) || catCols[1];
    marimekkoLines.push(`– Marimekko chart of ${primaryNum} by ${mCat1} and ${mCat2}`);
  } else if (catCols.length === 1 && hiCatCols.length && primaryNum) {
    marimekkoLines.push(`– Marimekko chart of ${primaryNum} by ${catCols[0]} and ${hiCatCols[0]}`);
  }

  /* ── Filters (up to 3) ────────────────────────────── */
  const filterCols = [];
  if (dateCols.length) filterCols.push(dateCols[0]);
  for (const c of catCols) {
    if (filterCols.length >= 3) break;
    filterCols.push(c);
  }

  /* ── Assemble prompt ──────────────────────────────── */
  const rawName  = (AppState.fileName || 'dataset').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const dashName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

  const lines = [
    `Create a ${dashName} dashboard with:\n`,
    `– KPI cards for ${kpis.join(', ')}`,
    '',
    ...finalCharts.map(c => `– ${c}`),
  ];
  if (filterCols.length) {
    lines.push('');
    lines.push(`– Filters for ${filterCols.join(', ')}`);
  }
  if (boxLines.length) {
    lines.push('');
    lines.push(...boxLines);
  }
  if (marimekkoLines.length) {
    lines.push(...marimekkoLines);
  }

  document.getElementById('prompt-input').value = lines.join('\n');
  document.getElementById('prompt-input').focus();
  toast('Prompt generated — review and click Build Dashboard', 'ok');
}
