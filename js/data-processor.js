/**
 * data-processor.js — Data aggregation, KPI computation, and formatting
 * Depends on: state.js (AppState)
 */

/* ════════════════════════════
   FILTERED DATA
   ════════════════════════════ */

/**
 * Return the raw dataset with active sidebar filters applied.
 * @returns {Object[]}
 */
/* ── Robust number parser ─────────────────────────────── */
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  // Strip currency symbols, thousands separators, whitespace; handle (123) as -123
  const s = String(v).trim()
    .replace(/[£€$¥₹,\s]/g, '')
    .replace(/^\((.+)\)$/, '-$1');
  return Number(s);
}

function getFilteredData() {
  if (!AppState.rawData) return [];
  const dateCol  = AppState.filters.__dateCol;
  const dateFrom = AppState.filters.__dateFrom ? parseRowDate(AppState.filters.__dateFrom) : null;
  const dateTo   = AppState.filters.__dateTo   ? parseRowDate(AppState.filters.__dateTo + 'T23:59:59') : null;

  return AppState.rawData.filter(row => {
    // Date range
    if (dateCol && (dateFrom || dateTo)) {
      const rd = parseRowDate(row[dateCol]);
      if (rd) {
        if (dateFrom && rd < dateFrom) return false;
        if (dateTo   && rd > dateTo)   return false;
      }
    }
    // Multi-select / single-value categorical filters
    return Object.entries(AppState.filters).every(([col, val]) => {
      if (col.startsWith('__')) return true;
      if (!val || (Array.isArray(val) && !val.length)) return true;
      const rv = String(row[col] ?? '');
      if (Array.isArray(val)) {
        // '__empty__' matches blank/null values
        return val.includes(rv) || (val.includes('__empty__') && rv === '');
      }
      return val === 'all' || rv === String(val);
    });
  });
}

function parseRowDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Try native parse (works for ISO, most date strings)
  let d = new Date(s);
  if (!isNaN(d)) return d;
  // DD/MM/YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) { d = new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`); if (!isNaN(d)) return d; }
  return null;
}

/* ════════════════════════════
   AGGREGATION ENGINE
   ════════════════════════════ */

/**
 * Group rows by xColumn, compute an aggregate of yColumn.
 *
 * @param {Object[]} data
 * @param {string}   xColumn   - Grouping column
 * @param {string}   yColumn   - Numeric column to aggregate (or null for count)
 * @param {string}   agg       - 'sum'|'count'|'mean'|'max'|'min'
 * @returns {{ x: string, y: number }[]}
 */
function aggregateData(data, xColumn, yColumn, agg) {
  if (!xColumn) return [];

  const map = new Map();

  data.forEach(row => {
    const key = String(row[xColumn] ?? '(blank)');
    if (!map.has(key)) map.set(key, { count: 0, sum: 0, values: [] });
    const g = map.get(key);
    g.count++;
    if (yColumn) {
      const n = toNum(row[yColumn]);
      if (!isNaN(n)) { g.sum += n; g.values.push(n); }
    }
  });

  return [...map.entries()].map(([x, g]) => {
    let y = 0;
    switch (agg) {
      case 'count': y = g.count; break;
      case 'sum':   y = g.sum;   break;
      case 'mean':  y = g.values.length ? g.sum / g.values.length : 0; break;
      case 'max':   y = g.values.length ? Math.max(...g.values) : 0;   break;
      case 'min':   y = g.values.length ? Math.min(...g.values) : 0;   break;
      default:      y = yColumn ? g.sum : g.count;
    }
    return { x, y };
  });
}

/* ════════════════════════════
   KPI COMPUTATION
   ════════════════════════════ */

/**
 * Compute a single KPI value from filtered data.
 * @param {Object[]} data
 * @param {{ column: string, aggregation: string }} kpi
 * @returns {number}
 */
function computeKPI(data, kpi) {
  if (kpi.aggregation === 'count') return data.length;

  // count_distinct: count unique non-null values of kpi.column
  if (kpi.aggregation === 'count_distinct') {
    const col = kpi.column;
    const unique = new Set(data.map(r => r[col]).filter(v => v != null && v !== ''));
    return unique.size;
  }

  // top_label: return the NAME of the category with the highest total of value_column
  // spec: { column: "Product", value_column: "Revenue", aggregation: "top_label" }
  if (kpi.aggregation === 'top_label') {
    const labelCol = kpi.column;
    const valCol   = kpi.value_column || kpi.column;
    const totals   = {};
    data.forEach(r => {
      const label = String(r[labelCol] ?? '');
      const val   = Number(r[valCol]);
      if (label) totals[label] = (totals[label] || 0) + (isNaN(val) ? 1 : val);
    });
    const top = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : '—';
  }

  const vals = data
    .map(r => toNum(r[kpi.column]))
    .filter(n => !isNaN(n));

  if (!vals.length) return 0;

  switch (kpi.aggregation) {
    case 'sum':  return vals.reduce((a, b) => a + b, 0);
    case 'mean': return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'median': {
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    case 'max':  return Math.max(...vals);
    case 'min':  return Math.min(...vals);
    default:     return vals.reduce((a, b) => a + b, 0);
  }
}

/* ════════════════════════════
   FORMATTING HELPERS
   ════════════════════════════ */

/**
 * Format a KPI value for display.
 * @param {number} v
 * @param {{ format: string, prefix: string, suffix: string }} kpi
 * @returns {string}
 */
function formatKPIValue(v, kpi) {
  // String values (e.g. top_label returns a name)
  if (typeof v === 'string') return v || '—';

  // Guard against null / undefined / NaN
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—';

  // For currency, default prefix to '$' if not explicitly set
  const pfx = kpi.format === 'currency'
    ? (typeof kpi.prefix === 'string' ? kpi.prefix : '$')
    : (kpi.prefix || '');
  const sfx = kpi.suffix || '';

  if (kpi.format === 'percentage') return `${pfx}${(v * 100).toFixed(2)}%${sfx}`;

  // Full comma-separated number, 2 decimal places — no K/M/B shortening
  const fmt = (n, decimals = 2) => {
    try {
      return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    } catch (_) { return n.toFixed(decimals); }
  };

  if (kpi.format === 'currency') return `${pfx}${fmt(v)}${sfx}`;

  // Integer counts (count / count_distinct / whole numbers) → no decimals
  if (Number.isInteger(v) || kpi.aggregation === 'count' || kpi.aggregation === 'count_distinct') {
    try { return `${pfx}${v.toLocaleString()}${sfx}`; } catch (_) { return `${pfx}${v}${sfx}`; }
  }

  return `${pfx}${fmt(v)}${sfx}`;
}

/**
 * Short number format for chart labels.
 * @param {number} n
 * @returns {string}
 */
function shortNumber(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ════════════════════════════
   DATA CONTEXT BUILDER
   Summarises dataset for Claude
   ════════════════════════════ */

/**
 * Build a data context for Claude that mirrors what Claude Chat sees
 * when a user uploads a CSV file — raw CSV text + concise column stats.
 */
function buildDataContext() {
  const data = AppState.rawData;
  const cols = AppState.columns;

  // --- Column profiles (plain text, one line per column) ---
  const profileLines = cols.map(c => {
    const allVals = data.map(r => r[c]).filter(v => v !== null && v !== undefined && v !== '');
    const type = AppState.colTypes[c];

    if (type === 'number') {
      const nums = allVals.map(toNum).filter(n => !isNaN(n)).sort((a, b) => a - b);
      if (!nums.length) return `${c} [numeric]: no values`;
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / nums.length;
      return `${c} [numeric]: min=${r2(nums[0])}, max=${r2(nums[nums.length-1])}, mean=${r2(mean)}, sum=${r2(sum)}, count=${nums.length}`;
    } else {
      const unique = [...new Set(allVals.map(String))];
      if (unique.length <= 50) {
        return `${c} [${type}]: ${unique.length} unique → ${unique.join(' | ')}`;
      }
      // top-20 by frequency for high-cardinality columns
      const freq = {};
      allVals.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([v]) => v);
      return `${c} [${type}]: ${unique.length} unique, top values → ${top.join(' | ')}`;
    }
  });

  // --- Raw CSV (up to 1000 rows) so Claude sees the actual data ---
  const maxRows = 1000;
  const csvRows = data.slice(0, maxRows);
  const header = cols.map(csvEscape).join(',');
  const csvLines = csvRows.map(r =>
    cols.map(c => csvEscape(r[c] ?? '')).join(',')
  );
  const csvText = [header, ...csvLines].join('\n');

  return {
    fileName: AppState.fileName,
    totalRows: data.length,
    profileText: profileLines.join('\n'),
    csvText,
    rowsSent: csvRows.length
  };
}

function r2(n) { return Math.round(n * 100) / 100; }

function csvEscape(v) {
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}
