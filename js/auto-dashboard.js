/**
 * auto-dashboard.js — Free-mode heuristic dashboard generator (no API key needed)
 * Analyses uploaded data + user prompt to produce the same JSON spec format
 * that the dashboard renderer already understands.
 */

/* ════════════════════════════
   MAIN ENTRY POINT
   ════════════════════════════ */

function autoGenerateSpec(prompt) {
  const cols     = AppState.columns;
  const colTypes = AppState.colTypes;
  const data     = AppState.rawData;
  if (!cols?.length || !data?.length) throw new Error('No data loaded');

  const p = (prompt || '').toLowerCase();

  /* ── Classify columns ── */
  const numCols  = cols.filter(c => colTypes[c] === 'number');
  const dateCols = cols.filter(c => colTypes[c] === 'date');
  const catCols  = cols.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date');

  /* ── Cardinality ── */
  const card = {};
  catCols.forEach(c => {
    card[c] = new Set(data.map(r => r[c]).filter(v => v != null && v !== '')).size;
  });

  /* ── Usable categorical columns (2–60 unique values) ── */
  const usableCats = catCols.filter(c => card[c] >= 2 && card[c] <= 60);

  /* ── Prompt-relevance score ── */
  const promptScore = col => {
    const n = col.toLowerCase().replace(/_/g, ' ');
    let s = 0;
    if (p.includes(n)) s += 10;
    n.split(' ').forEach(w => { if (w.length > 2 && p.includes(w)) s += 3; });
    return s;
  };

  /* ── Rank by (prompt relevance + domain importance) ── */
  const numRanked = [...numCols].sort((a, b) =>
    (promptScore(b) + _numPri(b)) - (promptScore(a) + _numPri(a))
  );
  const catRanked = [...usableCats].sort((a, b) =>
    (promptScore(b) + _catPri(b, card[b])) - (promptScore(a) + _catPri(a, card[a]))
  );

  const mainDate = dateCols[0] || null;

  /* ── Parse prompt for explicit "X by Y" / chart-type hints ── */
  const hints = _parsePrompt(p, cols, colTypes, card, numRanked, catRanked, mainDate);

  return {
    title:       _extractTitle(p) || (numRanked[0] ? _tc(numRanked[0]) + ' Analytics' : 'Data Dashboard'),
    description: 'Auto-generated dashboard',
    kpi_cards:   _buildKPIs(p, numRanked, catRanked, cols, colTypes),
    charts:      _buildCharts(hints, numRanked, catRanked, mainDate, card),
    filters:     _buildFilters(catRanked, mainDate, card)
  };
}

/* ════════════════════════════
   PROMPT PARSER
   Extracts explicit column / chart-type hints
   ════════════════════════════ */

function _parsePrompt(p, cols, colTypes, card, numRanked, catRanked, mainDate) {
  const hints = { forceCharts: [] };

  const _isFin = c => /revenue|sales|amount|cost|price|value|profit|income|spend|earning/.test((c||'').toLowerCase());
  const _pickFin = pool => pool.find(c => _isFin(c)) || pool[0];

  /* ── Helper: best-matching column for a word (with synonym fallback) ── */
  const matchCol = (word, pool) => {
    if (!word || !pool.length) return null;
    const w = word.toLowerCase().replace(/[_\s\-]/g, ' ').trim();
    /* 1. Try _bestCol fuzzy match first */
    const fuzzy = _bestCol(w, pool);
    if (fuzzy) return fuzzy;
    /* 2. Financial synonym fallback: revenue/income/earnings → best financial col */
    if (/revenue|income|earnings|turnover/.test(w)) {
      const fin = _pickFin(pool);
      if (fin) return fin;
    }
    /* 3. Profit synonym */
    if (/profit|margin|net/.test(w)) {
      const pc = pool.find(c => /profit|margin|net/.test(c.toLowerCase()));
      if (pc) return pc;
    }
    /* 4. Cost synonym */
    if (/cost|spend|expense/.test(w)) {
      const cc = pool.find(c => /cost|spend|expense/.test(c.toLowerCase()));
      if (cc) return cc;
    }
    /* 5. Quantity synonym */
    if (/quantity|qty|units|volume|count/.test(w)) {
      const qc = pool.find(c => /quantity|qty|unit|volume/.test(c.toLowerCase()));
      if (qc) return qc;
    }
    return null;
  };

  /* ── "X by Y" → chart request ── */
  const byPat = /(\b\w[\w\s]{1,20}?)\s+by\s+([\w\s]{1,20}?\b)/g;
  let m;
  while ((m = byPat.exec(p)) !== null) {
    const a = matchCol(m[1].trim(), cols);
    const b = matchCol(m[2].trim(), cols);
    if (a && b) {
      const yCol = colTypes[a] === 'number' ? a : (colTypes[b] === 'number' ? b : numRanked[0]);
      const xCol = yCol === a ? b : a;
      if (xCol && yCol && colTypes[xCol] !== 'number') {
        const isDist  = card[xCol] <= 7;
        const isDate  = colTypes[xCol] === 'date';
        hints.forceCharts.push({
          xCol, yCol,
          type: isDate ? 'area' : isDist ? 'donut' : 'bar',
          orientation: (!isDate && !isDist && card[xCol] > 5) ? 'h' : 'v',
          wide: isDate
        });
      }
    }
  }

  /* ── "trend" / "over time" / "monthly" → area of main numeric ── */
  if (/trend|over time|monthly|daily|weekly|by month|by date/.test(p) && mainDate && numRanked[0]) {
    const yCol = matchCol(p.split(/trend|over time|monthly/)[0].trim().split(' ').pop(), numRanked) || numRanked[0];
    hints.forceCharts.push({ xCol: mainDate, yCol, type: 'area', orientation: 'v', wide: true });
  }

  /* ── "top X" / "ranking" / "best" → horizontal bar ── */
  if (/top\s+\d*\s*\w|\branking\b|\bbest\b/.test(p) && catRanked[0] && numRanked[0]) {
    const cat = matchCol(p.replace(/top\s+\d+\s*/g, '').split(' ')[0], catRanked) || catRanked[0];
    hints.forceCharts.push({ xCol: cat, yCol: numRanked[0], type: 'bar', orientation: 'h', wide: false });
  }

  /* ── "distribution" / "breakdown" / "share" → donut ── */
  if (/distribution|breakdown|share|proportion|pie/.test(p) && catRanked[0]) {
    const cat = catRanked.find(c => card[c] <= 10) || catRanked[0];
    hints.forceCharts.push({ xCol: cat, yCol: numRanked[0] || null, type: 'donut', orientation: 'v', wide: false });
  }

  return hints;
}

/* ════════════════════════════
   KPI BUILDER  — prompt-first
   ════════════════════════════ */

function _buildKPIs(p, numRanked, catRanked, cols, colTypes) {
  const out  = [];
  const seen = new Set();

  /* How many KPIs did the user ask for? ("4 KPI cards", "3 metrics") */
  const cntM = p.match(/(\d+)\s+kpi\b|(\d+)\s+(?:metric|card|kpis)/i);
  const MAX  = cntM ? Math.min(parseInt(cntM[1] || cntM[2]), 8) : 6;

  const add = k => {
    if (out.length >= MAX) return;
    const key = `${k.aggregation}:${k.column || '_count_'}`;
    if (!seen.has(key)) { seen.add(key); out.push(k); }
  };

  const isFin   = c => /revenue|sales|amount|cost|price|value|profit|income|spend|earning/.test((c||'').toLowerCase());
  const pickFin = () => numRanked.find(c => isFin(c)) || numRanked[0];

  /* Does this column's name have any word (≥3 chars) that appears in the prompt? */
  const colMentioned = col => {
    const words = col.toLowerCase().replace(/[_\-]+/g, ' ').split(/\s+/).filter(w => w.length >= 3);
    return words.some(w => p.includes(w));
  };

  /* Financial synonyms: if prompt has these words, treat as mentioning financial columns */
  const finSynonyms = /\brevenue\b|\bincome\b|\bearnings?\b|\bturnover\b|\bsales\b|\bprofit\b|\bcosts?\b|\bspend\b|\bamount\b/;

  /* ─────────────────────────────────────────────────
     PHASE 1 — extract explicit KPI requests from prompt
     ───────────────────────────────────────────────── */

  /* "total/sum [metric]"  →  sum */
  _scan(p, /\b(?:total|sum(?:\s+of)?)\s+([\w\s]{2,30}?)(?=[,;]|\band\b|\bkpi\b|\bchart\b|\bwith\b|$)/gi, m => {
    const hint = m[1].trim();
    const col = _bestCol(hint, numRanked) || (isFin(hint) ? pickFin() : null);
    if (col) {
      /* Use the user's label ("Revenue") when we fell back to a proxy column ("Sales") */
      const label = _bestCol(hint, numRanked) ? _tc(col) : _tc(hint);
      add({ title: `Total ${label}`, column: col, aggregation: 'sum', format: isFin(col) ? 'currency' : 'number' });
    }
  });

  /* "average/avg/mean/aov [metric]"  →  mean */
  _scan(p, /\b(?:average|avg|mean|aov)\s+([\w\s]{2,30}?)(?=[,;]|\band\b|\bkpi\b|\bchart\b|\bwith\b|$)/gi, m => {
    const hint = m[1].trim();
    const col = _bestCol(hint, numRanked) || (isFin(hint) ? pickFin() : numRanked[0]);
    if (col) {
      const label = _bestCol(hint, numRanked) ? _tc(col) : _tc(hint);
      add({ title: `Avg ${label}`, column: col, aggregation: 'mean', format: isFin(col) ? 'currency' : 'number' });
    }
  });

  /* "number of / count of / total [entity]"  →  count or count_distinct */
  _scan(p, /\b(?:number\s+of|count\s+of|total\s+(?:number\s+of\s+)?)(orders?|customers?|users?|transactions?|records?|entries|rows?|[\w\s]{2,20}?)(?=[,;]|\band\b|\bkpi\b|$)/gi, m => {
    const hint = m[1].trim();
    /* Skip financial metrics — handled by the sum scan above */
    if (isFin(hint)) return;
    const numMatch = _bestCol(hint, numRanked);
    if (numMatch) {
      add({ title: `Total ${_tc(hint)}`, column: numMatch, aggregation: 'sum', format: 'number' });
    } else {
      const idCol = cols.find(c =>
        new RegExp(hint.replace(/s$/, ''), 'i').test(c) && colTypes[c] !== 'number'
      );
      if (idCol) {
        add({ title: `Total ${_tc(hint)}`, column: idCol, aggregation: 'count_distinct', format: 'number' });
      } else {
        add({ title: `Total ${_tc(hint)}`, column: cols[0], aggregation: 'count', format: 'number' });
      }
    }
  });

  /* "top [category] by [metric]" / "best [category]"  →  top_label */
  _scan(p, /\b(?:top|best|highest[- ]selling)\s+([\w\s]{2,20}?)(?:\s+by\s+([\w\s]{2,20}?))?(?=[,;]|\band\b|\bkpi\b|\bchart\b|$)/gi, m => {
    const catCol = _bestCol(m[1].trim(), catRanked) || catRanked[0];
    const numCol = m[2] ? (_bestCol(m[2].trim(), numRanked) || numRanked[0]) : numRanked[0];
    if (catCol && numCol) {
      add({ title: `Top ${_tc(catCol)}`, column: catCol, value_column: numCol, aggregation: 'top_label', format: 'text' });
    }
  });

  /* "max/highest/peak [metric]"  →  max */
  _scan(p, /\b(?:max(?:imum)?|highest|peak)\s+([\w\s]{2,25}?)(?=[,;]|\band\b|\bkpi\b|$)/gi, m => {
    const col = _bestCol(m[1].trim(), numRanked);
    if (col) add({ title: `Max ${_tc(col)}`, column: col, aggregation: 'max', format: 'number' });
  });

  /* bare column names near "kpi" section e.g. "kpi cards: revenue, orders, profit margin" */
  const kpiSection = p.match(/kpi\s*(?:cards?|metrics?)[\s:,]*([^.!?]+)/i);
  if (kpiSection) {
    kpiSection[1].split(/[,;&]+/).map(t => t.trim()).filter(Boolean).forEach(tok => {
      if (/\b(?:total|average|avg|count|top|number|sum)\b/.test(tok)) return; // handled by scan passes
      const numCol = _bestCol(tok, numRanked);
      if (numCol) {
        add({ title: `Total ${_tc(tok)}`, column: numCol, aggregation: 'sum', format: isFin(numCol) ? 'currency' : 'number' });
      } else if (isFin(tok)) {
        const fc = pickFin();
        if (fc) add({ title: `Total ${_tc(tok)}`, column: fc, aggregation: 'sum', format: 'currency' });
      } else {
        /* entity term like "orders", "customers" → count_distinct */
        const idCol = cols.find(c => new RegExp(tok.replace(/s$/, ''), 'i').test(c) && colTypes[c] !== 'number');
        if (idCol) add({ title: `Total ${_tc(tok)}`, column: idCol, aggregation: 'count_distinct', format: 'number' });
      }
    });
  }

  /* ─────────────────────────────────────────────────
     PHASE 2 — per-column scan of the prompt
     For every numeric column whose name words appear in
     the prompt, add a KPI. This catches prompts like
     "show revenue, profit, orders" with no "total/avg" keywords.
     ───────────────────────────────────────────────── */

  /* 2a. Check each numeric column individually */
  for (const col of numRanked) {
    if (out.length >= MAX) break;
    if (out.some(k => k.column === col)) continue; // already added in Phase 1

    const mentioned = colMentioned(col) || (isFin(col) && finSynonyms.test(p));
    if (!mentioned) continue;

    /* If "average/avg/mean" is anywhere near the column word in the prompt → mean, else sum */
    const colWord = col.toLowerCase().replace(/[_\-]+/g, ' ').split(/\s+/).find(w => w.length >= 3) || '';
    const nearAvg = new RegExp(`(?:average|avg|mean|aov)\\s+(?:[\\w\\s]{0,15})${colWord}|${colWord}\\s+(?:[\\w\\s]{0,15})(?:average|avg|mean)`, 'i').test(p);
    if (nearAvg) {
      add({ title: `Avg ${_tc(col)}`, column: col, aggregation: 'mean', format: isFin(col) ? 'currency' : 'number' });
    } else {
      add({ title: `Total ${_tc(col)}`, column: col, aggregation: 'sum', format: isFin(col) ? 'currency' : 'number' });
    }
  }

  /* 2b. Financial synonyms that don't match a column name directly
         e.g. prompt says "revenue" but column is "Sales" */
  if (finSynonyms.test(p) && !out.some(k => k.aggregation === 'sum' && isFin(k.column))) {
    const col = pickFin();
    if (col) add({ title: `Total ${_tc(col)}`, column: col, aggregation: 'sum', format: 'currency' });
  }

  /* 2c. Entity count mentions: "orders", "customers", "transactions" anywhere in prompt */
  const entityPat = /\b(orders?|customers?|users?|transactions?|clients?|entries|records?)\b/gi;
  _scan(p, entityPat, m => {
    if (out.some(k => k.aggregation === 'count' || k.aggregation === 'count_distinct')) return;
    const hint = m[1].toLowerCase().replace(/s$/, '');
    const idCol = cols.find(c => new RegExp(hint, 'i').test(c) && colTypes[c] !== 'number');
    if (idCol) {
      const label = idCol.replace(/\s*id\s*/i, '').trim() || idCol;
      add({ title: `Total ${_tc(label)}`, column: idCol, aggregation: 'count_distinct', format: 'number' });
    } else {
      add({ title: `Total ${_tc(m[1])}`, column: cols[0], aggregation: 'count', format: 'number' });
    }
  });

  /* 2d. "average/avg" without a following column name → avg of best financial col */
  if (/\b(?:average|avg|mean|aov)\b/.test(p) && !out.some(k => k.aggregation === 'mean')) {
    const col = pickFin();
    if (col) add({ title: `Avg ${_tc(col)}`, column: col, aggregation: 'mean', format: isFin(col) ? 'currency' : 'number' });
  }

  /* 2e. "top" keyword → top_label */
  if (/\btop\b/.test(p) && catRanked.length && !out.some(k => k.aggregation === 'top_label')) {
    const catCol = catRanked[0], numCol = numRanked[0];
    if (catCol && numCol) {
      add({ title: `Top ${_tc(catCol)}`, column: catCol, value_column: numCol, aggregation: 'top_label', format: 'text' });
    }
  }

  /* ─────────────────────────────────────────────────
     PHASE 3 — auto-fill remaining slots
     ALWAYS runs — fills up to MAX regardless of earlier results
     ───────────────────────────────────────────────── */

  /* row count — only if not already counting */
  if (!out.some(k => k.aggregation === 'count' || k.aggregation === 'count_distinct')) {
    add({ title: 'Total Records', column: cols[0], aggregation: 'count', format: 'number' });
  }

  /* financial sums */
  numRanked.forEach(c => {
    if (isFin(c)) add({ title: `Total ${_tc(c)}`, column: c, aggregation: 'sum', format: 'currency' });
  });

  /* volume sums */
  numRanked.forEach(c => {
    if (/qty|quantity|unit|order|transaction|volume|item/.test(c.toLowerCase()))
      add({ title: `Total ${_tc(c)}`, column: c, aggregation: 'sum', format: 'number' });
  });

  /* averages for rate/ratio columns */
  numRanked.forEach(c => {
    if (/avg|average|mean|aov|rate|ratio/.test(c.toLowerCase()))
      add({ title: `Avg ${_tc(c)}`, column: c, aggregation: 'mean', format: 'number' });
  });

  /* top label */
  if (catRanked.length && numRanked.length && !out.some(k => k.aggregation === 'top_label')) {
    add({ title: `Top ${_tc(catRanked[0])}`, column: catRanked[0],
          value_column: numRanked[0], aggregation: 'top_label', format: 'text' });
  }

  /* remaining numerics to fill any leftover slots */
  numRanked.forEach(c => {
    add({ title: `Total ${_tc(c)}`, column: c, aggregation: 'sum', format: isFin(c) ? 'currency' : 'number' });
  });

  return out;
}

/* ════════════════════════════
   COLUMN MATCHER  — fuzzy
   ════════════════════════════ */

/**
 * Find the best matching column from `pool` for a free-text query.
 * Returns null if no match scores high enough.
 */
function _bestCol(query, pool) {
  if (!query || !pool.length) return null;
  const q = query.toLowerCase().replace(/[_\-]+/g, ' ').trim();
  let best = null, bestS = 0;

  for (const col of pool) {
    const cn = col.toLowerCase().replace(/[_]+/g, ' ');
    let s = 0;

    if (cn === q)                    s = 100;
    else if (cn.includes(q))         s = 70;
    else if (q.includes(cn) && cn.length > 3) s = 55;
    else {
      const qw = q.split(/\s+/).filter(w => w.length > 2);
      const cw = cn.split(/\s+/).filter(w => w.length > 2);
      const ov = qw.filter(w => cw.some(c => c.includes(w) || w.includes(c)));
      if (ov.length) s = ov.length * 25;
    }

    if (s > bestS) { bestS = s; best = col; }
  }
  return bestS >= 25 ? best : null;
}

/* Run a regex repeatedly over text, calling cb for each match */
function _scan(text, regex, cb) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) cb(m);
}

/* ════════════════════════════
   CHART BUILDER
   ════════════════════════════ */

function _buildCharts(hints, numRanked, catRanked, mainDate, card) {
  const charts  = [];
  const usedKey = new Set(); // "xCol:yCol" already placed
  let   idN     = 1;
  const nid     = () => `ac${idN++}`;
  const MAX     = 8;

  const pushChart = (xCol, yCol, type, opts = {}) => {
    if (charts.length >= MAX) return;
    const key = `${xCol}:${yCol}:${type}`;
    if (usedKey.has(key)) return;
    usedKey.add(key);
    charts.push({
      id:          nid(),
      title:       opts.title || _chartTitle(type, xCol, yCol),
      type,
      x_column:    xCol,
      y_column:    yCol,
      aggregation: opts.agg  || (type === 'scatter' ? 'none' : 'sum'),
      orientation: opts.orientation || 'v',
      sort_by:     opts.sort_by     || (type === 'bar' ? 'y' : 'none'),
      sort_order:  opts.sort_order  || 'desc',
      top_n:       opts.top_n       || null,
      width:       opts.wide        ? 2 : 1
    });
  };

  /* ── 1. Prompt-driven forced charts (deduplicated) ── */
  hints.forceCharts.forEach(h => {
    if (!h.xCol || !h.yCol) return;
    const topN = h.type === 'bar' && card[h.xCol] ? Math.min(10, card[h.xCol]) : null;
    pushChart(h.xCol, h.yCol, h.type, {
      orientation: h.orientation,
      wide:        h.wide,
      top_n:       topN
    });
  });

  /* ── 2. Monthly time-series area (if date & not already added) ── */
  if (mainDate && numRanked[0]) {
    pushChart(mainDate, numRanked[0], 'area', { wide: true });
  }

  /* ── 3. Top-N ranking horizontal bar — best categorical ── */
  for (const cat of catRanked) {
    if (charts.length >= MAX) break;
    if (!numRanked[0] || card[cat] < 3) continue;
    pushChart(cat, numRanked[0], 'bar', {
      orientation: 'h', top_n: Math.min(10, card[cat])
    });
    break; // only first ranking chart
  }

  /* ── 4. Low-cardinality donut (2–7 unique values) ── */
  for (const cat of catRanked) {
    if (charts.length >= MAX) break;
    if (card[cat] < 2 || card[cat] > 7) continue;
    pushChart(cat, numRanked[0] || cat, numRanked[0] ? 'donut' : 'donut', {
      agg: numRanked[0] ? 'sum' : 'count'
    });
    break;
  }

  /* ── 5. Second categorical by main numeric ── */
  let usedInCharts = 0;
  for (const cat of catRanked) {
    if (charts.length >= MAX) break;
    if (!numRanked[0] || card[cat] < 2) continue;
    const alreadyUsed = charts.some(c => c.x_column === cat);
    if (alreadyUsed) continue;
    const wide = false;
    pushChart(cat, numRanked[0], 'bar', {
      orientation: card[cat] <= 5 ? 'v' : 'h',
      top_n: card[cat] > 10 ? 10 : null,
      wide
    });
    if (++usedInCharts >= 2) break;
  }

  /* ── 6. Second numeric trend (if date exists) ── */
  if (mainDate && numRanked[1] && charts.length < MAX) {
    pushChart(mainDate, numRanked[1], 'area', { wide: true });
  }

  /* ── 7. Remaining numerics by top cat ── */
  numRanked.slice(1).forEach(yCol => {
    if (charts.length >= MAX) return;
    const cat = catRanked.find(c =>
      !charts.some(ch => ch.x_column === c && ch.y_column === yCol)
      && card[c] >= 3 && card[c] <= 30
    );
    if (cat) {
      pushChart(cat, yCol, 'bar', {
        orientation: 'h', top_n: card[cat] > 10 ? 10 : null
      });
    }
  });

  return charts;
}

/* ════════════════════════════
   FILTER BUILDER
   ════════════════════════════ */

function _buildFilters(catRanked, mainDate, card) {
  const filters = [];
  if (mainDate) filters.push({ column: mainDate, label: _tc(mainDate) });
  catRanked
    .filter(c => card[c] >= 2 && card[c] <= 50)
    .slice(0, 3)
    .forEach(c => filters.push({ column: c, label: _tc(c) }));
  return filters;
}

/* ════════════════════════════
   SCORING HELPERS
   ════════════════════════════ */

function _numPri(col) {
  const n = col.toLowerCase();
  if (/revenue|sales|amount|total|profit/.test(n)) return 8;
  if (/cost|price|value|income|earning/.test(n))   return 6;
  if (/order|transaction|qty|quantity|unit/.test(n)) return 5;
  if (/rate|score|pct|percentage|ratio/.test(n))   return 3;
  return 1;
}

function _catPri(col, c) {
  const n = col.toLowerCase();
  let s = 0;
  if (/category|product|region|country|state|city|segment|department/.test(n)) s += 5;
  if (/status|type|method|channel|source|payment|brand|tier/.test(n))          s += 4;
  if (/name|group|class|code/.test(n))                                         s += 2;
  if (c >= 3 && c <= 15)  s += 3;
  else if (c === 2)        s += 2;
  else if (c <= 30)        s += 1;
  return s;
}

/* ════════════════════════════
   STRING HELPERS
   ════════════════════════════ */

function _tc(col) {
  return (col || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _chartTitle(type, xCol, yCol) {
  const x = _tc(xCol), y = _tc(yCol);
  if (type === 'area' || type === 'line') return `${y} Over Time`;
  if (type === 'donut' || type === 'pie') return `${y} by ${x}`;
  if (type === 'bar')                     return `${y} by ${x}`;
  if (type === 'scatter')                 return `${x} vs ${y}`;
  return `${x} — ${y}`;
}

function _extractTitle(p) {
  const m = p.match(/(?:create|build|show|generate|make)\s+(?:a|an|the|me)?\s*([a-z][a-z\s]{2,30}?)\s*(?:dashboard|report|analysis)/i);
  return m ? _tc(m[1].trim()) + ' Dashboard' : null;
}
