const http  = require('http');
const https = require('https');

/* ═══════════════════════════════════════════════
   HTTP HELPERS
═══════════════════════════════════════════════ */

function httpPost(baseUrl, path, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const buf     = Buffer.from(body, 'utf8');

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path,
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length }
    };

    const req = lib.request(options, res => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error(`Ollama returned ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0,200)}`)));
        return;
      }

      let content = '';
      let rawBuf  = '';

      res.on('data', chunk => {
        rawBuf += chunk.toString('utf8');
        const lines = rawBuf.split('\n');
        rawBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message?.content) content += obj.message.content;
            if (!obj.done && obj.response) content += obj.response;
          } catch (_) {}
        }
      });

      res.on('end', () => {
        if (rawBuf.trim()) {
          try {
            const obj = JSON.parse(rawBuf);
            if (obj.message?.content) content += obj.message.content;
            if (obj.response) content += obj.response;
          } catch (_) {}
        }
        resolve(JSON.stringify({ message: { content } }));
      });

      res.on('error', reject);
    });

    req.on('error', err => reject(new Error(`Cannot reach Ollama — run: ollama serve (${err.message})`)));
    req.write(buf);
    req.end();
  });
}

function httpGet(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const url     = new URL(baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const options = { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path, method: 'GET' };
    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/* ═══════════════════════════════════════════════
   OLLAMA PROMPT — titles & types ONLY
   No column names asked. We resolve columns ourselves.
═══════════════════════════════════════════════ */

const SYSTEM_PROMPT = `You are a dashboard layout designer. Name dashboard components based on user requirements.

Return ONLY valid JSON, no explanation, no markdown:
{
  "title": "Dashboard title",
  "kpis": [
    { "title": "Total Revenue" },
    { "title": "Total Orders" }
  ],
  "charts": [
    { "title": "Revenue by Category", "type": "bar" }
  ]
}

For "type" use exactly one of: bar, line, area, pie, donut, scatter, funnel
Create exactly as many kpis and charts as the user requests. Use the user's exact wording for titles.`;

/* ═══════════════════════════════════════════════
   COLUMN UTILITIES
═══════════════════════════════════════════════ */

function _norm(s) { return String(s || '').toLowerCase().replace(/[\s_\-]+/g, ''); }
function _normSerial(s) { return _norm(s).replace(/\./g, ''); }

// Synonym groups: if a title contains a KEY word, try COL patterns on actual columns.
// Revenue group includes price/unit patterns — common in orders datasets (UnitPrice = revenue col).
const SYNONYM_GROUPS = [
  { keys: ['revenue','income','earning','turnover','gross','sales total','total sales',
           'value','order value','avg value','average value','sale value'],
    cols: ['revenue','totalprice','totalamount','salestotal','salesamount','gross','subtotal',
           'income','total','sales','amount','price','unitprice','unit_price'],
    numeric: true  },
  { keys: ['sales'],
    cols: ['sales','revenue','amount','gross','netsales','salesamount','price','unitprice'],
    numeric: true  },
  { keys: ['profit','margin','net income','net profit'],
    cols: ['profit','margin','net','netprofit','grossproft'],
    numeric: true  },
  { keys: ['price','unit price','unitprice','rate','unit cost'],
    cols: ['price','rate','unitprice','unit_price','cost','tariff'],
    numeric: true  },
  { keys: ['quantity','qty','units sold','items','volume'],
    cols: ['quantity','qty','units','items','volume','count'],
    numeric: true  },
  { keys: ['salary','wage','pay','compensation','annual salary','monthly salary'],
    cols: ['annualsalary','salary','annual_salary','wage','pay','compensation','ctc','income'],
    numeric: true  },
  { keys: ['discount'],
    cols: ['discount','disc','rebate'],
    numeric: true  },
  { keys: ['cost','expense','spend'],
    cols: ['cost','expense','spend','charges'],
    numeric: true  },
  { keys: ['order','transaction','purchase','sr no','sr. no','serial no','serial number','sno','row no','record'],
    cols: ['orderid','order_id','transactionid','invoiceid','orderno','ordernum','srno','sno','sr_no','serialno','serialnumber','rowno','rownum'],
    numeric: false },
  { keys: ['customer','client','buyer'],
    cols: ['customerid','customer_id','clientid','userid','buyerid'],
    numeric: false },
  { keys: ['product','item','sku','goods'],
    cols: ['product','productname','item','sku','itemname','goods','productid'],
    numeric: false },
  { keys: ['category','cat','class','segment','type'],
    cols: ['category','cat','class','segment','type','subcategory'],
    numeric: false },
  { keys: ['sub category','subcategory','sub-category'],
    cols: ['subcategory','sub_category','subcat'],
    numeric: false },
  { keys: ['region','country','countries','state','states','city','cities','location','area','territory','zone'],
    cols: ['region','country','state','city','location','area','territory','zone','district'],
    numeric: false },
  { keys: ['date','month','year','time','period','trend','monthly','yearly','weekly'],
    cols: ['date','orderdate','created','time','month','year','period','shipdate'],
    numeric: false },
  { keys: ['ship','shipping','delivery'],
    cols: ['shipmode','shippingmode','delivery','courier'],
    numeric: false },
  { keys: ['payment','method'],
    cols: ['paymentmethod','payment','method'],
    numeric: false }
];

// Numeric columns that are demographics / sequential IDs — poor choices as a primary metric
const NON_METRIC_NUM = /^(age|weight|height|bmi|score|rating|rank|seq|sequence|index|rowno|rownum|srno|sno|sr_no|serialno|serialnumber|year|yearno|monthno|dayno)$/;

// Returns true when a numeric column is a meaningful business metric (revenue, qty, etc.)
function _isUsefulMetric(col) {
  return !NON_METRIC_NUM.test(_norm(col));
}

// Returns string columns suitable as chart x-axis (excludes pure ID columns)
function _goodXCols(columns, colTypes) {
  return columns.filter(c => {
    if (colTypes[c] === 'number') return false;
    // Skip columns that look like raw IDs: end with "id", or are named just "id"
    const n = c.toLowerCase().replace(/[\s_\-]/g,'');
    if (/id$/.test(n) && n.length < 15) return false;
    return true;
  });
}

function _findBestCol(hint, columns, colTypes, preferNumeric) {
  if (!hint || !columns.length) return columns[0];
  const h = _norm(hint);

  // 1. Exact / case-insensitive / normalized
  let col = columns.find(c => c === hint)
    || columns.find(c => c.toLowerCase() === hint.toLowerCase())
    || columns.find(c => _norm(c) === h);
  if (col) return col;

  // 2. Substring of hint or hint is substring of column
  //    Require nc.length > 3 to avoid short names (e.g. "age") matching inside words ("average")
  //    Respect preferNumeric so string columns don't block numeric lookups
  col = columns.find(c => {
    const nc = _norm(c);
    return nc.length > 3 && (nc.includes(h) || h.includes(nc)) && (!preferNumeric || colTypes[c] === 'number');
  });
  if (col) return col;
  // If not found with type filter, try non-numeric columns only when preferNumeric is false
  if (!preferNumeric) {
    col = columns.find(c => {
      const nc = _norm(c);
      return nc.length > 3 && (nc.includes(h) || h.includes(nc));
    });
    if (col) return col;
  }

  // 3. Word-by-word match
  const words = hint.toLowerCase().replace(/[_\-]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
  if (words.length) {
    col = columns.find(c => words.every(w => c.toLowerCase().includes(w)));
    if (col && (!preferNumeric || colTypes[col] === 'number')) return col;
    if (preferNumeric) {
      col = columns.find(c => colTypes[c] === 'number' && words.some(w => c.toLowerCase().includes(w)));
    } else {
      col = columns.find(c => words.some(w => c.toLowerCase().includes(w)));
    }
    if (col) return col;
  }

  // 4. Synonym expansion — iterate patterns first so specific patterns (e.g. 'totalprice')
  //    win over generic ones (e.g. 'price') regardless of column order in the dataset.
  for (const group of SYNONYM_GROUPS) {
    const matchesKey = group.keys.some(k => h.includes(k) || k.includes(h));
    if (matchesKey) {
      for (const pat of group.cols) {
        const candidate = columns.find(c =>
          (_norm(c).includes(pat) || pat.includes(_norm(c)))
          && (!preferNumeric || colTypes[c] === 'number')
        );
        if (candidate) return candidate;
      }
      if (!preferNumeric) {
        for (const pat of group.cols) {
          const candidate = columns.find(c =>
            _norm(c).includes(pat) || pat.includes(_norm(c))
          );
          if (candidate) return candidate;
        }
      }
    }
  }

  // When preferNumeric and nothing matched via strict type filter, try a strong name match
  // ignoring column type — handles salary/amount columns classified as string due to formatting.
  // Exclude serial/ID/demographic columns so we don't accidentally return Sr.No or Age.
  if (preferNumeric && words.length) {
    const fallback = columns.find(c => {
      if (/id$/i.test(c)) return false;
      if (NON_METRIC_NUM.test(_norm(c))) return false;
      if (/^(srno|sno|sr_no|serialno|serialnumber|rowno|rownum|srnum)$/i.test(_normSerial(c))) return false;
      // Only return columns that look like business metrics, not categorical columns
      if (!/salary|wage|pay|revenue|amount|price|cost|profit|income|sales|total|value|spend|budget|fee|tax|bonus/i.test(c)) return false;
      return words.some(w => c.toLowerCase().includes(w));
    });
    if (fallback) return fallback;
  }

  return preferNumeric
    ? null
    : (columns.find(c => colTypes[c] === 'string') || columns[0]);
}

/* ═══════════════════════════════════════════════
   KPI TITLE → COLUMN + AGGREGATION
═══════════════════════════════════════════════ */

function titleToKpi(title, columns, colTypes) {
  const t = title.toLowerCase();
  const numCols = columns.filter(c => colTypes[c] === 'number');
  const strCols = columns.filter(c => colTypes[c] === 'string');

  // Best revenue column — skip demographic / sequential numerics (age, rank, sr.no, etc.)
  const usefulNumCols = numCols.filter(_isUsefulMetric);
  const primaryNumCol = _findBestCol('revenue', columns, colTypes, true)
    || _findBestCol('total', columns, colTypes, true)
    || _findBestCol('price', columns, colTypes, true)
    || usefulNumCols[usefulNumCols.length - 1]
    || numCols[numCols.length - 1]
    || numCols[0];

  // "Top X by Y" → show the label (name) of the top category, not a dollar amount
  // e.g. "Top Product by Revenue" → { column:'Product', aggregation:'top_label', value_column:'TotalPrice' }
  const topByKpiMatch = t.match(/\btop\s+([\w][\w\s]{0,20}?)\s+by\s+([\w][\w\s]{0,20}?)(?:\s*$)/);
  if (topByKpiMatch) {
    const labelHint = topByKpiMatch[1].trim();
    const valueHint = topByKpiMatch[2].trim();
    const labelCol  = _findBestCol(labelHint, columns, colTypes, false);
    if (labelCol && colTypes[labelCol] !== 'number') {
      const valueCol = _findBestCol(valueHint, columns, colTypes, true) || numCols[0];
      return { column: labelCol, aggregation: 'top_label', format: 'text', value_column: valueCol };
    }
  }

  // Aggregation hints from title
  const isAvg  = /average|avg|mean/.test(t);
  const isCount = /\bcount\b|\bnumber of\b|\btotal\s+(?:number|count)/.test(t);
  const isMax  = /\btop\b|\bmaximum\b|\bhighest\b/.test(t) && !/product|item|category/.test(t);
  const isMin  = /\bminimum\b|\blowest\b/.test(t);

  // Order/customer/product counts → count_distinct
  const isOrderCount    = /total\s+order|number.*order|order.*count/.test(t);
  const isCustomerCount = /total\s+customer|number.*customer|unique.*customer/.test(t);
  const isProductCount  = /total\s+product|number.*product|unique.*product/.test(t);

  let col, agg, fmt;

  if (isOrderCount) {
    col = _findBestCol('order', columns, colTypes, false);
    agg = 'count_distinct'; fmt = 'number';
  } else if (isCustomerCount) {
    col = _findBestCol('customer', columns, colTypes, false);
    agg = 'count_distinct'; fmt = 'number';
  } else if (isProductCount) {
    col = _findBestCol('product', columns, colTypes, false);
    agg = 'count_distinct'; fmt = 'number';
  } else if (isCount) {
    // Prefer a meaningful categorical column referenced in the title (e.g. "Number of Countries" → Country)
    // Exclude ID-suffix columns (Employee ID, Order ID, etc.) from the preferred match
    const catMatch = _findBestCol(t, columns, colTypes, false);
    const isIdCol  = catMatch && /\bid\b|_id$|id$/i.test(catMatch);
    const goodCat  = catMatch && colTypes[catMatch] === 'string' && !isIdCol ? catMatch : null;
    col = goodCat
       || columns.find(c => /^(srno|sno|sr_no|serialno|serialnumber|rowno|rownum)$/i.test(_normSerial(c)))
       || columns.find(c => /id$/i.test(c))
       || catMatch;
    agg = 'count_distinct'; fmt = 'number';
  } else if (isAvg) {
    col = _findBestCol(t, columns, colTypes, true) || primaryNumCol;
    agg = 'mean';
    fmt = /revenue|sales|price|amount|value|profit|salary|wage|pay/.test(t) ? 'currency' : 'number';
  } else if (isMax) {
    col = _findBestCol(t, columns, colTypes, true) || primaryNumCol;
    agg = 'max'; fmt = 'number';
  } else if (isMin) {
    col = _findBestCol(t, columns, colTypes, true) || primaryNumCol;
    agg = 'min'; fmt = 'number';
  } else {
    // Default: sum of the most relevant numeric column
    col = _findBestCol(t, columns, colTypes, true);
    if (!col || colTypes[col] !== 'number') col = primaryNumCol;
    agg = 'sum';
    fmt = /revenue|sales|price|amount|value|profit|cost|spend/.test(t) ? 'currency' : 'number';
  }

  const finalCol = col || primaryNumCol;
  // Summing/counting a serial/row-number column is meaningless —
  // prefer count_distinct on a categorical column from the title, else plain count
  const isSerial = finalCol && /^(srno|sno|sr_no|serialno|serialnumber|rowno|rownum|srnum)$/i.test(_normSerial(finalCol));
  if (isSerial && (agg === 'sum' || agg === 'count' || agg === 'count_distinct')) {
    const catFromTitle = _findBestCol(t, columns, colTypes, false);
    const isIdCol = catFromTitle && /\bid\b|_id$|id$/i.test(catFromTitle);
    if (catFromTitle && colTypes[catFromTitle] === 'string' && !isIdCol) {
      return { column: catFromTitle, aggregation: 'count_distinct', format: 'number' };
    }
    agg = 'count';
  }

  return { column: finalCol, aggregation: agg, format: fmt };
}

/* ═══════════════════════════════════════════════
   CHART TITLE + TYPE → X/Y COLUMNS + AGGREGATION
═══════════════════════════════════════════════ */

function titleToChart(title, type, idx, columns, colTypes) {
  const t       = title.toLowerCase();
  const numCols = columns.filter(c => colTypes[c] === 'number');
  const goodX   = _goodXCols(columns, colTypes);   // string cols that are NOT raw IDs
  const dateCol = columns.find(c => colTypes[c] === 'date')
               || goodX.find(c => /date|month|year|time/i.test(c));

  // Pre-identify key categorical columns (ordered by specificity)
  const catCol  = goodX.find(c => /^category$/i.test(c))   || goodX.find(c => /\bcategor/i.test(c));
  const subCat  = goodX.find(c => /sub.?cat/i.test(c));
  const prodCol = goodX.find(c => /\bproduct\b|\bitem\b/i.test(c));
  const regCol  = goodX.find(c => /region|country|state|city|location|territory/i.test(c));
  const segCol  = goodX.find(c => /segment|type|class|mode|method/i.test(c));

  // Rotation pool — meaningful categoricals, no repeats, no nulls
  const rotPool = [...new Set([catCol, subCat, prodCol, regCol, segCol].filter(Boolean))];
  // If pool is small, pad with remaining goodX columns
  goodX.forEach(c => { if (!rotPool.includes(c)) rotPool.push(c); });

  let xCol = null;

  // ── Step 1: "Top X by Y" pattern → X is the category, Y is the metric ──
  const topByMatch = t.match(/\btop\s+([\w][\w\s]{0,20}?)\s+by\s+([\w][\w\s]{0,20}?)(?:\s*$|\s*(?:chart|graph))/);
  if (topByMatch) {
    const catHint = topByMatch[1].trim();   // e.g. "products"
    const c = _findBestCol(catHint, columns, colTypes, false);
    if (c && goodX.includes(c)) xCol = c;
  }

  // ── Step 2: "X by Y" where Y resolves to numeric → X is the category ──
  if (!xCol) {
    const byMatch = t.match(/\bby\s+([\w][\w\s]{0,25}?)(?=\s*$|\s*(?:\band\b|chart|graph|breakdown|distribution|trend|analysis))/);
    if (byMatch) {
      const byHint  = byMatch[1].trim();
      const c = _findBestCol(byHint, columns, colTypes, false);
      if (c && goodX.includes(c)) {
        xCol = c;                           // "by Category" → Category ✓
      } else {
        // byHint is a metric (numeric) — use what comes BEFORE "by" as category
        const beforeBy = t.match(/^([\w][\w\s]{0,30}?)\s+by\s+/);
        if (beforeBy) {
          const subj = beforeBy[1].replace(/\b(top|total|monthly|weekly|yearly|daily|all)\b/g,'').trim();
          const c2 = _findBestCol(subj, columns, colTypes, false);
          if (c2 && goodX.includes(c2)) xCol = c2;
        }
      }
    }
  }

  // ── Step 3: N-gram scan of the title against column names ─────────────
  // Handles: "Coupon Usage"→CouponCode, "Referral Source Performance"→ReferralSource
  if (!xCol) {
    const stopWords = new Set(['top','total','monthly','weekly','yearly','daily','the',
      'and','for','per','vs','over','all','chart','graph','performance','analysis',
      'breakdown','distribution','split','usage','trend','comparison','summary']);
    const words = t.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
    outer: for (let len = Math.min(words.length, 3); len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        const c = _findBestCol(phrase, columns, colTypes, false);
        if (c && goodX.includes(c)) { xCol = c; break outer; }
      }
    }
  }

  // ── Step 4: Type-driven fallback (no title clues found) ───────────────
  if (!xCol) {
    if (type === 'line' || type === 'area') {
      xCol = dateCol || rotPool[0] || goodX[0];
    } else if (type === 'pie' || type === 'donut') {
      xCol = catCol || subCat || prodCol || segCol || rotPool[0] || goodX[0];
    } else {
      xCol = rotPool[idx % Math.max(rotPool.length, 1)] || goodX[0];
    }
  }

  // Safety: never use a numeric or ID column as x-axis
  if (!xCol || !goodX.includes(xCol)) xCol = goodX[0] || columns[0];

  // Primary revenue column — skip demographic / sequential numerics (age, rank, sr.no, etc.)
  const usefulNumCols = numCols.filter(_isUsefulMetric);
  const primaryNumCol = _findBestCol('revenue', columns, colTypes, true)
    || _findBestCol('total', columns, colTypes, true)
    || _findBestCol('price', columns, colTypes, true)
    || _findBestCol('sales', columns, colTypes, true)
    || usefulNumCols[usefulNumCols.length - 1]
    || numCols[numCols.length - 1]
    || numCols[0];

  // Y column — find best numeric column from title keywords
  const titleYCol = _findBestCol(t, columns, colTypes, true);
  let yCol = titleYCol;
  // Helper: is a column a plausible metric even if string-typed? (e.g. salary with comma formatting)
  const isMetricCol = c => c && /salary|wage|pay|revenue|amount|price|cost|profit|income|sales|total|value|spend/i.test(c);

  if (!yCol || (colTypes[yCol] !== 'number' && !isMetricCol(yCol))) {
    const stripped = t
      .replace(/\b(by|per|for|over|across|and|the|chart|graph|trend|breakdown|distribution|analysis|monthly|weekly|yearly|daily|top|split|usage|performance|comparison|summary)\b/g, ' ')
      .trim();
    yCol = _findBestCol(stripped, columns, colTypes, true);
  }
  if (!yCol || (colTypes[yCol] !== 'number' && !isMetricCol(yCol))) yCol = primaryNumCol;

  // Pie/donut always count; bar/column charts count when the title signals breakdown/distribution
  const isCountChart = type === 'pie' || type === 'donut'
    || /breakdown|distribution|split|composition|share|usage|frequency|mix|proportion/.test(t);

  // No explicit numeric metric found AND no metric keyword in title → count (not a random sum)
  const noMetricInTitle = !titleYCol && !/revenue|sales|amount|price|value|profit|cost|quantity|total/.test(t);

  const agg = /average|avg|mean/.test(t) ? 'mean'
            : /\bcount\b|number of/.test(t) ? 'count'
            : (isCountChart || noMetricInTitle) ? 'count'
            : 'sum';

  const srNoCol = columns.find(c =>
    /^(srno|sno|sr_no|serialno|serialnumber|rowno|rownum|srnum)$/i.test(_normSerial(c))
  );

  // For count charts, use Sr.No as the y reference instead of Age/metric
  if (agg === 'count' || agg === 'count_distinct') {
    if (srNoCol) yCol = srNoCol;
  }

  // If yCol resolved to a serial/row-number column, summing it is meaningless — use count
  const finalIsSerial = yCol && /^(srno|sno|sr_no|serialno|serialnumber|rowno|rownum|srnum)$/i.test(_normSerial(yCol));
  const finalAgg = (finalIsSerial && agg === 'sum') ? 'count' : agg;

  return { x_column: xCol, y_column: yCol, aggregation: finalAgg };
}

/* ═══════════════════════════════════════════════
   DAX GENERATION
═══════════════════════════════════════════════ */

function buildDaxMeasures(kpis, charts, tableName) {
  const measures = [];
  const seen = new Set();

  const add = (title, column, aggregation, format, valueColumn) => {
    if (!title || seen.has(title)) return;
    seen.add(title);
    const col  = column || '';
    const vcol = valueColumn || '';
    const agg  = (aggregation || 'sum').toLowerCase();
    let expr, fmtStr;
    switch (agg) {
      case 'count':          expr = `COUNTROWS('${tableName}')`;                    fmtStr = '#,0';    break;
      case 'count_distinct': expr = `DISTINCTCOUNT('${tableName}'[${col}])`;        fmtStr = '#,0';    break;
      case 'mean':           expr = `AVERAGE('${tableName}'[${col}])`;              fmtStr = '#,0.00'; break;
      case 'max':            expr = `MAX('${tableName}'[${col}])`;                  fmtStr = '#,0';    break;
      case 'min':            expr = `MIN('${tableName}'[${col}])`;                  fmtStr = '#,0';    break;
      case 'top_label':
        expr = vcol
          ? `MAXX(TOPN(1,SUMMARIZE('${tableName}','${tableName}'[${col}],"_v",SUM('${tableName}'[${vcol}])),[_v],DESC),'${tableName}'[${col}])`
          : `FIRSTNONBLANKVALUE('${tableName}'[${col}],SUM('${tableName}'[${col}]))`;
        fmtStr = '@'; break;
      default:               expr = `SUM('${tableName}'[${col}])`;                  fmtStr = '#,0';
    }
    const fmt = (format || 'number').toLowerCase().replace(/[^a-z]/g, '');
    if (fmt === 'currency')   fmtStr = '$#,0.00';
    if (fmt === 'percentage') fmtStr = '0.00%';
    measures.push({ name: title, expression: expr, format_string: fmtStr });
  };

  kpis.forEach(k => add(k.title, k._column, k._aggregation, k.format, k._value_column));
  charts.forEach(c => {
    const name = c.title;
    if (!seen.has(name)) add(name, c._y_column, c._aggregation, 'number');
  });

  return measures;
}

/* ═══════════════════════════════════════════════
   JSON EXTRACTION
═══════════════════════════════════════════════ */

function extractJson(text) {
  const s = text.trim().replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'');
  let pos = 0;
  while (pos < s.length) {
    const idx = s.indexOf('{', pos);
    if (idx === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = idx; i < s.length; i++) {
      const c = s[i];
      if (esc)                { esc = false; continue; }
      if (c === '\\' && inStr){ esc = true;  continue; }
      if (c === '"')          { inStr = !inStr; continue; }
      if (inStr)              continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(s.slice(idx, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
    pos = idx + 1;
  }
  return null;
}

/* ═══════════════════════════════════════════════
   PascalCase table name
═══════════════════════════════════════════════ */

function fileNameToTableName(fileName) {
  if (!fileName) return 'DataTable';
  const base = fileName.replace(/\.[^.]+$/, '');
  return base.split(/[\s_\-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('').replace(/[^a-zA-Z0-9]/g, '') || 'DataTable';
}

/* ═══════════════════════════════════════════════
   COLUMN PROFILE (for Ollama context)
═══════════════════════════════════════════════ */

function buildColumnProfile(columns, colTypes, csvData) {
  const lines       = csvData.split('\n').filter(l => l.trim());
  const headers     = lines[0] ? lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim()) : columns;
  const sampleLines = lines.slice(1, Math.min(51, lines.length));
  const rows        = sampleLines.map(line => {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    vals.push(cur.trim());
    const obj = {}; headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });

  return columns.map(col => {
    const type   = colTypes[col] || 'string';
    const vals   = rows.map(r => r[col]).filter(v => v != null && v !== '');
    const unique = [...new Set(vals)];
    const samples = unique.slice(0, 3).map(v => `"${v}"`).join(', ');
    return `  ${col} [${type}] samples: ${samples}`;
  }).join('\n') + `\n  (${lines.length - 1} rows total)`;
}

/* ═══════════════════════════════════════════════
   FILTER HELPERS
═══════════════════════════════════════════════ */

function _extractFiltersFromPrompt(prompt, columns, colTypes) {
  // Explicit "no filters" → empty array
  if (/\bno\s+filters?\b|\bwithout\s+filters?\b|\bno\s+slicers?\b/i.test(prompt)) return [];

  // If the user didn't mention filters at all → return null (caller uses auto-generation)
  if (!/\bfilters?\b|\bslicers?\b/i.test(prompt)) return null;

  // Try every pattern variant to extract the column-list string
  const patterns = [
    /[–\-•]?\s*filters?\s+for\s+([^.\n]+)/i,
    /[–\-•]?\s*slicers?\s+for\s+([^.\n]+)/i,
    /add\s+(?:a\s+)?(?:filters?|slicers?)\s+(?:on\s+|for\s+)?([^.\n]+)/i,
    /include\s+(?:a\s+)?(?:filters?|slicers?)\s+(?:on\s+|for\s+)?([^.\n]+)/i,
    /filter\s+(?:by|on)\s+([^.\n]+)/i,
  ];

  let hintsStr = null;
  for (const pat of patterns) {
    const m = prompt.match(pat);
    if (m) { hintsStr = m[1].trim(); break; }
  }

  // Keyword found but couldn't parse column list → return empty (don't dump all columns)
  if (!hintsStr) return [];

  const parts = hintsStr
    .split(/,|\band\b|;/)
    .map(s => s.replace(/^[–\-•\s]+|[–\-•\s]+$/g, '').trim())
    .filter(Boolean);

  const filters = [];
  const seen = new Set();
  for (const part of parts) {
    const col = _findBestCol(part, columns, colTypes, false);
    if (col && !seen.has(col)) {
      seen.add(col);
      filters.push({ column: col, label: col, type: colTypes[col] === 'date' ? 'date' : 'categorical' });
    }
  }
  return filters;
}

function _autoFilters(columns, colTypes) {
  const dateFilters = columns
    .filter(c => colTypes[c] === 'date')
    .map(c => ({ column: c, label: 'Date Range', type: 'date' }));
  const catFilters = _goodXCols(columns, colTypes)
    .filter(c => !/address|tracking|number\b/i.test(c))
    .map(c => ({ column: c, label: c }));
  return [...dateFilters, ...catFilters];
}

/* ═══════════════════════════════════════════════
   MAIN ENTRY POINT
═══════════════════════════════════════════════ */

async function buildDashboardWithOllama(csvData, columns, colTypes, prompt, fileName) {
  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model     = process.env.OLLAMA_MODEL || 'llama3.2';
  const tableName = fileNameToTableName(fileName);

  // Ask Ollama for TITLES AND TYPES ONLY — no columns, no aggregations
  const colProfile  = buildColumnProfile(columns, colTypes, csvData);
  const userMessage = `Dataset columns:\n${colProfile}\n\nUser requirements: ${prompt}\n\nReturn JSON with dashboard title, kpi titles, and chart titles/types only.`;

  console.log(`[ollama-agent] Calling ${model} for titles…`);
  console.log(`[ollama-agent] Columns:`, columns.map(c => `${c}[${colTypes[c]}]`).join(', '));
  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage }
    ],
    stream: true,
    format: 'json',
    options: { temperature: 0.1, num_predict: 2048 }
  });

  const responseText = await httpPost(ollamaUrl, '/api/chat', payload);
  const data    = JSON.parse(responseText);
  const content = data?.message?.content || '';
  if (!content) throw new Error('Ollama returned empty response. Run: ollama pull ' + model);

  const raw = extractJson(content);
  if (!raw) throw new Error('Could not parse JSON from Ollama response.');

  // Sanitize chart type values
  const validTypes = ['bar','line','area','pie','donut','scatter','funnel'];
  const sanitizeType = v => {
    const s = String(v||'').toLowerCase().replace(/[^a-z]/g,'');
    return validTypes.includes(s) ? s : 'bar';
  };

  // Build KPIs — resolve columns server-side by title
  const kpi_cards = (raw.kpis || raw.kpi_cards || []).map((k, i) => {
    const title  = String(k.title || `KPI ${i+1}`);
    const resolved = titleToKpi(title, columns, colTypes);
    return { title, ...resolved };
  });

  // Build charts — resolve x/y columns server-side by title + index
  const charts = (raw.charts || []).map((c, i) => {
    const title = String(c.title || `Chart ${i+1}`);
    const type  = sanitizeType(c.type);
    const resolved = titleToChart(title, type, i, columns, colTypes);
    return { id: `chart${i+1}`, title, type, ...resolved, width: c.width === 2 ? 2 : 1 };
  });

  // Filters — honour explicit user request first, fall back to auto-generation
  const filters = _extractFiltersFromPrompt(prompt, columns, colTypes) || _autoFilters(columns, colTypes);

  // Store resolved _column/_aggregation/_y_column/_category_column for browser
  kpi_cards.forEach(k => {
    k._column = k.column;
    k._aggregation = k.aggregation;
    if (k.value_column) k._value_column = k.value_column;
  });
  charts.forEach(c => { c._y_column = c.y_column; c._category_column = c.x_column; c._aggregation = c.aggregation; });

  // Generate DAX from resolved columns
  const dax_measures = buildDaxMeasures(kpi_cards, charts, tableName);

  // Set measure_name and category_column for pbit-builder
  kpi_cards.forEach(k => { k.measure_name = k.title; });
  charts.forEach(c => { c.measure_name = c.title; c.category_column = c.x_column; });

  const spec = { title: raw.title || `${fileName} Dashboard`, table_name: tableName, kpi_cards, charts, dax_measures, filters };

  console.log(`[ollama-agent] Spec: "${spec.title}" — ${charts.length} charts, ${kpi_cards.length} KPIs`);
  console.log(`[ollama-agent] KPIs:`, kpi_cards.map(k=>`${k.title}[${k._aggregation}:${k._column}]`).join(' | '));
  console.log(`[ollama-agent] Charts:`, charts.map(c=>`${c.title}[${c.type} x:${c.x_column} y:${c.y_column}]`).join(' | '));
  return spec;
}

/* ═══════════════════════════════════════════════
   HEALTH CHECK
═══════════════════════════════════════════════ */

async function checkOllamaHealth(ollamaUrl, model) {
  const url  = (ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
  const text = await httpGet(url, '/api/tags');
  const data = JSON.parse(text);
  const models      = (data.models || []).map(m => m.name);
  const modelLoaded = models.some(m => m === model || m.startsWith(model + ':'));
  return { models, modelLoaded };
}

/* ═══════════════════════════════════════════════
   PROCESS PRE-FETCHED OLLAMA CONTENT
   Used when the browser calls Ollama itself and
   sends the raw LLM content to the server.
═══════════════════════════════════════════════ */

async function processOllamaContent(ollamaContent, csvData, columns, colTypes, prompt, fileName) {
  const tableName = fileNameToTableName(fileName);

  if (!ollamaContent) throw new Error('Empty Ollama response received.');

  const raw = extractJson(ollamaContent);
  if (!raw) throw new Error('Could not parse JSON from Ollama response.');

  const validTypes = ['bar','line','area','pie','donut','scatter','funnel'];
  const sanitizeType = v => {
    const s = String(v||'').toLowerCase().replace(/[^a-z]/g,'');
    return validTypes.includes(s) ? s : 'bar';
  };

  const kpi_cards = (raw.kpis || raw.kpi_cards || []).map((k, i) => {
    const title    = String(k.title || `KPI ${i+1}`);
    const resolved = titleToKpi(title, columns, colTypes);
    return { title, ...resolved };
  });

  const charts = (raw.charts || []).map((c, i) => {
    const title    = String(c.title || `Chart ${i+1}`);
    const type     = sanitizeType(c.type);
    const resolved = titleToChart(title, type, i, columns, colTypes);
    return { id: `chart${i+1}`, title, type, ...resolved, width: c.width === 2 ? 2 : 1 };
  });

  const filters = _extractFiltersFromPrompt(prompt, columns, colTypes) || _autoFilters(columns, colTypes);

  kpi_cards.forEach(k => {
    k._column       = k.column;
    k._aggregation  = k.aggregation;
    if (k.value_column) k._value_column = k.value_column;
  });
  charts.forEach(c => {
    c._y_column        = c.y_column;
    c._category_column = c.x_column;
    c._aggregation     = c.aggregation;
  });

  const dax_measures = buildDaxMeasures(kpi_cards, charts, tableName);

  kpi_cards.forEach(k => { k.measure_name = k.title; });
  charts.forEach(c => { c.measure_name = c.title; c.category_column = c.x_column; });

  const spec = {
    title:       raw.title || `${fileName} Dashboard`,
    table_name:  tableName,
    kpi_cards,
    charts,
    dax_measures,
    filters
  };

  console.log(`[ollama-agent] Spec (client-Ollama): "${spec.title}" — ${charts.length} charts, ${kpi_cards.length} KPIs`);
  console.log(`[ollama-agent] KPIs:`,   kpi_cards.map(k=>`${k.title}[${k._aggregation}:${k._column}]`).join(' | '));
  console.log(`[ollama-agent] Charts:`, charts.map(c=>`${c.title}[${c.type} x:${c.x_column} y:${c.y_column}]`).join(' | '));
  return spec;
}

module.exports = { buildDashboardWithOllama, processOllamaContent, checkOllamaHealth, buildColumnProfile, SYSTEM_PROMPT };
