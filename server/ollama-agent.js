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

const SYSTEM_PROMPT = `You are a dashboard layout designer. Output ONLY valid JSON — no markdown, no explanation.

FORMAT: {"title":"Dashboard Title","kpis":[{"title":"Total Revenue"}],"charts":[{"title":"Revenue by Category","type":"bar"}]}

TYPES: bar, line, area, pie, donut, scatter, bubble, histogram, funnel, waterfall, treemap, combo, table, matrix, multi_row_card, choropleth, scattergeo, gauge, sankey, gantt, bullet, heatmap, sunburst

RULES:
1. Output EXACTLY the kpis and charts the user asks for — no extras.
2. Use the user's EXACT wording for titles.
3. multi_row_card → ONE chart entry with type "multi_row_card".
4. "trend/over time/monthly/weekly" → line. "distribution/histogram" → histogram. "proportion/share/pie/donut" → pie or donut. "map/choropleth" → choropleth. "gauge/KPI visual/speedometer" → gauge. "matrix/pivot/cross-tab" → matrix. "data table/tabular" → table. "heatmap/heat map/cross-tab density" → heatmap. "sunburst/radial hierarchy/circular hierarchy" → sunburst. "hierarchy tree/org chart/icicle/hierarchy" → icicle. "treemap/nested rectangles/decomposition tree" → treemap.
5. Never invent extra charts or KPIs.`;

/* ═══════════════════════════════════════════════
   COLUMN UTILITIES
═══════════════════════════════════════════════ */

function _norm(s) { return String(s || '').toLowerCase().replace(/[\s_\-]+/g, ''); }

// Extract which columns the user wants in a table from the prompt text.
// Looks for actual column names mentioned near the "table" keyword.
function _extractTableColumns(prompt, columns) {
  if (!prompt) return columns.slice(0, 10);
  if (/\ball\s+(?:the\s+)?columns?\b|\ball\s+data\b|\bfull\s+(?:table|dataset)\b/i.test(prompt)) return columns;

  const pLower = prompt.toLowerCase();
  const tableMatch = pLower.match(/\b(?:data\s*)?table\b/);
  if (!tableMatch) return columns.slice(0, 10);

  // 200-char window after "table" keyword + 20 chars before
  const window = pLower.slice(Math.max(0, tableMatch.index - 20), tableMatch.index + 200);

  const matched = columns.filter(col => {
    const cn = _norm(col);
    if (cn.length < 3) return false;
    return window.includes(col.toLowerCase()) || window.includes(cn);
  });

  return matched.length >= 1 ? matched : columns.slice(0, 10);
}
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
    numeric: false },
  /* ── HR / workforce ── */
  { keys: ['employee','staff','worker','headcount','head count','personnel','workforce'],
    cols: ['employeeid','employee_id','staffid','workerid','empid','emp_id','srno','sno','sr_no','serialno'],
    numeric: false },
  { keys: ['department','dept','team','division','business unit','unit'],
    cols: ['department','dept','team','division','businessunit','business_unit','unit'],
    numeric: false },
  { keys: ['gender','sex'],
    cols: ['gender','sex'],
    numeric: false },
  { keys: ['ethnicity','race','nationality','background'],
    cols: ['ethnicity','race','nationality'],
    numeric: false },
  { keys: ['hire','start date','join date','joining date','onboarding'],
    cols: ['hiredate','hire_date','startdate','joindate','joiningdate','employeddate'],
    numeric: false },
  { keys: ['exit','termination','leave date','end date','resignation'],
    cols: ['exitdate','exit_date','terminationdate','leavedate','enddate'],
    numeric: false },
  { keys: ['bonus','incentive','commission','variable pay'],
    cols: ['bonus','bonuspct','bonus_pct','incentive','commission','variablepay'],
    numeric: true },
  { keys: ['age','tenure','years','experience'],
    cols: ['age','tenure','yearsofexperience','experience'],
    numeric: true },
  { keys: ['job','role','position','title','designation'],
    cols: ['jobtitle','job_title','role','position','designation','title'],
    numeric: false },
  /* ── Finance / banking ── */
  { keys: ['transaction','txn','payment amount','transfer'],
    cols: ['transactionamount','amount','txnamount','paymentamount','transfer'],
    numeric: true },
  { keys: ['balance','account balance','closing balance'],
    cols: ['balance','closingbalance','accountbalance'],
    numeric: true },
  /* ── Healthcare ── */
  { keys: ['patient','admission','visit','encounter'],
    cols: ['patientid','patient_id','admissionid','visitid'],
    numeric: false },
  { keys: ['diagnosis','condition','disease','icd'],
    cols: ['diagnosis','condition','disease','icdcode'],
    numeric: false }
];

// Numeric columns that are demographics / sequential IDs — poor choices as a primary metric
const NON_METRIC_NUM = /^(age|weight|height|bmi|score|rating|rank|seq|sequence|index|rowno|rownum|srno|sno|sr_no|serialno|serialnumber|year|yearno|monthno|dayno)$/;

// Returns true when a numeric column is a meaningful business metric (revenue, qty, etc.)
function _isUsefulMetric(col) {
  return !NON_METRIC_NUM.test(_norm(col));
}

/* ─────────────────────────────────────────────────────────────────────────
   _inferAggFromText(text)
   Centralised aggregation inference from any natural-language phrase.
   Returns one of: 'count' | 'count_distinct' | 'sum' | 'mean' | 'median'
                   'max' | 'min' | null (unknown — caller picks a default)
───────────────────────────────────────────────────────────────────────── */
function _inferAggFromText(text) {
  const t = (text || '').toLowerCase();
  // Count distinct / unique — must test before plain count
  if (/\bcount\s+distinct\b|\bdistinct\s+count\b|\bunique\b|\bdistinct\b/.test(t)) return 'count_distinct';
  // Headcount / plain count
  if (/\bheadcount\b|\bhead\s+count\b|\bnumber\s+of\s+(employee|staff|people|worker|record)\b|\bhow\s+many\b|\btotal\s+(number|count)\s+of\b/.test(t)) return 'count';
  if (/\bcount\b|\bnumber\s+of\b/.test(t)) return 'count';
  // Average
  if (/\baverage\b|\bavg\b|\bmean\b/.test(t)) return 'mean';
  // Median
  if (/\bmedian\b/.test(t)) return 'median';
  // Max
  if (/\bmaximum\b|\bmax\b|\bhighest\b|\blargest\b|\bpeak\b|\blatest\b|\bmost\s+recent\b/.test(t)) return 'max';
  // Min
  if (/\bminimum\b|\bmin\b|\blowest\b|\bsmallest\b|\bearli(est)?\b|\bold(est)?\b/.test(t)) return 'min';
  // Sum / total
  if (/\btotal\b|\bsum\b|\baggregate\b|\boverall\b/.test(t)) return 'sum';
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
   _inferFmtFromCol(col, colTypes)
   Format string for display: 'currency' | 'percent' | 'date' | 'number'
───────────────────────────────────────────────────────────────────────── */
function _inferFmtFromCol(col, colTypes) {
  if (!col) return 'number';
  if (colTypes && colTypes[col] === 'date') return 'date';
  const l = col.toLowerCase();
  if (/salary|pay|compensation|income|revenue|cost|price|budget|spend|earning|wage|bonus|profit|amount|value/.test(l)) return 'currency';
  if (/rate|percent|pct|ratio|margin/.test(l)) return 'percent';
  return 'number';
}

// Returns string columns suitable as chart x-axis (excludes pure ID columns)
function _goodXCols(columns, colTypes) {
  // High-cardinality columns (names, descriptions, free-text) are bad grouping axes
  const _isHighCardinality = c => {
    const n = c.toLowerCase().replace(/[\s_\-]/g, '');
    return /^(fullname|firstname|lastname|name|description|notes?|comment|title|address|email|phone|url|subject)$/.test(n)
        || /name$/.test(n)    // "Full Name", "Employee Name", etc.
        || /title$/.test(n)   // "Job Title", "Position Title", etc.
        || /description$/.test(n); // "Job Description", etc.
  };
  const filtered = columns.filter(c => {
    if (colTypes[c] === 'number') return false;
    const n = c.toLowerCase().replace(/[\s_\-]/g,'');
    if (/id$/.test(n) && n.length < 15) return false;  // Employee ID, Order ID …
    if (_isHighCardinality(c)) return false;
    return true;
  });
  // Prefer date columns last; return at minimum the best non-numeric col
  const nonDate = filtered.filter(c => colTypes[c] !== 'date');
  return nonDate.length ? nonDate : filtered.length ? filtered
    : columns.filter(c => colTypes[c] !== 'number').filter(c => {
        const n = c.toLowerCase().replace(/[\s_\-]/g,'');
        return !(/id$/.test(n) && n.length < 15);
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
  const isMedian    = /\bmedian\b/.test(t);
  const isAvg       = !isMedian && /average|avg|mean/.test(t);
  const isHeadcount = /\bheadcount\b|\bhead\s+count\b|\btotal\s+employees?\b|\bnumber\s+of\s+employees?\b/.test(t);
  const isCount     = !isHeadcount && /\bcount\b|\bnumber of\b|\btotal\s+(?:number|count)/.test(t);
  const isMax  = /\btop\b|\bmaximum\b|\bhighest\b/.test(t) && !/product|item|category/.test(t);
  const isMin  = /\bminimum\b|\blowest\b/.test(t);

  // Order/customer/product counts → count_distinct
  const isOrderCount    = /total\s+order|number.*order|order.*count/.test(t);
  const isCustomerCount = /total\s+customer|number.*customer|unique.*customer/.test(t);
  const isProductCount  = /total\s+product|number.*product|unique.*product/.test(t);

  let col, agg, fmt;

  if (isHeadcount) {
    // Total employee count — plain row count, no column needed
    col = columns[0]; agg = 'count'; fmt = 'number';
  } else if (isOrderCount) {
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
  } else if (isMedian) {
    col = _findBestCol(t, columns, colTypes, true) || primaryNumCol;
    agg = 'median';
    fmt = /revenue|sales|price|amount|value|profit|salary|wage|pay/.test(t) ? 'currency' : 'number';
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

  // Safety: scatter/bubble need numeric x-axis; all other types need a categorical x-axis
  if (type === 'scatter' || type === 'bubble') {
    if (!xCol || colTypes[xCol] !== 'number') xCol = numCols[0] || columns[0];
  } else {
    if (!xCol || !goodX.includes(xCol)) xCol = goodX[0] || columns[0];
  }

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

  // Scatter/bubble: y must be a DIFFERENT numeric column from x
  if ((type === 'scatter' || type === 'bubble') && yCol === xCol) {
    yCol = numCols.find(c => c !== xCol) || primaryNumCol;
  }

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
   MATRIX CHART INJECTION
   llama3.2:1b ignores "type=matrix" instructions.
   This function detects matrix/pivot requests in the prompt
   and injects a proper matrix spec into the charts array.
═══════════════════════════════════════════════ */

function _injectMatrixChart(charts, prompt, columns, colTypes) {
  if (!/\bmatrix\b|\bcross[-\s]?tab\b|\bpivot\s+table\b/i.test(prompt)) return;

  // Always remove Ollama's matrix — its column choices are unreliable
  for (let i = charts.length - 1; i >= 0; i--) {
    if (charts[i].type === 'matrix') charts.splice(i, 1);
  }

  // ── Resolve a fuzzy column name ───────────────────────────
  const findCol = raw => {
    if (!raw) return null;
    // Strip aggregation function wrappers: "Average(Annual Salary)" → "Annual Salary"
    let t = raw.trim()
      .replace(/^(?:average|avg|sum|count|min|max)\s*\(([^)]+)\)$/i, '$1')
      .replace(/^(?:total|average|avg|sum|count\s+of|number\s+of)\s+/i, '')
      .trim().toLowerCase();
    const exact = columns.find(c => c.toLowerCase() === t);
    if (exact) return exact;
    const inc1 = columns.find(c => c.toLowerCase().includes(t));
    if (inc1) return inc1;
    const inc2 = columns.find(c => t.includes(c.toLowerCase()));
    if (inc2) return inc2;
    // Word-level: any meaningful word (>2 chars) matches
    const tWords = t.split(/\s+/).filter(w => w.length > 2);
    return columns.find(c => {
      const cWords = c.toLowerCase().split(/\s+/);
      return tWords.some(tw => cWords.some(cw => cw.includes(tw) || tw.includes(cw)));
    }) || null;
  };

  // ── Row dimension ─────────────────────────────────────────
  // "Country as rows" | "rows: Country" | "places Country on the rows"
  // "matrix of Country vs/by Gender"
  const rowRaw =
    (/(?:places?\s+)?([A-Za-z][\w ]{1,35}?)\s+on\s+the\s+rows?/i.exec(prompt) || [])[1] ||
    (/([A-Za-z][\w ]{1,35}?)\s+as\s+rows?/i.exec(prompt)  || [])[1] ||
    (/rows?\s*[=:]\s*([A-Za-z][\w ]{1,35}?)(?:\s*[,;\n]|$)/i.exec(prompt) || [])[1] ||
    (/matrix\s+(?:\w+\s+)?(?:of\s+)?([A-Za-z][\w ]{1,35}?)\s+(?:vs?\.?|by|×)/i.exec(prompt) || [])[1];

  // ── Column dimension ──────────────────────────────────────
  // "Gender on the columns" | "Gender or Ethnicity on the columns" | "Gender as columns"
  const colRaw =
    (/(?:places?\s+)?([A-Za-z][\w ]{1,35}?)\s+on\s+the\s+columns?/i.exec(prompt) || [])[1] ||
    (/([A-Za-z][\w ]{1,35}?)\s+as\s+columns?/i.exec(prompt) || [])[1] ||
    (/columns?\s*[=:]\s*([A-Za-z][\w ]{1,35}?)(?:\s*[,;\n]|$)/i.exec(prompt) || [])[1] ||
    (/(?:vs?\.?|×)\s+([A-Za-z][\w ]{1,35}?)(?:\s+showing|\s+with|\s*[,;\n]|\s*$)/i.exec(prompt) || [])[1];

  // ── Value / measure ───────────────────────────────────────
  // "Average(Annual Salary)" | "displays the Average(Annual Salary)"
  // "showing total salary" | "sum of salary"
  const valRaw =
    (/(?:average|avg|sum|count|min|max)\s*\(([^)]+)\)/i.exec(prompt) || [])[1] ||
    (/(?:displays?\s+(?:the\s+)?)?(?:average|avg|sum|total|mean)\s+(?:of\s+)?([A-Za-z][\w ]{1,35}?)(?:\s*[,;\n)]|$)/i.exec(prompt) || [])[1] ||
    (/(?:showing|in\s+the\s+(?:grid\s+)?cells?)\s+(?:the\s+)?(?:average|avg|sum|total|mean\s+of\s+)?([A-Za-z][\w ]{1,35}?)(?:\s*[,;\n)]|$)/i.exec(prompt) || [])[1];

  const rowCol = findCol(rowRaw) || columns.find(c => colTypes[c] !== 'number') || columns[0];
  const colCol = findCol(colRaw) || columns.find(c => colTypes[c] !== 'number' && c !== rowCol) || null;
  const valCol = findCol(valRaw) || columns.find(c => colTypes[c] === 'number') || null;

  // Aggregation: explicit function like Average(...) wins; then keyword; default count
  const agg = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt) ? 'mean'
            : /\bsum\b/i.test(prompt) || (/\btotal\b/i.test(prompt) && !/\btotal\s+(?:employees?|headcount|records?|count)\b/i.test(prompt)) ? 'sum'
            : /\bcount\b/i.test(prompt) ? 'count'
            : valCol ? 'sum'   // if a value column was found, default to sum
            : 'count';

  const idx = charts.length + 1;
  const promptTitle = prompt.match(/(?:employee\s+)?(?:salary\s+)?matrix(?:\s+chart)?/i)?.[0] || 'Matrix';
  charts.push({
    id: `matrix${idx}`,
    title: `${promptTitle.trim()}: ${rowCol} × ${colCol || 'Category'}`,
    type:  'matrix',
    x_column:     rowCol,
    y_column:     agg === 'count' ? null : valCol,
    color_column: colCol,
    aggregation:  agg,
    width: 2,
    _y_column:        agg === 'count' ? null : valCol,
    _category_column: rowCol,
    _aggregation:     agg
  });

}

/* ═══════════════════════════════════════════════
   STACKED BAR / COLUMN INJECTION
   llama3.2:1b never outputs stack_mode correctly.
   Handles: stacked column, stacked bar,
            100% stacked column, 100% stacked bar.
═══════════════════════════════════════════════ */

function _injectStackedBarIfRequested(charts, prompt, columns, colTypes) {
  // Must mention "stacked" AND a bar/column keyword
  if (!/\bstacked\b/i.test(prompt)) return;
  if (!/\bbar\b|\bcolumn\b|\bcol\b/i.test(prompt)) return;
  // "stacked column combo" / "line and stacked column" → handled by _injectComboIfRequested
  if (/\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with|overlay)\s+line\b|\bbar\s+(?:and|&|plus)\s+line\b/i.test(prompt)) return;

  // findCol: strips common measure prefixes first so "Employee Count" → null (not "Employee ID")
  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase()
      .replace(/^(?:employee\s+count|headcount|total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
      .trim();
    if (!t) return null;
    return columns.find(c => c.toLowerCase() === t)
        || columns.find(c => c.toLowerCase().includes(t) || t.includes(c.toLowerCase()))
        || (() => {
             const tw = t.split(/\s+/).filter(w => w.length > 2);
             return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null;
           })();
  };

  // stack_mode: 100% → 'percent', plain → 'stack'
  const stack_mode = /\b100\s*%?\s*stacked\b|\bpercent(?:age)?\s+stacked\b/i.test(prompt)
    ? 'percent' : 'stack';

  // ── Category column + orientation ───────────────────────────────────────────
  let catCol = null, valColRaw = null, orientation = null;

  // Priority 1: Explicit axis keywords ("X on the Y-axis / X-axis")
  // Direct column lookup — avoids [\w ]+ span bug where non-greedy regex matches mid-sentence
  const _esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const _axisYCol = columns.find(c => new RegExp('\\b' + _esc(c) + '\\s+on\\s+the\\s+[Yy][-\\s]?axis', 'i').test(prompt)) || null;
  const _axisXCol = columns.find(c => new RegExp('\\b' + _esc(c) + '\\s+on\\s+the\\s+[Xx][-\\s]?axis', 'i').test(prompt)) || null;
  const _yAxisMeasure = /\b(?:employee\s+count|headcount|count\s+of|count)\b[^.!?]*\s+on\s+the\s+[Yy][-\s]?axis/i.test(prompt);
  const _xAxisMeasure = /\b(?:employee\s+count|headcount|count\s+of|count)\b[^.!?]*\s+on\s+the\s+[Xx][-\s]?axis/i.test(prompt);
  if (_axisYCol || _axisXCol || _yAxisMeasure || _xAxisMeasure) {
    if (_axisXCol && colTypes[_axisXCol] !== 'number') {
      catCol = _axisXCol; orientation = 'v';
      valColRaw = _yAxisMeasure ? 'count' : (_axisYCol || null);
    } else if (_axisYCol && colTypes[_axisYCol] !== 'number') {
      catCol = _axisYCol; orientation = 'h';
      valColRaw = _xAxisMeasure ? 'count' : (_axisXCol || null);
    } else if (_yAxisMeasure && _axisXCol) {
      catCol = _axisXCol; orientation = 'v'; valColRaw = 'count';
    } else if (_xAxisMeasure && _axisYCol) {
      catCol = _axisYCol; orientation = 'h'; valColRaw = 'count';
    }
  }

  // Priority 2: "showing X by Y" → check data type to decide which is category
  if (!catCol) {
    const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;]|\s+split\b|\s+using\b|\s*$)/i.exec(prompt);
    if (showByM) {
      const raw1 = showByM[1].trim(), raw2 = showByM[2].trim();
      const col1 = findCol(raw1);
      if (!col1 || colTypes[col1] === 'number') {
        // raw1 is a measure (numeric / unresolved) → raw2 must be the category
        catCol    = findCol(raw2);
        valColRaw = raw1;
      } else {
        // raw1 resolved to a categorical column → it IS the category
        catCol    = col1;
        valColRaw = raw2;
      }
    }
  }

  // Priority 3: plain "by X" — skip when X looks like a measure phrase
  if (!catCol) {
    const byM = /\bby\s+([\w][\w\s]{1,30}?)(?=\s+(?:split|using|color|colour|and|with)\b|\s*[,;]|\s*$)/i.exec(prompt);
    if (byM) {
      const raw = byM[1].trim();
      if (!/\bcount\b|\bnumber\s+of\b|\bsum\b|\btotal\b|\baverage\b|\bemployee\s+count\b/i.test(raw)) {
        catCol = findCol(raw);
      }
    }
  }

  catCol = catCol || columns.find(c => colTypes[c] !== 'number') || columns[0];

  // Default orientation from chart-type keyword if not already set by axis parsing
  if (!orientation) {
    orientation = /\bstacked\s+bar\b/i.test(prompt) && !/\bcolumn\b|\bcol\b/i.test(prompt) ? 'h' : 'v';
  }

  // ── Color / split column ─────────────────────────────────────────────────────
  // _extractColorColFromPrompt now handles "stacked by X" as well as "using X in legend" etc.
  // Do NOT fall back to a random column — a wrong stack dimension is worse than no stacking.
  const colorCol = _extractColorColFromPrompt(prompt, columns, colTypes) || null;

  // ── Value / aggregation ──────────────────────────────────────────────────────
  const isMeasureCount = !valColRaw || /\bcount\b|\bnumber\s+of\b|\bemployee\s+count\b/i.test(valColRaw);
  const valCol = isMeasureCount ? null : (findCol(valColRaw) || columns.find(c => colTypes[c] === 'number') || null);
  const agg    = isMeasureCount ? 'count'
               : /\baverage\b|\bavg\b|\bmean\b/i.test(valColRaw || '') ? 'mean' : 'sum';

  // Replace any existing bar chart (llama3.2:1b ignores stack_mode), or inject new one
  const existing = charts.find(c => c.type === 'bar');
  if (existing) {
    existing.stack_mode       = stack_mode;
    existing.orientation      = orientation;
    existing.x_column         = catCol;
    existing.y_column         = valCol;
    existing.aggregation      = agg;
    existing.color_column     = colorCol ?? null;   // null (not stale Ollama value) if no legend found
    existing.sort_by          = 'none';
    existing._category_column = catCol;
    existing._y_column        = valCol;
    existing._aggregation     = agg;
    // Fix title to reflect actual resolved columns
    existing.title = valCol
      ? `${valCol} by ${catCol}${colorCol ? ' (' + colorCol + ')' : ''} [${stack_mode === 'percent' ? '100% ' : ''}stacked]`
      : `Count by ${catCol}${colorCol ? ' by ' + colorCol : ''} [${stack_mode === 'percent' ? '100% ' : ''}stacked]`;
  } else {
    charts.push({
      id: `bar${charts.length + 1}`,
      title: valCol
        ? `${valCol} by ${catCol}${colorCol ? ' (' + colorCol + ')' : ''} [${stack_mode === 'percent' ? '100% ' : ''}stacked]`
        : `Count by ${catCol}${colorCol ? ' by ' + colorCol : ''} [${stack_mode === 'percent' ? '100% ' : ''}stacked]`,
      type: 'bar', x_column: catCol, y_column: valCol,
      color_column: colorCol ?? null, aggregation: agg, orientation, stack_mode,
      width: 2, sort_by: 'none', sort_order: 'desc',
      _category_column: catCol, _y_column: valCol, _aggregation: agg
    });
  }
}

/* ═══════════════════════════════════════════════
   BAR CHART AXIS / CLUSTER INJECTION
   Handles prompts that explicitly name X/Y axes
   OR use the "showing X by Y" shorthand pattern.
   llama3.2:1b ignores axis placement entirely.
═══════════════════════════════════════════════ */

function _injectBarChartIfRequested(charts, prompt, columns, colTypes) {
  // Triggers on: bar chart / bar graph / clustered bar / column chart / clustered column
  if (!/\bbar\s+chart\b|\bbar\s+graph\b|\bclustered\s+(?:bar|column)\b|\bcolumn\s+chart\b/i.test(prompt)) return;
  // Stacked charts are handled by _injectStackedBarIfRequested — don't interfere
  if (/\bstacked\b/i.test(prompt)) return;
  // Combo prompts ("line and clustered column") are handled by _injectComboIfRequested — don't interfere
  if (/\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with|overlay)\s+line\b/i.test(prompt)) return;

  // Trigger on:
  //   • Explicit axis keywords           ("Country on the Y-axis")
  //   • "showing X by Y"                 shorthand
  //   • Natural comparison patterns      ("compare salary by department", "X across Y")
  const hasAxisKeyword = /on\s+the\s+[XYxy][-\s]?axis/i.test(prompt);
  const hasByPattern   = /\bshowing\s+\w[\w\s]{1,30}\s+by\s+\w/i.test(prompt);
  const hasNaturalBy   = /\b(compare|comparing|comparison|show|display|plot|visuali[sz]e|see)\b.{1,40}\b(by|across|per|for\s+each|grouped\s+by)\b/i.test(prompt)
                      || /\b(breakdown|distribution|split)\s+(of\s+)?\w[\w\s]{1,30}\s+by\s+\w/i.test(prompt);
  const hasByClause    = /\bby\s+[\w][\w\s]{1,30}?(?=[,;.]|\s+using|\s+with|\s+and\b|\s*$)/i.test(prompt);
  if (!hasAxisKeyword && !hasByPattern && !hasNaturalBy && !hasByClause) return;

  /* Resolve a text hint to a column name */
  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase()
      .replace(/^(?:employee\s+)?(?:count|total|number\s+of|sum\s+of|average\s+of?|average|avg)\b\s*/i, '')
      .trim();
    if (!t) return null;
    return columns.find(c => c.toLowerCase() === t)
        || columns.find(c => c.toLowerCase().includes(t) || t.includes(c.toLowerCase()))
        || (() => {
             const tw = t.split(/\s+/).filter(w => w.length > 2);
             return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null;
           })();
  };

  /* Smart category/value resolver: given two raw text hints, figure out
     which is the categorical dimension (x-axis) and which is the measure.
     Rule: the word AFTER "by" is almost always the grouping dimension. */
  const resolveByClause = (rawBefore, rawAfter) => {
    const cBefore = findCol(rawBefore);
    const cAfter  = findCol(rawAfter);
    const beforeIsNum = cBefore && colTypes[cBefore] === 'number';
    const afterIsNum  = cAfter  && colTypes[cAfter]  === 'number';
    const beforeIsCat = cBefore && !beforeIsNum;
    const afterIsCat  = cAfter  && !afterIsNum;

    if (afterIsCat) {
      // "showing Salary by Department" → Department (after "by") is always the category
      return { catCol: cAfter, valColRaw: rawBefore };
    } else if (beforeIsCat && !afterIsCat) {
      // "showing Country by Employee Count" → Country (before "by") is the category
      return { catCol: cBefore, valColRaw: rawAfter };
    } else if (afterIsCat && beforeIsCat) {
      // Both categorical → "by X" wins
      return { catCol: cAfter, valColRaw: rawBefore };
    } else {
      // Neither resolved cleanly — prefer the "by" side as category
      const fallback = columns.find(c => colTypes[c] !== 'number' && colTypes[c] !== 'date') || columns[0];
      return { catCol: cAfter || fallback, valColRaw: rawBefore };
    }
  };

  let catCol = null, orientation = 'v', valColRaw = null;

  if (hasAxisKeyword) {
    // Direct column lookup — avoids [\w ]+ span bug (non-greedy regex matches mid-sentence)
    const _esc2 = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const yCol = columns.find(c => new RegExp('\\b' + _esc2(c) + '\\s+on\\s+the\\s+[Yy][-\\s]?axis', 'i').test(prompt)) || null;
    const xCol = columns.find(c => new RegExp('\\b' + _esc2(c) + '\\s+on\\s+the\\s+[Xx][-\\s]?axis', 'i').test(prompt)) || null;
    const yMeasure = /\b(?:employee\s+count|headcount|count\s+of|count)\b[^.!?]*\s+on\s+the\s+[Yy][-\s]?axis/i.test(prompt);
    const xMeasure = /\b(?:employee\s+count|headcount|count\s+of|count)\b[^.!?]*\s+on\s+the\s+[Xx][-\s]?axis/i.test(prompt);

    // Categorical col on X-axis → vertical (column chart), on Y-axis → horizontal (bar chart)
    if (xCol && colTypes[xCol] !== 'number') {
      catCol = xCol; orientation = 'v'; valColRaw = yMeasure ? 'count' : (yCol || null);
    } else if (yCol && colTypes[yCol] !== 'number') {
      catCol = yCol; orientation = 'h'; valColRaw = xMeasure ? 'count' : (xCol || null);
    } else if (yMeasure && xCol) {
      catCol = xCol; orientation = 'v'; valColRaw = 'count';
    } else if (xMeasure && yCol) {
      catCol = yCol; orientation = 'h'; valColRaw = 'count';
    } else {
      catCol = xCol || yCol || columns.find(c => colTypes[c] !== 'number') || columns[0];
      orientation = 'v';
    }
  } else {
    // ── "showing A by B" pattern ──
    const byM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;]|\s+using|\s*$)/i.exec(prompt);
    if (byM) {
      const r = resolveByClause(byM[1].trim(), byM[2].trim());
      catCol    = r.catCol;
      valColRaw = r.valColRaw;
    } else {
      // ── Natural language: "compare X by/across/per Y" ──
      // Terminator extended: stops at "as", "split", "color", "group" keywords too
      const naturalM = /\b(?:compare|show|display|plot|visuali[sz]e)\s+([\w][\w\s]{1,30}?)\s+(?:by|across|per|for\s+each)\s+([\w][\w\s]{1,30}?)(?=\s*[,;.]|\s+using\b|\s+with\b|\s+as\b|\s+on\b|\s+split\b|\s+color\b|\s+group\b|\s*$)/i.exec(prompt);
      if (naturalM) {
        const r = resolveByClause(naturalM[1].trim(), naturalM[2].trim());
        catCol    = r.catCol;
        valColRaw = r.valColRaw;
      } else {
        // ── Fallback: find first "by X" where X resolves to a categorical column ──
        const byOnlyRe = /\bby\s+([\w][\w\s]{1,30}?)(?=\s*[,;.]|\s+using\b|\s+with\b|\s+as\b|\s+on\b|\s+and\b|\s*$)/gi;
        let bom;
        while ((bom = byOnlyRe.exec(prompt)) !== null) {
          const hint = bom[1].trim();
          if (/\bcount\b|\bnumber\s+of\b|\bsum\b|\btotal\b|\baverage\b|\bemployee\s+count\b/i.test(hint)) continue;
          const c = findCol(hint);
          if (c && colTypes[c] !== 'number') { catCol = c; break; }
        }
        if (!catCol) catCol = columns.find(c => colTypes[c] !== 'number') || columns[0];
      }
    }

    // ── Per-line orientation: split prompt by newlines/bullets so each bar chart
    //    gets the orientation that matches its own prompt line, not the full text.
    //    e.g. "- Create a bar chart...\n- Create a horizontal bar chart..." → ['v','h']
    const _barLines = prompt
      .split(/\n/)
      .map(l => l.replace(/^\s*[-•*]\s*/, '').trim())
      .filter(l => /\bbar\s+chart\b|\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(l));
    const _barLineOrientations = _barLines.map(l =>
      /\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(l) ? 'h' : 'v'
    );
    // Single or combined: use first line orientation, or full-prompt fallback
    orientation = _barLineOrientations[0]
      ?? (/\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(prompt) ? 'h' : 'v');
  }

  // ── Aggregation ──
  const isCountVal = !valColRaw || /\bcount\b|\bnumber\s+of\b|\bheadcount\b|\bemployee\s+count\b/i.test(valColRaw);
  const agg = isCountVal ? 'count'
            : /\baverage\b|\bmean\b|\bavg\b/i.test(valColRaw) ? 'mean'
            : 'sum';
  const valCol = isCountVal ? null : findCol(valColRaw) || columns.find(c => colTypes[c] === 'number') || null;

  // ── Color / legend column — use shared extractor (handles all patterns) ──
  const colorCol = _extractColorColFromPrompt(prompt, columns, colTypes);

  // ─── Per-line specs: parse each chart-request line independently ───────────
  // When the user submits multiple prompts together (newline-separated), every
  // bar/column chart line is parsed in isolation for its own catCol, valCol,
  // colorCol and orientation — preventing settings from one line bleeding into
  // charts that belong to other lines.
  //
  // Filter includes ALL bar/column keywords so "clustered column chart" is
  // captured in the same ordered list as "bar chart" and "horizontal bar chart".
  const _allChartLines = prompt
    .split(/\n/)
    .map(l => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(l => l.length > 0 &&
      /\bbar\s+chart\b|\bbar\s+graph\b|\bhorizontal\s+bar\b|\bclustered\s+(?:bar|column)\b|\bcolumn\s+chart\b/i.test(l));

  // Build per-line specs only when 2+ distinct chart lines are present.
  // For single-line prompts _lineSpecs stays null and we use full-prompt values.
  const _lineSpecs = _allChartLines.length > 1
    ? _allChartLines.map(line => {
        // ── orientation: only "horizontal bar" / "clustered bar" go sideways ──
        const lineOrient = /\bhorizontal\s+bar\b/i.test(line) ? 'h'
          : /\bclustered\s+bar\b/i.test(line) ? 'h'
          : 'v';

        // ── column resolution from this line's own "showing X by Y" ──
        let lineCatCol = catCol, lineValColRaw = valColRaw;
        const byM2 = /\bshowing\s+([\w][\w\s]{1,60}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;]|\s+using\b|\s+with\b|\s*$)/i.exec(line);
        if (byM2) {
          const r2 = resolveByClause(byM2[1].trim(), byM2[2].trim());
          if (r2.catCol)    lineCatCol    = r2.catCol;
          if (r2.valColRaw) lineValColRaw = r2.valColRaw;
        }

        // ── aggregation ──
        const lineIsCount = !lineValColRaw ||
          /\bcount\b|\bnumber\s+of\b|\bheadcount\b|\bemployee\s+count\b/i.test(String(lineValColRaw));
        const lineAgg = lineIsCount ? 'count'
          : /\baverage\b|\bmean\b|\bavg\b/i.test(String(lineValColRaw)) ? 'mean'
          : 'sum';
        const lineValCol = lineIsCount ? null
          : findCol(String(lineValColRaw)) || columns.find(c => colTypes[c] === 'number') || null;

        // ── color/legend — extracted from THIS line only (no cross-bleed) ──
        const lineColorCol = _extractColorColFromPrompt(line, columns, colTypes);

        return { catCol: lineCatCol, valCol: lineValCol, colorCol: lineColorCol, agg: lineAgg, orientation: lineOrient };
      })
    : null;  // single-line prompt → use full-prompt resolved values

  // ── Build / replace / update bar charts ────────────────────────────────────
  const existingBars = charts.filter(c => c.type === 'bar');

  if (_lineSpecs) {
    // ── Multi-line: build brand-new chart objects from per-line specs ──────
    // Completely discards Ollama's chart order and pre-assigned properties.
    // This is the ONLY safe approach — Ollama returns charts in arbitrary order
    // and pre-assigns colorColFromPrompt (full-prompt) to every bar chart.
    // By rebuilding from scratch we get correct order, correct color, correct orientation.
    const newBars = _lineSpecs.map((spec, i) => ({
      id:           `bar${i + 1}`,
      title:        spec.valCol
                      ? `${spec.valCol} by ${spec.catCol}${spec.colorCol ? ' (' + spec.colorCol + ')' : ''}`
                      : `Count by ${spec.catCol}`,
      type:         'bar',
      x_column:     spec.catCol,
      y_column:     spec.valCol,
      color_column: spec.colorCol ?? null,   // null (not undefined) so it survives JSON — client uses this to know "no legend was requested"
      aggregation:  spec.agg,
      orientation:  spec.orientation,
      width:        2,
      sort_by:      spec.colorCol ? 'none' : 'y',
      sort_order:   'desc',
      _category_column: spec.catCol,
      _y_column:        spec.valCol,
      _aggregation:     spec.agg
    }));
    // Replace ALL bar charts with our per-spec ones; keep any non-bar charts Ollama generated
    const nonBars = charts.filter(c => c.type !== 'bar');
    charts.splice(0, charts.length, ...newBars, ...nonBars);

  } else if (existingBars.length > 0) {
    // ── Single-line: update the one existing bar in place ──────────────────
    existingBars.forEach(bar => {
      bar.x_column         = catCol;
      bar.y_column         = valCol;
      bar.aggregation      = agg;
      bar.orientation      = orientation;
      bar.color_column     = colorCol ?? null;   // null survives JSON; prevents Ollama's stale value leaking
      bar.sort_by          = colorCol ? 'none' : 'y';
      bar.sort_order       = 'desc';
      bar._category_column = catCol;
      bar._y_column        = valCol;
      bar._aggregation     = agg;
      bar.title = valCol
        ? `${valCol} by ${catCol}${colorCol ? ' (' + colorCol + ')' : ''}`
        : `Count by ${catCol}`;
    });

  } else {
    // ── No existing bars: push a fresh chart ───────────────────────────────
    charts.push({
      id: `bar${charts.length + 1}`,
      title: valCol
        ? `${valCol} by ${catCol}${colorCol ? ' (' + colorCol + ')' : ''}`
        : `Count by ${catCol}`,
      type: 'bar', x_column: catCol, y_column: valCol,
      color_column: colorCol || undefined, aggregation: agg, orientation,
      width: 2, sort_by: colorCol ? 'none' : 'y', sort_order: 'desc',
      _category_column: catCol, _y_column: valCol, _aggregation: agg
    });
  }
}

/* ═══════════════════════════════════════════════
   STACKED AREA INJECTION
═══════════════════════════════════════════════ */

function _injectStackedAreaIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bstacked\s+area\b/i.test(prompt)) return;

  // Returns true for columns that are identifiers (not useful as chart categories)
  const _isIdLike = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );
  // Returns true for generic entity nouns that are NOT column names
  const _isGenericNoun = s => /^(?:employees?|staff|workers?|people|persons?|members?|headcount|records?|rows?|entries|entry|items?)$/i.test(s);

  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim()
      // Strip trailing punctuation (handles sentence-final words like "countries.")
      .replace(/[.,;!?]+$/, '')
      .toLowerCase()
      .replace(/^(?:employee\s+count|headcount|total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
      .trim();
    if (!t || _isGenericNoun(t)) return null;  // pure measure phrase — no column
    // Normalise English plurals so "countries"→"country", "departments"→"department"
    const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                           .replace(/ves$/, 'f').replace(/s$/, '');
    const variants = [...new Set([t, deplural(t)])];
    for (const v of variants) {
      // Exact match (highest priority)
      const exact = columns.find(c => c.toLowerCase() === v);
      if (exact) return exact;
      // Substring match — skip ID-like columns to avoid "employee" → "Employee ID"
      const substr = columns.find(c => !_isIdLike(c) && (c.toLowerCase().includes(v) || v.includes(c.toLowerCase())));
      if (substr) return substr;
      // Word-token fallback (skip ID-like)
      const tw = v.split(/\s+/).filter(w => w.length > 2);
      const tok = columns.find(c => !_isIdLike(c) && tw.some(w => c.toLowerCase().includes(w)));
      if (tok) return tok;
    }
    return null;
  };

  const stack_mode = /\b100\s*%?\s*stacked\b|\bpercent(?:age)?\s+stacked\b/i.test(prompt) ? 'percent' : 'stack';

  // Broader category-column extractor — mirrors the waterfall patterns
  const _extractCat = () => {
    const patterns = [
      /\bshowing\s+[\w][\w\s]{1,30}?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bby\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bacross\s+(?:different\s+)?([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bper\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\bfor\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\bfrom\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\beach\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\bgroup(?:ed)?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bbreakdown\s+(?:of\s+[\w\s]{1,25}?\s+)?by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      // "Country on the x-axis / x axis / X-axis"
      /([\w][\w\s]{1,25}?)\s+on\s+the\s+[xX][-\s]?axis/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(prompt);
      if (m) {
        const c = findCol(m[1].trim());
        if (c && colTypes[c] !== 'number') return c;
      }
    }
    return null;
  };

  let catCol = null, valColRaw = null;

  // "showing X by Y" — but treat ID-like columns as non-categorical
  const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s+split\b|\s+using\b|\s*$)/i.exec(prompt);
  if (showByM) {
    const raw1 = showByM[1].trim(), raw2 = showByM[2].trim();
    const col1 = findCol(raw1);
    // Treat ID-like or numeric columns as measure phrases, not category columns
    if (!col1 || colTypes[col1] === 'number' || _isIdLike(col1)) {
      catCol = findCol(raw2);
      valColRaw = raw1;
    } else {
      catCol = col1;
      valColRaw = raw2;
    }
  }
  if (!catCol) catCol = _extractCat();

  const goodX = _goodXCols(columns, colTypes);
  catCol = catCol || columns.find(c => colTypes[c] === 'date') || goodX[0] || columns[0];
  const colorCol = _extractColorColFromPrompt(prompt, columns, colTypes)
               || goodX.find(c => c !== catCol) || null;
  const isMeasureCount = !valColRaw || /\bcount\b|\bnumber\s+of\b|\bemployee\s+count\b/i.test(valColRaw);
  const valCol = isMeasureCount ? null : (findCol(valColRaw) || columns.find(c => colTypes[c] === 'number') || null);
  const agg    = isMeasureCount ? 'count' : /\baverage\b|\bavg\b|\bmean\b/i.test(valColRaw || '') ? 'mean' : 'sum';

  const existing = charts.find(c => c.type === 'area');
  if (existing) {
    existing.stack_mode = stack_mode; existing.x_column = catCol; existing.y_column = valCol;
    existing.aggregation = agg; existing.color_column = colorCol || existing.color_column;
    existing._category_column = catCol; existing._y_column = valCol; existing._aggregation = agg;
  } else {
    charts.push({ id: `area${charts.length+1}`, title: `${catCol}${colorCol?' by '+colorCol:''} (stacked area)`,
      type: 'area', x_column: catCol, y_column: valCol, color_column: colorCol,
      aggregation: agg, stack_mode, width: 2, sort_by: 'none', sort_order: 'desc',
      _category_column: catCol, _y_column: valCol, _aggregation: agg });
  }
}

/* ═══════════════════════════════════════════════
   COMBO (LINE + BAR) INJECTION
═══════════════════════════════════════════════ */

function _injectComboIfRequested(charts, prompt, columns, colTypes) {
  // Matches: "combo", "line and column", "line and stacked column", "stacked column and line", etc.
  const _comboTrigger = /\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with|overlay)\s+line\b|\bbar\s+(?:and|&|plus)\s+line\b/i;
  if (!_comboTrigger.test(prompt)) return;

  const findCol = raw => {
    if (!raw) return null;
    const rawL = raw.trim().toLowerCase();
    // First try exact match before stripping any prefix — preserves compound names like "TotalPrice"
    const exactHit = columns.find(c => c.toLowerCase() === rawL);
    if (exactHit) return exactHit;
    const t = rawL
      // Only strip "total" when followed by a space (so "TotalPrice" is NOT stripped to "price")
      .replace(/^(?:employee\s+count|headcount|total(?=\s)|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
      .trim();
    if (!t) return null;
    // Normalise English plurals so "ethnicities"→"ethnicity", "departments"→"department"
    const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                           .replace(/ves$/, 'f').replace(/s$/, '');
    const variants = [...new Set([t, deplural(t)])];
    for (const v of variants) {
      const hit = columns.find(c => c.toLowerCase() === v)
               || columns.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()))
               || (() => { const tw = v.split(/\s+/).filter(w => w.length > 2);
                    return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
      if (hit) return hit;
    }
    return null;
  };

  // Detect stacked column combo early — needed for catCol and colorCol logic below
  const isStackedCombo = /\bstacked\b/i.test(prompt);
  const stack_mode = isStackedCombo
    ? (/\b100\s*%?\s*stacked\b|\bpercent(?:age)?\s+stacked\b/i.test(prompt) ? 'percent' : 'stack')
    : null;

  // ── Structured stacked-combo patterns (highest priority) ─────────────────
  // "showing UnitPrice stacked by OrderStatus, with a line for TotalPrice, by PaymentMethod"
  //   → bar metric = UnitPrice, colorCol = OrderStatus, line metric = TotalPrice, x = PaymentMethod
  const _stackedByM = isStackedCombo
    ? /\bstacked\s+by\s+([\w][\w\s]{1,25}?)(?=\s*[,;]|\s+with\b|\s+and\b|\s+by\b|\s*$)/i.exec(prompt)
    : null;
  const _lineForM = /\b(?:with\s+(?:a\s+)?)?line\s+(?:for|showing|of)\s+([\w][\w\s]{1,25}?)(?:[,;]|\s+by\b|\s*$)/i.exec(prompt);
  const _showingBarM = _stackedByM
    ? /\bshowing\s+([\w][\w\s]{1,25}?)\s+stacked\b/i.exec(prompt)
    : null;

  // Remove "stacked by X" from the prompt when searching for the x-axis "by Y"
  // so that "stacked by OrderStatus" is not confused with the x-axis column
  const _promptForCatCol = _stackedByM
    ? prompt.slice(0, _stackedByM.index) + prompt.slice(_stackedByM.index + _stackedByM[0].length)
    : prompt;

  let catCol = null;
  const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;]|\s*$)/i.exec(_promptForCatCol);
  if (showByM) {
    const col1 = findCol(showByM[1].trim());
    catCol = (col1 && colTypes[col1] !== 'number') ? col1 : findCol(showByM[2].trim());
    if (catCol && colTypes[catCol] === 'number') catCol = null;
  }
  if (!catCol) {
    // Use the LAST "by X" in the cleaned prompt as the x-axis
    const allByMatches = [];
    const _byReg = /\bby\s+([\w][\w\s]{1,25}?)(?=\s*[,;.]|\s*$|\s+with\b)/gi;
    let _bm;
    while ((_bm = _byReg.exec(_promptForCatCol)) !== null) allByMatches.push(_bm);
    if (allByMatches.length > 0) {
      const lastBy = allByMatches[allByMatches.length - 1];
      const c = findCol(lastBy[1].trim());
      if (c && colTypes[c] !== 'number') catCol = c;
    }
  }
  if (!catCol) {
    const byM = /\bby\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i.exec(_promptForCatCol);
    if (byM) { const c = findCol(byM[1].trim()); if (c && colTypes[c] !== 'number') catCol = c; }
  }
  catCol = catCol || columns.find(c => colTypes[c] === 'date') || _goodXCols(columns, colTypes)[0] || columns[0];

  // Try to find two distinct metrics
  const numCols = columns.filter(c => colTypes[c] === 'number');
  let yCol = null, y2Col = null;

  // Priority 0 (stacked combo): "showing X stacked by…" → yCol=X  /  "line for Y" → y2Col=Y
  if (_showingBarM) {
    const c = findCol(_showingBarM[1].trim());
    if (c && colTypes[c] === 'number') yCol = c;
  }
  if (_lineForM) {
    const c = findCol(_lineForM[1].trim());
    if (c && colTypes[c] === 'number') y2Col = c;
  }

  // Priority 1: "showing X and/vs Y by Z" or "for X and/vs Y by Z"
  const _metricSep = /(?:and|vs?\.?|versus)/;
  const showMetricsM = new RegExp('\\bshowing\\s+([\\w][\\w\\s]{1,25}?)\\s+' + _metricSep.source + '\\s+([\\w][\\w\\s]{1,25}?)\\s+by\\b', 'i').exec(prompt)
                    || new RegExp('\\bfor\\s+([\\w][\\w\\s]{1,25}?)\\s+'     + _metricSep.source + '\\s+([\\w][\\w\\s]{1,25}?)\\s+by\\b', 'i').exec(prompt);
  if (showMetricsM) {
    const c1 = findCol(showMetricsM[1].trim());
    const c2 = findCol(showMetricsM[2].trim());
    if (!yCol  && c1 && colTypes[c1] === 'number') yCol  = c1;
    if (!y2Col && c2 && colTypes[c2] === 'number') y2Col = c2;
  }
  // Priority 2: "by X vs/and Y"
  if (!yCol || !y2Col) {
    const vsM = /\bby\s+([\w][\w\s]{1,25}?)\s+(?:vs?\.?|versus|and)\s+([\w][\w\s]{1,25}?)(?:\s*[,;]|\s*$)/i.exec(prompt);
    if (vsM) {
      if (!yCol)  { const c = findCol(vsM[1].trim()); if (c && colTypes[c]==='number') yCol=c; }
      if (!y2Col) { const c = findCol(vsM[2].trim()); if (c && colTypes[c]==='number') y2Col=c; }
    }
  }
  // Priority 3: single numeric metric from "showing X by Z"
  if (!yCol && showByM) {
    const c = findCol(showByM[1].trim());
    if (c && colTypes[c] === 'number') yCol = c;
  }
  if (!yCol)  yCol  = numCols[0] || null;
  // Smart y2 fallback: prefer value/amount columns over count/quantity columns
  if (!y2Col) {
    const _isCountLike = c => /\b(count|qty|quantity|num(?:ber)?|units?|items?|pieces?|orders?)\b/i.test(c);
    const _isValueLike = c => /\b(total|amount|revenue|price|cost|value|salary|income|profit|sales|earning|fee|rate)\b/i.test(c);
    const candidates = numCols.filter(c => c !== yCol);
    y2Col = candidates.find(c => _isValueLike(c) && !_isCountLike(c))  // prefer value-like non-count
         || candidates.find(c => !_isCountLike(c))                     // then any non-count-like
         || candidates[0]                                               // then any remaining
         || yCol;                                                       // last resort: same as y
  }

  const agg = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt) ? 'mean'
            : /\bcount\b|\bnumber\s+of\b/i.test(prompt) ? 'count' : 'sum';

  // For stacked combo, derive the color/stack dimension (a categorical column ≠ catCol)
  // "stacked by X" in the prompt takes highest priority
  const _stackColorHint = _stackedByM ? findCol(_stackedByM[1].trim()) : null;
  let colorCol = null;
  if (isStackedCombo) {
    colorCol = (_stackColorHint && colTypes[_stackColorHint] !== 'number' ? _stackColorHint : null)
            || _extractColorColFromPrompt(prompt, columns, colTypes)
            || columns.find(c => colTypes[c] !== 'number' && c !== catCol
                              && !/\b(id|name|title|description|email|address)\b/i.test(c.toLowerCase())
                              && !/id$/.test(c.toLowerCase().replace(/[\s_]/g, '')))
            || null;
  }

  // For a pure combo request (no other chart types mentioned), collapse everything
  // Ollama may have split the request into a separate line chart + bar chart — merge into one combo
  const isPureComboRequest = !/\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bwaterfall\b|\btreemap\b|\bgauge\b|\bmap\b/i.test(prompt);
  if (isPureComboRequest) {
    // Remove stray bar, line, and combo charts — the injected combo replaces them all
    for (let i = charts.length - 1; i >= 0; i--) {
      if (charts[i].type === 'bar' || charts[i].type === 'line' || charts[i].type === 'combo') charts.splice(i, 1);
    }
  }

  const existing = charts.find(c => c.type === 'combo');
  const comboTitle = isStackedCombo
    ? `${catCol}${colorCol ? ' by ' + colorCol : ''} (stacked combo)`
    : `${catCol} — ${yCol||'metric'} & ${y2Col||'metric2'} (combo)`;

  if (existing) {
    existing.x_column = catCol; existing.y_column = yCol; existing.y2_column = y2Col;
    existing.aggregation = agg; existing._category_column = catCol;
    existing._y_column = yCol; existing._aggregation = agg;
    if (isStackedCombo) { existing.stack_mode = stack_mode; existing.color_column = colorCol; }
  } else {
    const spec = { id: `combo${charts.length+1}`, title: comboTitle,
      type: 'combo', x_column: catCol, y_column: yCol, y2_column: y2Col,
      aggregation: agg, width: 2, sort_by: 'none', sort_order: 'desc',
      _category_column: catCol, _y_column: yCol, _aggregation: agg };
    if (isStackedCombo) { spec.stack_mode = stack_mode; spec.color_column = colorCol; }
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   WATERFALL INJECTION
═══════════════════════════════════════════════ */

function _injectWaterfallIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bwaterfall\b/i.test(prompt)) return;

  const _isIdLikeCol = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );

  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim()
      // Strip trailing punctuation that bleeds in from sentence-end (e.g. "ethnicities.")
      .replace(/[.,;!?]+$/, '')
      .toLowerCase()
      .replace(/^(?:employee\s+count|headcount|total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
      .trim();
    if (!t) return null;
    // Normalise English plurals so "ethnicities"→"ethnicity", "departments"→"department"
    const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                           .replace(/ves$/, 'f').replace(/s$/, '');
    const variants = [...new Set([t, deplural(t)])];
    for (const v of variants) {
      const hit = columns.find(c => c.toLowerCase() === v)
               || columns.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()))
               || (() => { const tw = v.split(/\s+/).filter(w => w.length > 2);
                    return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
      if (hit) return hit;
    }
    return null;
  };

  // Score every numeric col by how many of its words appear in the prompt
  const _bestNumColFromPrompt = () => {
    const numericCols = columns.filter(c => colTypes[c] === 'number' && !_isIdLikeCol(c));
    const pl = prompt.toLowerCase();
    const scored = numericCols.map(c => {
      const words = c.toLowerCase().replace(/[_\-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      return { c, score: words.reduce((s, w) => s + (pl.includes(w) ? 1 : 0), 0) };
    }).sort((a, b) => b.score - a.score);
    return scored.length && scored[0].score > 0 ? scored[0].c : (numericCols[0] || null);
  };

  // Broad category-column extraction: handles "by X", "across X", "per X",
  // "using X as (the) group", "X as the (group|category|dimension)", "for each X",
  // "from each X", "each X", "group by X", "breakdown by X", "distribution (of Y) by X"
  // Lookahead includes "." so sentence-final words like "ethnicities." are caught.
  const _extractCatFromPrompt = () => {
    const patterns = [
      /\bshowing\s+[\w][\w\s]{1,30}?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bby\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bacross\s+(?:different\s+)?([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\bper\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\bfor\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,
      /\bfrom\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,   // "from each ethnicity"
      /\beach\s+([\w][\w\s]{1,25}?)(?=\s|[,;.]|$)/i,           // "each ethnicity"
      /\bgroup(?:ed)?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
      /\busing\s+([\w][\w\s]{1,25}?)\s+as\s+(?:the\s+)?(?:group|category|dimension|x)/i,
      /\b([\w][\w\s]{1,25}?)\s+as\s+the\s+(?:group|category|dimension|x[- ]axis)/i,
      /\bbreakdown\s+(?:of\s+[\w\s]{1,25}?\s+)?by\s+([\w][\w\s]{1,30}?)(?=\s|[,;.]|$)/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(prompt);
      if (m) {
        const c = findCol(m[1].trim());
        if (c && colTypes[c] !== 'number') return c;
      }
    }
    return null;
  };

  let catCol = null, valColRaw = null;
  // "showing X by Y" OR "showing X across (different) Y"
  const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+(?:by|across\s+(?:different\s+)?)\s*([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  if (showByM) {
    const col1 = findCol(showByM[1].trim());
    if (!col1 || colTypes[col1] === 'number') { catCol = findCol(showByM[2].trim()); valColRaw = showByM[1].trim(); }
    else { catCol = col1; valColRaw = showByM[2].trim(); }
  }
  if (!catCol) catCol = _extractCatFromPrompt();
  catCol = catCol || _goodXCols(columns, colTypes)[0] || columns[0];

  const explicitCount = /\bcount\b|\bnumber\s+of\b|\bheadcount\b/i.test(prompt);
  const explicitAvg   = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt);

  let valCol, agg;
  if (valColRaw) {
    const isMeasureCount = /\bcount\b|\bnumber\s+of\b/i.test(valColRaw);
    valCol = isMeasureCount ? null : (findCol(valColRaw) || _bestNumColFromPrompt());
    agg    = isMeasureCount ? 'count' : /\baverage\b|\bavg\b/i.test(valColRaw) ? 'mean' : 'sum';
  } else if (explicitCount && !explicitAvg) {
    valCol = null; agg = 'count';
  } else {
    valCol = _bestNumColFromPrompt();
    agg    = explicitAvg ? 'mean' : 'sum';
  }

  const title = valCol ? `${valCol} by ${catCol}` : `${catCol} Distribution`;
  const existing = charts.find(c => c.type === 'waterfall');
  if (existing) {
    existing.x_column = catCol; existing.y_column = valCol; existing.aggregation = agg;
    existing._category_column = catCol; existing._y_column = valCol; existing._aggregation = agg;
    existing.title = existing.title || title;
  } else {
    charts.push({ id: `waterfall${charts.length+1}`, title,
      type: 'waterfall', x_column: catCol, y_column: valCol, aggregation: agg, width: 2,
      _category_column: catCol, _y_column: valCol, _aggregation: agg });
  }
}

/* ═══════════════════════════════════════════════
   BUBBLE CHART INJECTION
═══════════════════════════════════════════════ */

function _injectBubbleIfRequested(charts, prompt, columns, colTypes) {
  // Match any prompt that mentions "bubble" (chart/plot/graph or alone)
  if (!/\bbubble\b/i.test(prompt)) return;

  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase()
      .replace(/^(?:total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '').trim();
    if (!t) return null;
    // Normalise English plurals so "ethnicities"→"ethnicity", "departments"→"department"
    const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                           .replace(/ves$/, 'f').replace(/s$/, '');
    const variants = [...new Set([t, deplural(t)])];
    for (const v of variants) {
      const hit = columns.find(c => c.toLowerCase() === v)
               || columns.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()))
               || (() => { const tw = v.split(/\s+/).filter(w => w.length > 2);
                    return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
      if (hit) return hit;
    }
    return null;
  };

  const numCols = columns.filter(c => colTypes[c] === 'number');
  let xCol = null, yCol = null, sizeCol = null;

  // Pattern 1: "X on the x-axis" / "Y on the y-axis"
  const xAxisRaw = (/([A-Za-z][\w ]{0,30}?)\s+on\s+the\s+[Xx][-\s]?axis/i.exec(prompt) || [])[1];
  const yAxisRaw = (/([A-Za-z][\w ]{0,30}?)\s+on\s+the\s+[Yy][-\s]?axis/i.exec(prompt) || [])[1];
  if (xAxisRaw) xCol = findCol(xAxisRaw.trim());
  if (yAxisRaw) yCol = findCol(yAxisRaw.trim());

  // Pattern 2: "X vs Y sized by Z" / "X versus Y" / "X against Y"
  if (!xCol && !yCol) {
    const vsM = /\b([\w][\w\s]{1,25}?)\s+(?:vs?\.?|versus|against)\s+([\w][\w\s]{1,25}?)(?:\s+sized?\s+by\s+([\w][\w\s]{1,25}))?/i.exec(prompt);
    if (vsM) {
      xCol = findCol(vsM[1].trim()); yCol = findCol(vsM[2].trim());
      if (vsM[3]) sizeCol = findCol(vsM[3].trim());
    }
  }

  // Pattern 3: "showing X by Y" / "bubble of X by Y"
  if (!xCol && !yCol) {
    const showByM = /\b(?:showing|of)\s+([\w][\w\s]{1,25}?)\s+by\s+([\w][\w\s]{1,25}?)(?:\s+sized?\s+by\s+([\w][\w\s]{1,25}))?/i.exec(prompt);
    if (showByM) {
      xCol = findCol(showByM[1].trim()); yCol = findCol(showByM[2].trim());
      if (showByM[3]) sizeCol = findCol(showByM[3].trim());
    }
  }

  // Pattern 4: "sized by Z" / "size by Z" anywhere in the prompt
  if (!sizeCol) {
    const sizeM = /\bsized?\s+by\s+([\w][\w\s]{1,25})/i.exec(prompt);
    if (sizeM) sizeCol = findCol(sizeM[1].trim());
  }

  // Fallbacks — x may be categorical (e.g. Country); only force numeric when truly unresolved
  if (!xCol) xCol = numCols[0] || columns[0];
  // Only force x to numeric when y is ALSO non-numeric (mirror _postProcessAdvancedCharts logic)
  if (xCol && colTypes[xCol] !== 'number' && yCol && colTypes[yCol] !== 'number') {
    xCol = numCols[0] || columns[0];
  }
  if (!yCol || colTypes[yCol] !== 'number') yCol = numCols.find(c => c !== xCol) || numCols[0];

  // size_column fallback: pick a meaningful numeric column, skip ID/serial-number columns
  const _isIdLike = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );
  if (!sizeCol || colTypes[sizeCol] !== 'number') {
    sizeCol = numCols.find(c => c !== xCol && c !== yCol && !_isIdLike(c))
           || numCols.find(c => c !== xCol && c !== yCol)
           || null;
  }

  // Always use raw data (aggregation: 'none') — one bubble per row
  const bubbleAgg = 'none';

  // Only assign color_column when the user explicitly asked for it (e.g. "split by", "color by")
  // Never fall back to _goodXCols()[0] — a high-cardinality column like 'Full Name' would create
  // one Plotly trace per row, crashing the browser.
  const colorCol = _extractColorColFromPrompt(prompt, columns, colTypes) || null;

  /* Prefer to patch an existing bubble chart, then fall back to replacing the Ollama-generated
     scatter chart (since Ollama uses 'scatter' when 'bubble' isn't in its type list), and
     only push a brand-new entry as a last resort. This prevents duplicate charts when the
     user also requested KPI cards (which blocks the _advancedTypes cleanup pass). */
  const existing   = charts.find(c => c.type === 'bubble');
  const scatterIdx = existing ? -1 : charts.findIndex(c => c.type === 'scatter');
  const bubbleProps = {
    type: 'bubble', title: `${xCol} vs ${yCol}`,
    x_column: xCol, y_column: yCol,
    size_column: sizeCol || null,   // explicit null clears any prior size_column
    color_column: colorCol, aggregation: bubbleAgg, width: 2,
    _category_column: xCol, _y_column: yCol, _aggregation: bubbleAgg
  };
  if (existing) {
    Object.assign(existing, bubbleProps);
  } else if (scatterIdx !== -1) {
    /* Upgrade the scatter entry to bubble in-place (keeps its id/title from Ollama) */
    charts[scatterIdx] = { ...charts[scatterIdx], ...bubbleProps };
  } else {
    charts.push({ id: `bubble${charts.length + 1}`, title: `${xCol} vs ${yCol} (Bubble)`, ...bubbleProps });
  }
  console.log(`[ollama-agent] Bubble injected: x=${xCol}, y=${yCol}, size=${sizeCol}, color=${colorCol}`);
}

/* ═══════════════════════════════════════════════
   PIE / DONUT INJECTION
   Fixes Ollama returning bar when the user asked
   for pie or donut chart.
═══════════════════════════════════════════════ */

function _injectPieIfRequested(charts, prompt, columns, colTypes) {
  const isPie   = /\bpie\s*(?:chart|visual|graph)?\b/i.test(prompt);
  const isDonut = /\bdonut\s*(?:chart|visual|graph)?\b|\bdoughnut\b/i.test(prompt);
  if (!isPie && !isDonut) return;

  const targetType = isDonut ? 'donut' : 'pie';
  const pLower = prompt.toLowerCase();

  // Is this a pure pie/donut-only request (no OTHER chart types mixed in)?
  const hasOtherTypes = /\bbar\s+chart\b|\bcolumn\s+chart\b|\bline\s+chart\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bwaterfall\b|\btreemap\b|\bhistogram\b|\bcombo\b|\bmatrix\b|\bchoropleth\b|\bfilled[\s\-]?map\b|\bgauge\b/i.test(prompt);

  // Aggregation
  const agg = /\bcount\b|\bheadcount\b|\bnumber\s+of\b|\bhow\s+many\b/i.test(pLower) ? 'count'
    : /\baverage\b|\bavg\b|\bmean\b/i.test(pLower) ? 'mean'
    : /\btotal\b|\bsum\b/i.test(pLower) ? 'sum'
    : 'count';  // default for pie is proportion/count

  const isIdLike = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(c.toLowerCase().replace(/[\s_\-]+/g,' '));
  const catCols  = columns.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date' && !isIdLike(c));
  const numCols  = columns.filter(c => colTypes[c] === 'number' && !isIdLike(c));

  // Category column: prefer "by X" pattern, then prompt keyword match
  let xCol = null;
  const byM = /\bby\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s+(?:and|chart|graph|visual)\b|\s*$)/i.exec(prompt);
  if (byM) {
    const hint = byM[1].trim().toLowerCase();
    xCol = columns.find(c => c.toLowerCase() === hint)
        || columns.find(c => c.toLowerCase().includes(hint) || hint.includes(c.toLowerCase()))
        || null;
  }
  if (!xCol) xCol = catCols.find(c => pLower.includes(c.toLowerCase())) || catCols[0] || columns[0];

  // Value column (null for count aggregation)
  let yCol = null;
  if (agg !== 'count') {
    const scored = numCols.map(c => {
      const words = c.toLowerCase().replace(/[_\-]/g,' ').split(/\s+/).filter(w => w.length > 2);
      return { c, score: words.reduce((s, w) => s + (pLower.includes(w) ? 1 : 0), 0) };
    }).sort((a, b) => b.score - a.score);
    yCol = (scored.length && scored[0].score > 0) ? scored[0].c : (numCols[0] || null);
  }

  // If Ollama already returned the right chart type, just fix it up
  const existing = charts.find(c => c.type === 'pie' || c.type === 'donut');
  if (existing) {
    existing.type         = targetType;
    existing.x_column     = existing.x_column || xCol;
    existing._category_column = existing.x_column;
    if (agg === 'count') { existing.y_column = null; existing._y_column = null; }
    existing.aggregation  = agg;
    existing._aggregation = agg;
    // Pure pie-only request: remove any extra bar/line charts Ollama also added
    if (!hasOtherTypes) {
      for (let j = charts.length - 1; j >= 0; j--) {
        if (charts[j] !== existing) charts.splice(j, 1);
      }
    }
    return;
  }

  // Build the pie/donut spec
  const metricLabel = yCol || 'Count';
  const pieSpec = {
    id:           `pie${charts.length + 1}`,
    title:        `${metricLabel} by ${xCol}`,
    type:         targetType,
    x_column:     xCol,
    y_column:     yCol,
    _category_column: xCol,
    _y_column:    yCol,
    aggregation:  agg,
    _aggregation: agg,
    width: 1,
    sort_by: 'y', sort_order: 'desc'
  };

  if (!hasOtherTypes) {
    // Pure pie-only request: replace everything Ollama generated with just the pie
    charts.splice(0, charts.length, pieSpec);
  } else {
    // Mixed request: swap first bar chart, or push
    const firstBarIdx = charts.findIndex(c => c.type === 'bar');
    if (firstBarIdx !== -1) charts.splice(firstBarIdx, 1, pieSpec);
    else charts.push(pieSpec);
  }
}

/* ═══════════════════════════════════════════════
   MAP INJECTION (choropleth + scattergeo)
   Ensures a geographic chart exists whenever the
   user mentions "map", "filled map", "choropleth",
   "world map", etc.
═══════════════════════════════════════════════ */

function _injectMapIfRequested(charts, prompt, columns, colTypes) {
  const isFilledMap = /\bchoropleth\b|\bfilled[\s\-]?map\b/i.test(prompt);
  const isMapGeneral = /\bmap\b|\bgeograph|\bworld\s+map\b|\bcountry\s+map\b/i.test(prompt);
  if (!isFilledMap && !isMapGeneral) return;

  const mapType = isFilledMap ? 'choropleth' : 'scattergeo';

  // Find a location column
  const locCol = columns.find(c =>
    /^(country|countries|region|state|province|city|location|territory|geography|geo|nation)$/i.test(c.trim())
  ) || columns.find(c =>
    /country|region|state|province|city|location|territory|geography|geo/i.test(c)
  ) || columns.find(c => colTypes[c] !== 'number' && colTypes[c] !== 'date') || columns[0];

  // Find a value column (numeric, skip IDs)
  const isIdLike = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );

  // Detect aggregation from prompt keywords
  const aggFromPrompt = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt) ? 'mean'
    : /\bcount\b|\bnumber\s+of\b|\bhow\s+many\b/i.test(prompt) ? 'count'
    : /\btotal\b|\bsum\b/i.test(prompt) ? 'sum'
    : null;  // null = decide after we find the value column

  // Try to find the value column mentioned in the prompt
  const numericCols = columns.filter(c => colTypes[c] === 'number' && !isIdLike(c) && c !== locCol);
  // Score each numeric column by how many of its words appear in the prompt
  const scoredNumeric = numericCols.map(c => {
    const words = c.toLowerCase().replace(/[_\-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const score = words.reduce((s, w) => s + (prompt.toLowerCase().includes(w) ? 1 : 0), 0);
    return { c, score };
  });
  scoredNumeric.sort((a, b) => b.score - a.score);
  // Best-matching value column (scored by prompt keywords)
  const bestValCol = (scoredNumeric.length > 0 && scoredNumeric[0].score > 0)
    ? scoredNumeric[0].c
    : (numericCols[0] || null);

  // For count aggregation y_column must be null (we count records, not sum a column)
  const agg    = (aggFromPrompt === 'count') ? 'count'
               : bestValCol                  ? (aggFromPrompt || 'sum')
               :                              'count';
  const valCol = (agg === 'count') ? null : bestValCol;

  const mapProps = {
    type: mapType,
    x_column: locCol,
    y_column: valCol,
    aggregation: agg,
    width: 2,
    _category_column: locCol,
    _y_column: valCol,
    _aggregation: agg
  };

  const existing = charts.find(c => c.type === 'choropleth' || c.type === 'scattergeo' || c.type === 'map');
  if (existing) {
    // Always use correctly detected columns — Ollama's guesses are often wrong for map visuals
    existing.x_column         = locCol;
    existing._category_column = locCol;
    existing.y_column         = valCol;   // null for count, metric column for sum/mean
    existing._y_column        = valCol;
    existing.aggregation      = agg;
    existing._aggregation     = agg;
    existing.type             = mapType;
    existing.width            = 2;
  } else {
    const title = valCol
      ? `${locCol} by ${valCol}`
      : `${locCol} Distribution Map`;
    charts.push({ id: `map${charts.length + 1}`, title, ...mapProps });
  }
}

/* ═══════════════════════════════════════════════
   TREEMAP INJECTION
═══════════════════════════════════════════════ */

function _injectTreemapIfRequested(charts, prompt, columns, colTypes) {
  // "hierarchy tree" and "org chart" are handled by _injectIcicleIfRequested instead
  if (!/\btreemap\b|\btree\s*map\b/i.test(prompt)) return;

  const _isIdLikeCol = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );

  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase()
      .replace(/^(?:employee\s+count|headcount|total|sum\s+of|average|count\s+of|number\s+of)\s*/i, '')
      .trim();
    if (!t) return null;
    // Normalise English plurals so "ethnicities"→"ethnicity", "departments"→"department"
    const deplural = s => s.replace(/ies$/, 'y').replace(/ches$|shes$|xes$|zes$/, c => c.slice(0,-2))
                           .replace(/ves$/, 'f').replace(/s$/, '');
    const variants = [...new Set([t, deplural(t)])];
    for (const v of variants) {
      const hit = columns.find(c => c.toLowerCase() === v)
               || columns.find(c => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()))
               || (() => { const tw = v.split(/\s+/).filter(w => w.length > 2);
                    return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
      if (hit) return hit;
    }
    return null;
  };

  // Score every non-ID numeric col by how many of its words appear in the prompt
  const _bestNumColFromPrompt = () => {
    const numericCols = columns.filter(c => colTypes[c] === 'number' && !_isIdLikeCol(c));
    const pl = prompt.toLowerCase();
    const scored = numericCols.map(c => {
      const words = c.toLowerCase().replace(/[_\-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      return { c, score: words.reduce((s, w) => s + (pl.includes(w) ? 1 : 0), 0) };
    }).sort((a, b) => b.score - a.score);
    return scored.length && scored[0].score > 0 ? scored[0].c : (numericCols[0] || null);
  };

  // Broad category extraction (same patterns as waterfall)
  const _extractCatFromPromptTM = () => {
    const patterns = [
      /\bshowing\s+[\w][\w\s]{1,30}?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i,
      /\bby\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i,
      /\bacross\s+(?:different\s+)?([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i,
      /\bper\s+([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i,
      /\bfor\s+each\s+([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i,
      /\bgroup(?:ed)?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i,
      /\busing\s+([\w][\w\s]{1,25}?)\s+as\s+(?:the\s+)?(?:group|category|dimension|x)/i,
      /\b([\w][\w\s]{1,25}?)\s+as\s+the\s+(?:group|category|dimension|x[- ]axis)/i,
      /\bbreakdown\s+(?:of\s+[\w\s]{1,25}?\s+)?by\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(prompt);
      if (m) {
        const c = findCol(m[1].trim());
        if (c && colTypes[c] !== 'number') return c;
      }
    }
    return null;
  };

  let catCol = null, valColRaw = null;
  const showByM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;]|\s*$)/i.exec(prompt);
  if (showByM) {
    const col1 = findCol(showByM[1].trim());
    if (!col1 || colTypes[col1] === 'number') { catCol = findCol(showByM[2].trim()); valColRaw = showByM[1].trim(); }
    else { catCol = col1; valColRaw = showByM[2].trim(); }
  }
  if (!catCol) catCol = _extractCatFromPromptTM();
  catCol = catCol || _goodXCols(columns, colTypes)[0] || columns[0];

  const explicitCount = /\bcount\b|\bnumber\s+of\b|\bheadcount\b|\bemployee\s+count\b/i.test(prompt);
  const explicitAvg   = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt);

  let valCol, agg;
  if (valColRaw) {
    const isMeasureCount = /\bcount\b|\bnumber\s+of\b|\bemployee\s+count\b/i.test(valColRaw);
    valCol = isMeasureCount ? null : (findCol(valColRaw) || _bestNumColFromPrompt());
    agg    = isMeasureCount ? 'count' : /\baverage\b|\bavg\b/i.test(valColRaw) ? 'mean' : 'sum';
  } else if (explicitCount && !explicitAvg) {
    valCol = null; agg = 'count';
  } else {
    valCol = _bestNumColFromPrompt();
    agg    = explicitAvg ? 'mean' : 'sum';
  }

  // Detect optional subgroup column: "subgroup X", "X as (the) subgroup", "X as (the) sub-group"
  const subgroupM = /\b(?:sub[- ]?group|child|drill.?down)\s+(?:of\s+)?(?:[\w\s]{1,20}\s+)?(?:is|as\s+(?:the\s+)?)?(?:subgroup[s]?\s+)?[:\-]?\s*([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i.exec(prompt)
    || /\b([\w][\w\s]{1,25}?)\s+as\s+(?:the\s+)?sub[- ]?group/i.exec(prompt)
    || /\bsub[- ]?group\s+(?:column\s+)?(?:to\s+be\s+)?(?:is\s+)?([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i.exec(prompt);
  let subgroupCol = null;
  if (subgroupM) {
    const sg = findCol(subgroupM[1].trim());
    if (sg && sg !== catCol && colTypes[sg] !== 'number') subgroupCol = sg;
  }
  // Also detect "X or Y as the subgroup" → pick first matching col
  if (!subgroupCol) {
    const orM = /\b([\w][\w\s]{1,20}?)\s+or\s+([\w][\w\s]{1,20}?)\s+as\s+(?:the\s+)?sub[- ]?group/i.exec(prompt);
    if (orM) {
      subgroupCol = findCol(orM[1].trim()) || findCol(orM[2].trim()) || null;
      if (subgroupCol === catCol) subgroupCol = findCol(orM[2].trim()) || null;
      if (subgroupCol && colTypes[subgroupCol] === 'number') subgroupCol = null;
    }
  }
  // Detect "by X and Y" → two-level hierarchy (X = category already set as catCol, Y = subgroup)
  // e.g. "showing UnitPrice by PaymentMethod and OrderStatus"
  if (!subgroupCol) {
    const andM = /\bby\s+([\w][\w\s]{1,25}?)\s+and\s+([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i.exec(prompt);
    if (andM) {
      const andCol2 = findCol(andM[2].trim());
      if (andCol2 && andCol2 !== catCol && colTypes[andCol2] !== 'number') {
        subgroupCol = andCol2;
      } else {
        // Try: maybe andM[1] is catCol candidate and andM[2] is subgroup
        const andCol1 = findCol(andM[1].trim());
        const andCol2b = findCol(andM[2].trim());
        if (andCol2b && andCol2b !== catCol && colTypes[andCol2b] !== 'number') subgroupCol = andCol2b;
        else if (andCol1 && andCol1 !== catCol && colTypes[andCol1] !== 'number') subgroupCol = andCol1;
      }
    }
  }

  const title = subgroupCol
    ? (valCol ? `${valCol} by ${catCol} & ${subgroupCol}` : `${catCol} by ${subgroupCol}`)
    : (valCol ? `${valCol} by ${catCol}` : `${catCol} Distribution`);
  const existing = charts.find(c => c.type === 'treemap');
  if (existing) {
    existing.x_column = catCol; existing.y_column = valCol; existing.aggregation = agg;
    existing._category_column = catCol; existing._y_column = valCol; existing._aggregation = agg;
    existing.color_column = subgroupCol ?? null;  // Always set — clears any stale Ollama value
    existing.title = existing.title || title;
  } else {
    charts.push({ id: `treemap${charts.length+1}`, title,
      type: 'treemap', x_column: catCol, y_column: valCol, aggregation: agg, width: 2,
      color_column: subgroupCol ?? null,
      _category_column: catCol, _y_column: valCol, _aggregation: agg });
  }
}

/* ═══════════════════════════════════════════════
   ICICLE (HIERARCHY TREE / ORG CHART) INJECTION
   Distinct from treemap — shows a top-down rectangular
   hierarchy with parent at the top and children branching
   downward (like an org chart / tree diagram).
═══════════════════════════════════════════════ */
function _injectIcicleIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bhierarchy\s*tree\b|\borg\s*chart\b|\bhierarchy\b|\bicicle\b/i.test(prompt)) return;

  const _isIdLike = c => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    c.toLowerCase().replace(/[\s_\-]+/g, ' ')
  );
  const findCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase();
    return columns.find(c => c.toLowerCase() === t)
      || columns.find(c => c.toLowerCase().includes(t) || t.includes(c.toLowerCase()))
      || (() => { const tw = t.split(/\s+/).filter(w => w.length > 2);
           return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null; })();
  };

  // Best non-ID categorical column
  const catCols = _goodXCols(columns, colTypes).filter(c => !_isIdLike(c));
  const allCats = columns.filter(c => colTypes[c] !== 'number' && !_isIdLike(c));
  let parentCol = catCols[0] || allCats[0] || null;

  // ── Comprehensive column detection ─────────────────────────────────────
  // P1: "hierarchy [tree/chart] of/for/by X [and/by Y]"  e.g. "hierarchy of Payment Method"
  const pOf = /\b(?:hierarchy\s*(?:tree|chart)?|org\s*chart|icicle)\b[^,\n]*?\b(?:of|for|by)\s+([\w][\w\s]{1,30}?)(?:\s+(?:and|by)\s+([\w][\w\s]{1,30}?))?(?=\s+(?:with|showing|using|chart|visual|\n)|[,;.]|\s*$)/i.exec(prompt);

  // P2: "hierarchy … X and/by Y"  — both cols appear after keyword (no 'of/for')
  const pAndBy = !pOf && /\b(?:hierarchy|org\s*chart|icicle)\b.*?\b([\w][\w\s]{1,25}?)\s+(?:and|by)\s+([\w][\w\s]{1,25}?)(?=\s|[,;]|$)/i.exec(prompt);

  // P3: "X [and/by Y] hierarchy"  — column name BEFORE keyword
  const pBefore = !pOf && !pAndBy && (
      /\b([\w][\w\s]{1,25}?)\s+(?:and|by)\s+([\w][\w\s]{1,25}?)\s+(?:hierarchy|org\s*chart|icicle)/i.exec(prompt)
   || /\b([\w][\w\s]{1,25}?)\s+(?:hierarchy|org\s*chart|icicle)/i.exec(prompt)
  );

  let childCol = catCols.find(c => c !== parentCol) || allCats.find(c => c !== parentCol) || null;

  const active = pOf || pAndBy || pBefore;
  if (active) {
    const raw1 = active[1] ? active[1].trim() : null;
    const raw2 = active[2] ? active[2].trim() : null;
    const c1 = findCol(raw1), c2 = raw2 ? findCol(raw2) : null;
    if (c1 && colTypes[c1] !== 'number') parentCol = c1;
    if (c2 && colTypes[c2] !== 'number' && c2 !== parentCol) childCol = c2;
    else childCol = catCols.find(c => c !== parentCol) || allCats.find(c => c !== parentCol) || null;
  }

  if (!parentCol) return;

  // Value / metric column
  const numCols = columns.filter(c => colTypes[c] === 'number' && !_isIdLike(c));
  const valM = /\bshowing\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i.exec(prompt)
            || /\bwith\s+([\w][\w\s]{1,30}?)\s+as\s+(?:the\s+)?(?:metric|measure|value)/i.exec(prompt)
            || /\bweighted?\s+by\s+([\w][\w\s]{1,30}?)(?=\s|[,;]|$)/i.exec(prompt);
  const useCount = /\bcount\b|\bnumber\s+of\b/i.test(prompt);
  let valCol = null, agg = 'count';
  if (!useCount) {
    valCol = (valM ? findCol(valM[1].trim()) : null) || numCols[0] || null;
    if (valCol) agg = /\baverage\b|\bavg\b|\bmean\b/i.test(prompt) ? 'mean' : 'sum';
  }

  const title = childCol
    ? `${parentCol} → ${childCol} Hierarchy`
    : `${parentCol} Hierarchy Tree`;

  const spec = {
    id: `icicle${charts.length + 1}`, title,
    type: 'icicle',
    x_column: parentCol, y_column: valCol,
    color_column: childCol || null,
    aggregation: agg, width: 2,
    _category_column: parentCol, _y_column: valCol, _aggregation: agg
  };

  // Replace any Ollama-generated treemap that was meant to be a hierarchy tree
  const existingIdx = charts.findIndex(c => c.type === 'icicle' || c.type === 'treemap');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   HISTOGRAM INJECTION
   Fires when prompt asks for distribution/histogram
   but Ollama produced a bar/column chart instead.
═══════════════════════════════════════════════ */

function _injectHistogramIfRequested(charts, prompt, columns, colTypes) {
  const isHistPat = /\bhistogram\b|\bfrequency\s+dist(?:ribution)?\b|\bspread\s+of\b|\bbin(?:ned|s)?\b/i;
  if (!isHistPat.test(prompt)) return;
  if (charts.find(c => c.type === 'histogram')) return; // already present

  const pLower = prompt.toLowerCase();
  const numCols = columns.filter(c => colTypes[c] === 'number');
  if (!numCols.length) return;

  // Find the numeric column mentioned in the prompt
  let xCol = null;
  for (const c of numCols) {
    const words = c.toLowerCase().replace(/[_\-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    if (words.some(w => pLower.includes(w))) { xCol = c; break; }
  }
  if (!xCol) xCol = numCols.find(c => !/\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(c)) || numCols[0];
  if (!xCol) return;

  // Replace the first non-histogram bar chart if it was clearly intended as histogram
  const barIdx = charts.findIndex(c => c.type === 'bar');
  const hist = {
    id: `hist${charts.length + 1}`, title: `${xCol} Distribution`,
    type: 'histogram', x_column: xCol, y_column: null, aggregation: 'none',
    width: 1, orientation: 'v', sort_by: 'none', sort_order: 'asc', top_n: null,
    _y_column: null, _category_column: xCol, _aggregation: 'none'
  };
  if (barIdx !== -1) {
    charts.splice(barIdx, 1, hist);
  } else {
    charts.push(hist);
  }
}

/* ═══════════════════════════════════════════════
   BOX AND WHISKER PLOT INJECTION
   Fires when prompt asks for box/whisker but the LLM
   returned a bar or other chart type instead.
═══════════════════════════════════════════════ */

function _injectBoxIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bbox\s*(?:and\s*)?whisker\b|\bbox\s*plot\b|\bbox\s*chart\b|\bwhisker\b/i.test(prompt)) return;
  if (charts.find(c => c.type === 'box')) return; // already present

  const numCols = columns.filter(c => colTypes[c] === 'number');
  if (!numCols.length) return;

  const goodX = _goodXCols(columns, colTypes);

  // Split camelCase + underscores for fuzzy matching
  const splitCol = name => name.replace(/([a-z])([A-Z])/g, '$1 $2')
                               .replace(/[_\-]/g, ' ').toLowerCase()
                               .split(/\s+/).filter(w => w.length > 2);

  // Resolve y_column (the distribution — numeric) — camelCase-aware
  let yCol = null;
  const pLower = prompt.toLowerCase();
  for (const c of numCols) {
    if (splitCol(c).some(w => pLower.includes(w))) { yCol = c; break; }
  }
  if (!yCol) yCol = numCols.find(c => !/\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(c)) || numCols[0];

  // Resolve x_column (grouping / categorical) from "by <dimension>" — camelCase-aware
  let xCol = null;
  const byMatch = prompt.match(/\bby\s+([\w][\w\s]{1,30}?)(?:[,;.]|\s+and\b|\s*$)/i);
  if (byMatch) {
    const hint = byMatch[1].trim().toLowerCase();
    xCol = goodX.find(c => c.toLowerCase() === hint)
        || goodX.find(c => c.toLowerCase().includes(hint) || hint.includes(c.toLowerCase()))
        || goodX.find(c => splitCol(c).some(w => hint.includes(w)))
        || null;
  }
  if (!xCol) xCol = goodX[0] || null;

  const title = xCol ? `${yCol} Distribution by ${xCol}` : `${yCol} Distribution`;
  const box = {
    id: `box${charts.length + 1}`, title, type: 'box',
    x_column: xCol, y_column: yCol, aggregation: 'none',
    width: xCol ? 2 : 1, sort_by: 'none', sort_order: 'asc', top_n: null,
    _y_column: yCol, _category_column: xCol, _aggregation: 'none'
  };

  // Always push at the end to preserve user-specified chart order
  charts.push(box);
}

/* ═══════════════════════════════════════════════
   MARIMEKKO / MEKKO / MOSAIC CHART INJECTION
   Fires when prompt asks for marimekko but LLM
   returned a bar or other chart type instead.
═══════════════════════════════════════════════ */

function _injectMarimekkoIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bmarimekko\b|\bmekko\b|\bmosaic\s+chart\b/i.test(prompt)) return;

  // Fix any existing chart that has a marimekko title but wrong type
  const wrongType = charts.find(c =>
    c.type !== 'marimekko' && /marimekko|mekko|mosaic/i.test(c.title || '')
  );
  if (wrongType) { wrongType.type = 'marimekko'; wrongType.width = 2; return; }

  if (charts.find(c => c.type === 'marimekko')) return; // already present

  const goodX   = _goodXCols(columns, colTypes);
  const numCols = columns.filter(c => colTypes[c] === 'number');
  if (goodX.length < 2) return; // need at least 2 categorical columns

  const splitCol = name => name.replace(/([a-z])([A-Z])/g, '$1 $2')
                               .replace(/[_\-]/g, ' ').toLowerCase()
                               .split(/\s+/).filter(w => w.length > 2);

  // Resolve x_column (column widths) and color_column (segments) from "by X and Y" pattern
  const pLower = prompt.toLowerCase();
  let xCol = null, colorCol = null;

  const byAndMatch = prompt.match(/\bby\s+([\w][\w\s]{1,30}?)\s+and\s+([\w][\w\s]{1,30}?)(?:[,;.(]|\s*$)/i);
  if (byAndMatch) {
    const h1 = byAndMatch[1].trim().toLowerCase();
    const h2 = byAndMatch[2].trim().toLowerCase();
    xCol     = goodX.find(c => c.toLowerCase() === h1)
            || goodX.find(c => c.toLowerCase().includes(h1) || h1.includes(c.toLowerCase()));
    colorCol = goodX.find(c => c !== xCol && (c.toLowerCase() === h2 || c.toLowerCase().includes(h2) || h2.includes(c.toLowerCase())));
  }

  // Fallback: first two good categorical columns
  if (!xCol)     xCol     = goodX[0];
  if (!colorCol) colorCol = goodX.find(c => c !== xCol) || goodX[1] || null;

  // y_column: numeric (sum) or null (count)
  let yCol = null, agg = 'count';
  for (const c of numCols) {
    if (splitCol(c).some(w => pLower.includes(w))) { yCol = c; agg = 'sum'; break; }
  }
  if (!yCol && numCols.length) { yCol = numCols[0]; agg = 'sum'; }

  const title = `${yCol || 'Count'} by ${xCol} and ${colorCol} (Marimekko)`;
  const spec = {
    id: `marimekko${charts.length + 1}`, title, type: 'marimekko',
    x_column: xCol, y_column: yCol, color_column: colorCol,
    aggregation: agg, width: 2, sort_by: 'none', sort_order: 'desc', top_n: null,
    _y_column: yCol, _category_column: xCol, _aggregation: agg
  };

  // Replace the first bar chart the LLM generated, or push at end
  const barIdx = charts.findIndex(c => c.type === 'bar');
  if (barIdx !== -1) { spec.id = charts[barIdx].id; charts[barIdx] = spec; }
  else charts.push(spec);
}

/* ═══════════════════════════════════════════════
   GAUGE / KPI INDICATOR INJECTION
   Handles: "gauge chart", "KPI visual", "speedometer",
   "indicator chart", "KPI gauge showing X"
═══════════════════════════════════════════════ */

function _injectGaugeIfRequested(charts, prompt, columns, colTypes) {
  const isGaugePat = /\bgauge\s*(?:chart|visual|indicator)?\b|\bkpi\s+(?:visual|indicator|gauge)\b|\bspeedometer\b|\bindicator\s+chart\b/i;
  if (!isGaugePat.test(prompt)) return;

  /* ── Shared helper: parse min/max/target from any reasonable user phrasing ──────────
     Handles all common formats:
       min=40000  |  min: 40000  |  minimum 40000  |  minimum value 40000
       minimum of 40000  |  starts at 40000  |  from 40000 to 150000
       max=150000  |  maximum value 150000  |  up to 150000  |  capped at 150000
       target=80000  |  target value 80000  |  benchmark 80000  |  goal 80000
       $40,000 format  |  40,000 comma-separated
  ──────────────────────────────────────────────────────────────────────────────── */
  const _pN = s => Number(String(s || '').replace(/[$,\\]/g, ''));
  const _parseGaugeRange = p => {
    // Strip LaTeX math markers: \(\$50,000\) → 50,000  (UI sometimes renders numbers as LaTeX)
    const c = p.replace(/\\\(\\?\$?([\d,]+(?:\.\d+)?)\\\)/g, '$1');
    // Flexible separator: optional parenthetical qualifier + optional "to" + optional "=:" + optional "$"
    // Handles: "minimum value to $50,000", "target value (benchmark) to $85,000", "max=150000", etc.
    const minRe    = /\b(?:min(?:imum)?(?:\s+(?:value|of|is|at))?|starts?\s+(?:at|from))(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
    const maxRe    = /\b(?:max(?:imum)?(?:\s+(?:value|of|is|at))?|up\s+to|capped?\s+at)(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
    const tgtRe    = /\b(?:target(?:\s+(?:value|of|is|at))?|benchmark|goal|threshold)(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i;
    const fromToRe = /\b(?:from|range\s*[=:]?)\s+\\?\$?([\d,]+(?:\.\d+)?)\s+to\s+\\?\$?([\d,]+(?:\.\d+)?)/i;
    const minM = minRe.exec(c), maxM = maxRe.exec(c), tgtM = tgtRe.exec(c), ftM = fromToRe.exec(c);
    return {
      minV: minM ? _pN(minM[1]) : (ftM ? _pN(ftM[1]) : null),
      maxV: maxM ? _pN(maxM[1]) : (ftM ? _pN(ftM[2]) : null),
      tgtV: tgtM ? _pN(tgtM[1]) : null
    };
  };

  // If Ollama already returned a gauge chart, clean up x_column and enrich with
  // min/max/target values parsed from the prompt.
  // User-specified values ALWAYS win — Ollama's auto-defaults (e.g. min=0, max=auto)
  // must be replaced by what the user explicitly asked for in the prompt.
  const existing = charts.find(c => c.type === 'gauge');
  if (existing) {
    existing.x_column         = null;
    existing._category_column = null;
    const { minV, maxV, tgtV } = _parseGaugeRange(prompt);
    if (minV != null) existing.min_value    = minV;  // always override Ollama's default
    if (maxV != null) existing.max_value    = maxV;
    if (tgtV != null) existing.target_value = tgtV;
    if (!existing.format && /salary|pay|revenue|income|wage|earn|cost|price|budget|profit|amount|bonus/i.test(existing.y_column || '')) {
      existing.format = 'currency';
    }
    return;
  }

  // Strip LaTeX markers before keyword/aggregation matching (same as _parseGaugeRange)
  const pLower = prompt.replace(/\\\(\\?\$?([\d,]+(?:\.\d+)?)\\\)/g, '$1').toLowerCase();
  const numCols = columns.filter(c => colTypes[c] === 'number');

  /* Resolve a raw text fragment to a column name */
  const findNumCol = raw => {
    if (!raw) return null;
    const t = raw.trim().toLowerCase()
      .replace(/^(?:total|sum\s+of|average\s+of?|average|avg|count\s+of|number\s+of|max(?:imum)?\s+of?|min(?:imum)?\s+of?|median\s+of?)\b\s*/i, '')
      .trim();
    if (!t) return null;
    return columns.find(c => c.toLowerCase() === t)
        || columns.find(c => c.toLowerCase().includes(t) || t.includes(c.toLowerCase()))
        || (() => {
             const tw = t.split(/\s+/).filter(w => w.length > 2);
             return columns.find(c => tw.some(w => c.toLowerCase().includes(w))) || null;
           })();
  };

  /* Aggregation from prompt keywords.
     IMPORTANT: "max=150000" / "minimum value to $40,000" are range markers, NOT aggregations.
     Only treat max/min as aggregation when NOT followed by a number (even with "to" separator). */
  const _isRangeMax = /\bmax(?:imum)?(?:\s+(?:value|of|is|at))?(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?[\d,]+/i.test(pLower);
  const _isRangeMin = /\bmin(?:imum)?(?:\s+(?:value|of|is|at))?(?:\s*\([^)]*\))?\s*(?:to\s+)?[=:]?\s*\$?[\d,]+/i.test(pLower);
  let agg = 'sum';
  if (/\baverage\b|\bmean\b|\bavg\b/i.test(pLower))                   agg = 'mean';
  else if (/\bcount\b|\bheadcount\b|\bnumber\s+of\b/i.test(pLower))   agg = 'count';
  else if (/\bmedian\b/i.test(pLower))                                 agg = 'median';
  else if (/\bmax(?:imum)?\b/i.test(pLower) && !_isRangeMax)          agg = 'max';
  else if (/\bmin(?:imum)?\b/i.test(pLower) && !_isRangeMin)          agg = 'min';

  /* Extract the column name from the prompt */
  let yCol = null;
  const showM = /\bgauge\s+(?:showing|for|of|with)\s+([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s+(?:with|min|max|target|by)\b|\s*$)/i.exec(prompt)
             || /\bkpi\s+(?:visual|indicator|gauge)\s+(?:showing|for|of)?\s*([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s+(?:with|min|max|target|by)\b|\s*$)/i.exec(prompt);
  if (showM) {
    yCol = findNumCol(showM[1].trim());
  }
  if (!yCol) {
    // Try "total/average/sum/count X" pattern
    const measM = /\b(?:total|sum\s+of|average\s+of?|avg|max(?:imum)?\s+of?|min(?:imum)?\s+of?|median\s+of?)\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s+(?:with|min|max|target|by)\b|\s*$)/i.exec(prompt);
    if (measM) yCol = findNumCol(measM[1].trim());
  }
  if (!yCol && agg !== 'count') {
    // Fall back to best numeric column (skip ID-like columns)
    yCol = numCols.find(c => !/\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(c)) || numCols[0] || null;
  }

  /* Optional min / max / target — use the shared comprehensive parser */
  const { minV, maxV, tgtV } = _parseGaugeRange(prompt);
  const parseNum = s => Number(String(s || '').replace(/[$,]/g, ''));

  /* Derive title */
  const colLabel = yCol || 'Count';
  const aggLabel = { mean: 'Average', count: 'Total', sum: 'Total', median: 'Median', max: 'Maximum', min: 'Minimum' }[agg] || 'Total';
  const derivedTitle = `${aggLabel} ${colLabel}`;

  /* Currency format when column name suggests money */
  const isCurrency = /salary|pay|revenue|income|wage|earn|cost|price|budget|profit|amount|bonus/i.test(yCol || '');

  const gaugeSpec = {
    id:           `gauge${charts.length + 1}`,
    title:        derivedTitle,
    type:         'gauge',
    x_column:     null,
    y_column:     yCol,
    _y_column:    yCol,
    _category_column: null,
    aggregation:  agg,
    _aggregation: agg,
    width:        1,
    sort_by:      'none',
    sort_order:   'asc',
    ...(minV != null ? { min_value:    minV } : {}),
    ...(maxV != null ? { max_value:    maxV } : {}),
    ...(tgtV != null ? { target_value: tgtV } : {}),
    ...(isCurrency   ? { format: 'currency' }  : {})
  };

  // Replace first bar chart (Ollama often returns bar for gauge requests), or push new
  const firstBarIdx = charts.findIndex(c => c.type === 'bar');
  if (firstBarIdx !== -1) {
    charts.splice(firstBarIdx, 1, gaugeSpec);
  } else {
    charts.push(gaugeSpec);
  }
}

/* ═══════════════════════════════════════════════
   MULTI-ROW CARD INJECTION
   Maps to type="table" (rows of selected fields)
═══════════════════════════════════════════════ */

function _injectMultiRowCardIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bmulti[-\s]?row\s+card\b/i.test(prompt)) return;
  if (charts.find(c => c.type === 'multi_row_card')) return;  // already have one

  const norm = s => s.toLowerCase().replace(/[\s_\-]+/g, '');

  // Strategy 1: columns explicitly listed after "showing/with/display/:":  — allow \s* so "metrics:Total" also matches
  const m = /\bmulti[-\s]?row\s+card\b.*?(?:showing|with|display(?:ing)?|:)\s*(.+)/i.exec(prompt);
  let tableCols;
  if (m) {
    // Strip "by <column>" suffix from each hint so "ItemsInCart by PaymentMethod" → "ItemsInCart"
    const hints = m[1].split(/,|\band\b/i)
      .map(s => s.replace(/\s+by\s+[\w][\w\s]{0,30}?\s*$/i, '').trim())
      .filter(Boolean);
    const matched = hints.map(h =>
      columns.find(c => c.toLowerCase() === h.toLowerCase())
      || columns.find(c => norm(c) === norm(h))
      || columns.find(c => norm(c).includes(norm(h)) || (norm(h).length > 3 && norm(h).includes(norm(c))))
    ).filter(Boolean);
    tableCols = matched.length >= 2 ? [...new Set(matched)] : null;
  }

  // Strategy 2: scan the full prompt for any column names that appear verbatim
  if (!tableCols || tableCols.length < 2) {
    const pLower = prompt.toLowerCase();
    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentioned = columns.filter(c => {
      const cn = norm(c);
      if (cn.length < 3) return false;
      // Use \b word-boundary matching so "Age" does NOT match inside "average"
      return new RegExp('\\b' + escRe(c.toLowerCase()) + '\\b').test(pLower)
          || new RegExp('\\b' + escRe(cn) + '\\b').test(pLower);
    });
    if (mentioned.length >= 2) tableCols = mentioned;
  }

  // Strategy 3: fallback — extract via _extractTableColumns or first 10 columns
  if (!tableCols || tableCols.length < 2) {
    tableCols = _extractTableColumns(prompt, columns);
    if (tableCols.length < 2) tableCols = columns.slice(0, 10);
  }

  // Extract x_column hint from "group by / by X / for each X" — look in full prompt
  const xHintM = /\b(?:group(?:ed)?\s+by|category\s+(?:well\s+)?(?:for|by)|grouped?\s+(?:on|for)|by)\s+([\w][^\.,!?\n]{1,30}?)(?:\s+(?:or|and)\s+([\w][^\.,!?\n]{1,25}?))?(?:\s|$)/i.exec(prompt);

  // Derive x_column (first categorical col) and build metrics from numeric cols
  const types = colTypes || {};
  const numTableCols = tableCols.filter(c => types[c] === 'number');
  const catTableCols = tableCols.filter(c => types[c] !== 'number');

  // Prefer x_column hinted in the prompt (e.g. "Group by Gender or Country")
  let xCol = null;
  if (xHintM) {
    const candidates = [xHintM[1], xHintM[2]].filter(Boolean).map(h => h.trim());
    for (const h of candidates) {
      xCol = columns.find(c => c.toLowerCase() === h.toLowerCase())
          || columns.find(c => norm(c) === norm(h))
          || columns.find(c => norm(c).includes(norm(h)));
      if (xCol) break;
    }
  }
  if (!xCol) xCol = catTableCols[0] || _goodXCols(columns, types)[0] || null;
  const yCol = numTableCols[0] || columns.find(c => types[c] === 'number') || null;

  // Local helpers (delegate to shared utilities)
  const fmtFor  = col => _inferFmtFromCol(col, types);
  const aggFor  = col => _inferAggFromText(col) || (_inferFmtFromCol(col, types) === 'percent' ? 'mean' : 'sum');
  const isIdCol = col => /\b(id|no|num|number|serial|rank|index|row|sr)\b/i.test(
    (col || '').toLowerCase().replace(/[\s_\-]+/g, ' ')
  );
  const resolveCol = (hint, forceNull) => {
    if (forceNull) return null;
    return columns.find(c => c.toLowerCase() === hint.toLowerCase())
        || columns.find(c => norm(c) === norm(hint))
        || columns.find(c => norm(c).includes(norm(hint)) || (norm(hint).length > 3 && norm(hint).includes(norm(c))))
        || _findBestCol(hint, columns, types, false)
        || null;
  };

  const aggMap = {
    count: 'count', sum: 'sum', average: 'mean', avg: 'mean',
    min: 'min', minimum: 'min', max: 'max', maximum: 'max', median: 'median',
    'distinct count': 'count_distinct', 'count distinct': 'count_distinct',
    distinctcount: 'count_distinct', countdistinct: 'count_distinct'
  };

  /* ═══════════════════════════════════════════════════════════════════
     Strategy 0 — Parse explicit metric definitions from prompt
     Supports four formats (tried in order, stops once ≥2 found):

     A) DAX style       "Label: AGG(Column)"
        e.g. "Total Annual Salary: SUM(Annual Salary)"

     B) Natural style   "Label (Agg of Column)"
        e.g. "Average Annual Salary (Average of Annual Salary)"
        Also handles Distinct Count, Minimum, Maximum

     C) Inline phrase   "total/avg/count [of] <Column>"
        e.g. "total salary, avg age, count of employees"
        Parsed from comma/newline-separated lists in the prompt

     D) Noun phrase     "<Label>" lines — each line is a bare column name
        or known synonym (e.g. "Headcount", "Total Payroll")
  ═════════════════════════════════════════════════════════════════════ */
  const parsedMetrics = [];
  let mm;

  /* ── Shared label cleanup: strips leading preamble text before last :/ , separator ── */
  const cleanLabel = raw => {
    let s = (raw || '').trim().replace(/^[-–•*\s\d.]+/, '');
    // Strip common prompt preamble that the DAX regex may have captured along with the label
    // e.g. "Create a multi-row card with Total Quantity" → "Total Quantity"
    s = s.replace(/^(?:create\s+(?:a\s+)?)?(?:multi[-\s]?row\s+card\s+)?(?:show(?:ing)?\s+|with\s+|display(?:ing)?\s+)/i, '').trim();
    // Strip any preamble before the last colon or comma (e.g. "Create a card with: Total Employees" → "Total Employees")
    const sepIdx = Math.max(s.lastIndexOf(':'), s.lastIndexOf(','));
    if (sepIdx !== -1) s = s.slice(sepIdx + 1).trim();
    return s || (raw || '').trim();   // fall back to raw if cleaning emptied the string
  };

  // ── Format A: "Label: AGG(Column)" ──
  const metricReDax = /([^\n:,()]{3,50}?)\s*:\s*(COUNT|SUM|AVERAGE|AVG|MIN|MAX|MEDIAN)\s*\(\s*([^)]{2,50}?)\s*\)/gi;
  while ((mm = metricReDax.exec(prompt)) !== null) {
    const label = cleanLabel(mm[1]);
    const agg   = aggMap[mm[2].toLowerCase()] || 'sum';
    const col   = resolveCol(mm[3].trim(), agg === 'count');
    if (label && (agg === 'count' || col)) parsedMetrics.push({ label, column: col || null, aggregation: agg, format: fmtFor(col) });
  }

  // ── Format B: "Label (Agg of Column)" ──
  if (parsedMetrics.length < 2) {
    const metricReNL = /([^\n()]{3,60}?)\s*\(\s*(DISTINCT\s+COUNT|COUNT\s+DISTINCT|COUNT|SUM|AVERAGE|AVG|MINIMUM|MAXIMUM|MIN|MAX|MEDIAN)\s+OF\s+([^)]{2,50}?)\s*\)/gi;
    while ((mm = metricReNL.exec(prompt)) !== null) {
      const label    = cleanLabel(mm[1]);
      const aggKey   = mm[2].toLowerCase().replace(/\s+/g, ' ');
      const agg      = aggMap[aggKey] || aggMap[norm(aggKey)] || 'sum';
      const colFinal = (agg === 'count') ? null : resolveCol(mm[3].trim(), false);
      if (label && (agg === 'count' || colFinal)) parsedMetrics.push({ label, column: colFinal || null, aggregation: agg, format: fmtFor(colFinal) });
    }
  }

  // ── Format C: inline "total/avg/count [of] <column>" phrases ──
  // Handles comma/newline-separated lists: "count employees, total salary, avg bonus"
  if (parsedMetrics.length < 2) {
    const metricReInline = /\b(total|sum\s+of|sum|average\s+of|average|avg\s+of|avg|mean\s+of|mean|count\s+of|count|number\s+of|distinct\s+count\s+of|unique|minimum\s+of|minimum|min\s+of|earliest|maximum\s+of|maximum|max\s+of|latest)\s+([\w][\w\s]{1,40}?)(?=\s*[,;\n]|$)/gi;
    while ((mm = metricReInline.exec(prompt)) !== null) {
      const aggPhrase = mm[1].trim().toLowerCase();
      const colHint   = mm[2].trim();
      const agg = aggPhrase.startsWith('total') || aggPhrase.startsWith('sum') ? 'sum'
                : aggPhrase.startsWith('average') || aggPhrase.startsWith('avg') || aggPhrase.startsWith('mean') ? 'mean'
                : aggPhrase.startsWith('count of') || aggPhrase.startsWith('number of') || aggPhrase === 'count' ? 'count'
                : aggPhrase.startsWith('distinct') || aggPhrase.startsWith('unique') ? 'count_distinct'
                : aggPhrase.startsWith('min') || aggPhrase.startsWith('earliest') ? 'min'
                : aggPhrase.startsWith('max') || aggPhrase.startsWith('latest') ? 'max'
                : 'sum';
      const col = (agg === 'count') ? null : resolveCol(colHint, false);
      const label = mm[0].trim().replace(/^[-–•*\s\d.]+/, '');
      if ((agg === 'count' || col) && !parsedMetrics.find(m => m.column === col && m.aggregation === agg)) {
        parsedMetrics.push({ label, column: col || null, aggregation: agg, format: fmtFor(col) });
      }
    }
  }

  // ── Format D: noun-phrase / bare column lines ──
  // e.g. "Headcount", "Total Payroll", "Average Tenure" as individual lines or bullets
  // Also handles "ItemsInCart by PaymentMethod" → strips "by PaymentMethod" to find ItemsInCart
  if (parsedMetrics.length < 2) {
    // Allow up to max(2, numTableCols.length) metrics so all explicitly listed columns are captured
    const _maxD = Math.max(2, numTableCols.length);
    const lines = prompt.split(/[\n,;]/).map(l => l.replace(/^[\s\-–•*\d.]+/, '').trim()).filter(l => l.length > 2 && l.length < 80);
    for (const line of lines) {
      // Strip trailing "by <column>" or "grouped by <column>" so "ItemsInCart by PaymentMethod" → "ItemsInCart"
      const cleanedLine = line.replace(/\s+by\s+[\w][\w\s]{0,30}?\s*$/i, '').trim();
      if (!cleanedLine || cleanedLine.length < 2) continue;
      const agg = _inferAggFromText(cleanedLine);
      const colHint = cleanedLine.replace(/^(total|sum|average|avg|count|unique|distinct|min|max|median)\s+(of\s+)?/i, '').trim();
      const col = resolveCol(colHint, agg === 'count');
      const finalAgg = agg || (col ? aggFor(col) : 'count');
      // Skip: no valid column and no explicit count/count_distinct aggregation
      if (!col && agg !== 'count') continue;
      // Skip: categorical column with a numeric aggregation (can't sum/mean a string column)
      if (col && types[col] !== 'number' && !['count', 'count_distinct'].includes(finalAgg)) continue;
      // Skip: already reached the target metric count and this line has no explicit aggregation
      if (!agg && parsedMetrics.length >= _maxD) continue;
      // Skip duplicates
      if (parsedMetrics.find(m => m.column === col && m.aggregation === finalAgg)) continue;
      // Use the column name as a clean label (Format D resolves bare column references)
      const label = col ? col : (finalAgg === 'count' ? 'Count' : cleanedLine);
      parsedMetrics.push({ label, column: col || null, aggregation: finalAgg, format: fmtFor(col) });
    }
  }

  /* Build final metrics list */
  let metrics;
  const hasGroupByHint = !!xHintM;

  if (parsedMetrics.length >= 2) {
    metrics = parsedMetrics.slice(0, 8);
    if (!hasGroupByHint) xCol = null;
  } else {
    // No explicit definitions — infer from numeric columns
    metrics = [{ label: 'Count', column: null, aggregation: 'count', format: 'number' }];
    const meaningfulNums = numTableCols.filter(c => !isIdCol(c));
    for (const c of meaningfulNums.slice(0, 3)) {
      metrics.push({ label: c, column: c, aggregation: aggFor(c), format: fmtFor(c) });
    }
    if (metrics.length === 1 && yCol && !isIdCol(yCol)) {
      metrics.push({ label: yCol, column: yCol, aggregation: aggFor(yCol), format: fmtFor(yCol) });
    }
  }

  charts.push({ id: `mrc${charts.length + 1}`, title: 'Multi-Row Card',
    type: 'multi_row_card', x_column: xCol, y_column: yCol,
    columns: tableCols, metrics, aggregation: 'none', width: 2,
    _category_column: xCol, _y_column: yCol, _aggregation: 'none' });
}

/* ═══════════════════════════════════════════════
   SLICER INJECTION
   Adds filter entries — does NOT create a chart.
═══════════════════════════════════════════════ */

function _injectSlicerIfRequested(filters, prompt, columns, colTypes) {
  if (!/\bslicer\b/i.test(prompt)) return;

  // "slicer for/on/by X and Y, Z" → extract the full column list
  const listM = /\bslicer\s+(?:for|on|by)\s+([\w][\w\s,&]{2,80}?)(?:\s*[.!?]|\s*$)/i.exec(prompt);
  if (listM) {
    const hints = listM[1].split(/,|\band\b/i).map(s => s.trim()).filter(Boolean);
    for (const hint of hints) {
      const col = _findBestCol(hint, columns, colTypes, false);
      if (col && !filters.find(f => f.column === col))
        filters.push({ column: col, label: col, type: colTypes[col] === 'date' ? 'date' : 'categorical' });
    }
  } else {
    // "X slicer" pattern — single column
    const xM = /([\w][\w\s]{1,30}?)\s+slicer\b/i.exec(prompt);
    if (xM) {
      const col = _findBestCol(xM[1].trim(), columns, colTypes, false);
      if (col && !filters.find(f => f.column === col))
        filters.push({ column: col, label: col, type: colTypes[col] === 'date' ? 'date' : 'categorical' });
    } else {
      // Generic "add a slicer" with no column name → add top 3 categorical
      _goodXCols(columns, colTypes).slice(0, 3).forEach(col => {
        if (!filters.find(f => f.column === col))
          filters.push({ column: col, label: col, type: 'categorical' });
      });
    }
  }
}

/* ═══════════════════════════════════════════════
   COMPARISON / SECONDARY KPI INJECTION
   Parses "comparison against X" and "secondary indicator for Y"
   from the user prompt. Attaches them as sub-specs on the primary
   KPI card so the browser renders them as sub-values in one card.
   Called AFTER titleToKpi has resolved all KPI titles.
═══════════════════════════════════════════════ */

function _injectComparisonKPIs(kpi_cards, prompt, columns, colTypes) {
  if (!prompt || !kpi_cards.length) return;
  const toTC = s => s.trim().replace(/\b\w/g, c => c.toUpperCase());

  // Target: the primary KPI card (first one)
  const primaryKpi = kpi_cards[0];

  // ── "comparison against [the] X [salary]" ───────────────
  const compM = /comparison\s+against\s+(?:the\s+)?([A-Za-z][A-Za-z\s]{2,45}?)(?=\s+and\b|\s*[,.]|$)/i.exec(prompt);
  if (compM && !primaryKpi.comparison) {
    const title = toTC(compM[1].trim());
    const res   = titleToKpi(title, columns, colTypes);
    // Only attach if meaningfully different from primary (different aggregation or column)
    if (res.aggregation !== primaryKpi.aggregation || res.column !== primaryKpi.column) {
      primaryKpi.comparison = {
        label:       title,
        column:      res.column,
        aggregation: res.aggregation,
        format:      res.format
      };
    }
  }

  // ── "secondary indicator for X" / "secondary metric for X" ──
  const secM = /secondary\s+(?:indicator|metric|kpi)\s+(?:for|of)\s+([A-Za-z][A-Za-z ]{1,45}?)(?=[ \t]*[,.]|[ \t]*$)/im.exec(prompt);
  if (secM && !primaryKpi.secondary) {
    const title = toTC(secM[1].trim());
    const res   = titleToKpi(title, columns, colTypes);
    primaryKpi.secondary = {
      label:       title,
      column:      res.column,
      aggregation: res.aggregation,
      format:      res.format
    };
  }

  // ── Deduplicate: Ollama may have created separate cards for comparison/secondary.
  //    Remove any KPI card (index >= 1) whose aggregation+column is already represented
  //    in the primary card's comparison or secondary sub-spec.
  if (primaryKpi.comparison || primaryKpi.secondary) {
    const compAgg = primaryKpi.comparison?.aggregation;
    const compCol = primaryKpi.comparison?.column;
    const secAgg  = primaryKpi.secondary?.aggregation;
    const secCol  = primaryKpi.secondary?.column;

    for (let i = kpi_cards.length - 1; i >= 1; i--) {
      const k = kpi_cards[i];
      const matchesComp = compAgg && k.aggregation === compAgg && k.column === compCol;
      const matchesSec  = secAgg  && k.aggregation === secAgg  &&
                          (secAgg === 'count' || k.column === secCol);
      if (matchesComp || matchesSec) {
        kpi_cards.splice(i, 1);
      }
    }
  }
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
      case 'median':         expr = `MEDIANX('${tableName}','${tableName}'[${col}])`; fmtStr = '#,0.00'; break;
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
  let firstIdx = -1;
  while (pos < s.length) {
    const idx = s.indexOf('{', pos);
    if (idx === -1) break;
    if (firstIdx === -1) firstIdx = idx;
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
  // Truncated JSON recovery: if num_predict cut the output mid-stream, attempt to close open brackets
  if (firstIdx !== -1) {
    try {
      let fragment = s.slice(firstIdx);
      // Strip any trailing incomplete string or key
      fragment = fragment.replace(/,?\s*"[^"]*$/, '').replace(/,\s*$/, '');
      // Close any open arrays then the root object
      const opens = (fragment.match(/\[/g) || []).length - (fragment.match(/\]/g) || []).length;
      const objs  = (fragment.match(/\{/g) || []).length - (fragment.match(/\}/g) || []).length;
      fragment += ']'.repeat(Math.max(0, opens)) + '}'.repeat(Math.max(0, objs));
      const parsed = JSON.parse(fragment);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
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
  const sampleLines = lines.slice(1, Math.min(6, lines.length));
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
   COLOR / LEGEND COLUMN EXTRACTION
═══════════════════════════════════════════════ */

function _extractColorColFromPrompt(prompt, columns, colTypes) {
  if (!prompt) return null;
  const patterns = [
    /using\s+([\w\s]{2,25}?)\s+(?:in\s+(?:the\s+)?)?(?:the\s+)?legend/i,
    /\bwith\s+([\w\s]{2,25}?)\s+in\s+(?:the\s+)?legend/i,
    /legend\s*[:\-]\s*([\w\s]{2,25}?)(?:\s+to\b|\s+as\b|[,;.]|$)/i,
    /([\w\s]{2,25}?)\s+(?:as|for)\s+(?:the\s+)?legend/i,
    /(?:split|group|color|colour)\s+by\s+([\w\s]{2,25}?)(?:\s+(?:in|for|as)\b|[,;.]|$)/i,
    /\bstacked\s+by\s+([\w\s]{2,25}?)(?:\s*[,;.]|\s+using\b|\s+with\b|\s+in\b|\s*$)/i,   // "stacked by OrderStatus"
    /color[-\s]coded\s+by\s+([\w\s]{2,25}?)(?:[,;.]|$)/i,
    /broken\s+down\s+by\s+([\w\s]{2,25}?)(?:[,;.]|$)/i,
    /display\s+(?:side[\s-]by[\s-]side|grouped)\s+(?:comparisons?\s+)?(?:by\s+|using\s+)?([\w\s]{2,25}?)(?:[,;.]|$)/i,
  ];
  const catCols = columns.filter(c => colTypes[c] !== 'number');
  for (const pat of patterns) {
    const m = pat.exec(prompt);
    if (m) {
      const hint = (m[1] || m[m.length - 1] || '').trim();
      const col  = _findBestCol(hint, catCols, colTypes, false);
      if (col) return col;
    }
  }
  return null;
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
   SANKEY CHART INJECTION
═══════════════════════════════════════════════ */
function _injectSankeyIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bsankey\b/i.test(prompt)) return;
  // IMPORTANT: Do NOT skip when sankey type already exists.
  // Ollama returns type:'sankey' (it's in SYSTEM_PROMPT) but with null y_column.
  // We ALWAYS resolve properly and replace any existing entry.

  // Primary: _goodXCols (low-cardinality non-ID string cols)
  const cats = _goodXCols(columns, colTypes).filter(c => colTypes[c] !== 'date');
  // Wide pool: ALL non-numeric, non-date cols (includes high-cardinality, address, etc.)
  const allStrCols = columns.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date');
  const nums = columns.filter(c => colTypes[c] === 'number' && !/\b(id|no|num|serial|rank|index|row|sr)\b/i.test(c));

  // Parse explicit "from X to Y" in prompt — highest priority
  let srcCol = null, tgtCol = null;
  const fromTo = /\bfrom\s+([\w][\w\s]{1,30}?)\s+to\s+([\w][\w\s]{1,30}?)(?:\s+weight|\s+by|\s+using|\s*weighted|\s*[,;.]|\s*$)/i.exec(prompt);
  if (fromTo) {
    srcCol = _findBestCol(fromTo[1].trim(), allStrCols, colTypes, false)
          || _findBestCol(fromTo[1].trim(), columns,    colTypes, false);
    tgtCol = _findBestCol(fromTo[2].trim(), allStrCols, colTypes, false)
          || _findBestCol(fromTo[2].trim(), columns,    colTypes, false);
    if (srcCol && tgtCol && srcCol === tgtCol) tgtCol = null;
  }
  // Fallback: first two distinct string cols
  if (!srcCol) srcCol = cats[0] || allStrCols[0] || null;
  if (!tgtCol) {
    tgtCol = (cats.length > 1 ? cats.find(c => c !== srcCol) : null)
          || allStrCols.find(c => c !== srcCol)
          || null;
  }

  // Weight / value column — look for "weighted by X" or "by X" after resolving flow cols
  let valCol = null;
  const wtM = /\bweighted?\s+by\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt)
           || /\busing\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  if (wtM) valCol = _findBestCol(wtM[1].trim(), nums,    colTypes, true)
                 || _findBestCol(wtM[1].trim(), columns, colTypes, true);
  if (!valCol) valCol = nums[0] || null;

  // Sankey needs two DIFFERENT string columns
  if (!srcCol || !tgtCol || srcCol === tgtCol) return;

  const spec = {
    id: `sankey1`, title: `${srcCol} → ${tgtCol} Flow`,
    type: 'sankey', x_column: srcCol, y_column: tgtCol,
    _value_column: valCol, aggregation: 'sum', width: 2,
    _category_column: srcCol, _y_column: valCol, _aggregation: 'sum'
  };

  // Replace existing sankey (Ollama's null-column version) or append
  const existingIdx = charts.findIndex(c => c.type === 'sankey');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    spec.id = `sankey${charts.length + 1}`;
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   GANTT CHART INJECTION
═══════════════════════════════════════════════ */
function _injectGanttIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bgantt\b/i.test(prompt)) return;
  // IMPORTANT: Always resolve and replace — Ollama returns type:'gantt' with null columns.

  // Include string-typed columns whose names look like dates (handles format-mismatch detection)
  const dateCols = columns.filter(c =>
    colTypes[c] === 'date' ||
    (colTypes[c] === 'string' && /\b(date|start|end|begin|finish|deadline|due|creat|modif|open|clos|time|period)\b/i.test(c))
  );
  const cats     = columns.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date' && !dateCols.includes(c));

  // Prefer semantically-named task/activity column
  const taskCol = columns.find(c => /\b(task|activity|project|phase|stage|milestone|item)\b/i.test(c))
    || columns.find(c => /\bname\b/i.test(c) && colTypes[c] !== 'number')
    || cats[0] || null;

  // Start date — prefer semantic name
  const startCol = dateCols.find(c => /\b(start|begin|from|open|creat)\b/i.test(c))
    || dateCols[0] || null;

  // End date — different from start
  const endCol = dateCols.find(c => /\b(end|finish|due|close|complet|deadline)\b/i.test(c))
    || dateCols.find(c => c !== startCol) || null;

  // Parse explicit "showing X from Y to Z" in prompt
  const showM = /\bshowing\s+([\w][\w\s]{1,30}?)\s+from\s+([\w][\w\s]{1,30}?)\s+to\s+([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  let pTask = taskCol, pStart = startCol, pEnd = endCol;
  if (showM) {
    pTask  = _findBestCol(showM[1].trim(), columns, colTypes, false) || taskCol;
    pStart = _findBestCol(showM[2].trim(), columns, colTypes, false) || startCol;
    pEnd   = _findBestCol(showM[3].trim(), columns, colTypes, false) || endCol;
  }
  // Parse "X over/by Y" (single date col Gantt)
  if (!pTask) {
    const overM = /\bgantt\b.*?\b([\w][\w\s]{1,25}?)\s+(?:over|by)\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
    if (overM) {
      pTask  = _findBestCol(overM[1].trim(), columns, colTypes, false) || taskCol;
      pStart = _findBestCol(overM[2].trim(), columns, colTypes, false) || startCol;
    }
  }

  if (!pTask) return;

  const spec = {
    id: 'gantt1', title: pStart ? `${pTask} Timeline` : `${pTask} Schedule`,
    type: 'gantt', x_column: pTask, y_column: pStart,
    end_column: pEnd, color_column: cats.find(c => c !== pTask) || null,
    aggregation: 'none', width: 2,
    _category_column: pTask, _y_column: pStart, _aggregation: 'none'
  };

  const existingIdx = charts.findIndex(c => c.type === 'gantt');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    spec.id = `gantt${charts.length + 1}`;
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   BULLET CHART INJECTION
═══════════════════════════════════════════════ */
function _injectBulletIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bbullet\b/i.test(prompt)) return;
  // IMPORTANT: Always resolve and replace — Ollama returns type:'bullet' with null columns.

  const cats = _goodXCols(columns, colTypes);
  const allCats = columns.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date');
  const nums = columns.filter(c => colTypes[c] === 'number' && !/\b(id|no|num|serial|rank|index|row|sr)\b/i.test(c));

  // Actual column — semantic preference
  const actualCol = nums.find(c => /\b(actual|achieved|current|real|ytd|sales|revenue|result|value)\b/i.test(c))
    || nums[0] || null;

  // Target column — semantic preference
  const targetCol = nums.find(c => /\b(target|goal|quota|budget|plan|benchmark|forecast|expect)\b/i.test(c))
    || nums.find(c => c !== actualCol) || null;

  // Parse explicit "actual X vs target Y by Z"
  let pActual = actualCol, pTarget = targetCol, pCat = cats[0] || allCats[0] || null;
  const vsM = /\bactual\s+([\w][\w\s]{1,25}?)\s+vs\s+(?:target\s+)?([\w][\w\s]{1,25}?)(?:\s+by\b|\s*[,;.]|\s*$)/i.exec(prompt);
  if (vsM) {
    pActual = _findBestCol(vsM[1].trim(), nums,    colTypes, true)  || actualCol;
    pTarget = _findBestCol(vsM[2].trim(), nums,    colTypes, true)  || targetCol;
    const byM = /\bby\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
    if (byM) pCat = _findBestCol(byM[1].trim(), allCats, colTypes, false) || pCat;
  }
  // Also parse "X by Y" / "showing X by Y"
  const byM2 = /\bshowing\s+([\w][\w\s]{1,25}?)\s+by\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  if (byM2 && !vsM) {
    pActual = _findBestCol(byM2[1].trim(), nums,    colTypes, true)  || pActual;
    pCat    = _findBestCol(byM2[2].trim(), allCats, colTypes, false) || pCat;
  }

  if (!pActual && !pCat) return;

  const title = pActual && pTarget
    ? `${pActual} vs ${pTarget}`
    : pActual ? `${pActual} Performance` : 'Performance Tracker';

  const spec = {
    id: 'bullet1', title,
    type: 'bullet', x_column: pCat, y_column: pActual,
    target_column: pTarget, aggregation: 'sum', width: 2,
    _category_column: pCat, _y_column: pActual, _aggregation: 'sum'
  };

  const existingIdx = charts.findIndex(c => c.type === 'bullet');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    spec.id = `bullet${charts.length + 1}`;
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   HEATMAP INJECTION
═══════════════════════════════════════════════ */
function _injectHeatmapIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bheatmap\b|\bheat\s*map\b/i.test(prompt)) return;
  // Always resolve and replace — Ollama may return wrong columns for heatmap.

  const nums      = columns.filter(c => colTypes[c] === 'number');
  // All non-numeric columns are candidates (string + date)
  const allNonNum   = columns.filter(c => colTypes[c] !== 'number');
  const dateLikeCols = columns.filter(c =>
    colTypes[c] === 'date' ||
    (colTypes[c] === 'string' && /\b(date|month|year|time|week|day|period)\b/i.test(c))
  );
  // Prefer pure categoricals as x; dates as fallback y
  const cats  = allNonNum.filter(c => !dateLikeCols.includes(c));
  const dates = dateLikeCols;

  // Prefer categorical × categorical, then categorical × date, then any non-num × any non-num
  let xCol = cats[0] || dates[0] || allNonNum[0] || null;
  let yCol = (cats.find(c => c !== xCol)) || (dates.find(c => c !== xCol)) || (allNonNum.find(c => c !== xCol)) || null;

  // Trailing-word lookahead: lets "…vs OrderStatus showing UnitPrice" still capture "OrderStatus"
  // Pattern A: "heatmap [of|chart of] X vs/by Y [showing|with|…]"
  const pA = /\bheatmap\s+(?:of\s+|chart\s+(?:of\s+)?)?([\w][\w\s]{1,25}?)\s+(?:vs|versus|by)\s+([\w][\w\s]{1,25}?)(?=\s+(?:showing|with|using|weighted|for|chart|visual)|\s*[,;.]|\s*$)/i.exec(prompt);
  // Pattern B: "between X and Y" anywhere in a heatmap prompt (handles "heatmap chart between X and Y, with Z as the metric")
  const pB = /\bbetween\s+([\w][\w\s]{1,25}?)\s+and\s+([\w][\w\s]{1,25}?)(?=\s+(?:showing|with|using|weighted|heatmap)|\s*[,;.]|\s*$)/i.exec(prompt);
  // Pattern C: "X vs/by Y heatmap" (column names before the word heatmap)
  const pC = /\b([\w][\w\s]{1,25}?)\s+(?:by|vs|versus)\s+([\w][\w\s]{1,25}?)\s+heatmap/i.exec(prompt);

  const ofM = pA || pB || pC;
  if (ofM) {
    xCol = _findBestCol(ofM[1].trim(), [...cats, ...dates], colTypes, false) || xCol;
    yCol = _findBestCol(ofM[2].trim(), [...cats, ...dates], colTypes, false) || yCol;
    if (xCol && yCol && xCol === yCol) yCol = cats.find(c => c !== xCol) || dates[0] || null;
  }

  if (!xCol || !yCol) return;

  // ── Detect value/metric column from prompt ──────────────────────────────
  // Handles: "showing X", "with X as the metric/measure/value",
  //          "weighted by X", "using X as metric", "X as the value"
  let valCol = null;
  const valM =
    /\bshowing\s+([\w][\w\s]{1,30}?)(?:\s+(?:as\b|by\b|per\b|for\b)|\s*[,;.]|\s*$)/i.exec(prompt) ||
    /\bwith\s+([\w][\w\s]{1,30}?)\s+as\s+(?:the\s+)?(?:metric|measure|value|weight|aggregate)/i.exec(prompt) ||
    /\b(?:metric|measure|value)\s+(?:is\s+|of\s+)?([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s*$)/i.exec(prompt) ||
    /\bweight(?:ed)?\s+by\s+([\w][\w\s]{1,30}?)(?:\s*[,;.]|\s*$)/i.exec(prompt) ||
    /\busing\s+([\w][\w\s]{1,30}?)\s+as\s+(?:the\s+)?(?:metric|measure|value)/i.exec(prompt);
  if (valM) {
    valCol = _findBestCol(valM[1].trim(), nums, colTypes, true) || null;
  }

  // If the prompt didn't state a metric, check whether Ollama already picked a valid numeric column
  if (!valCol) {
    const existingHm = charts.find(c => c.type === 'heatmap');
    const candidate  = existingHm && (existingHm.value_column || existingHm.z_column);
    if (candidate && nums.includes(candidate)) valCol = candidate;
  }

  const aggn  = valCol ? 'sum' : 'count';
  const title = valCol
    ? `${xCol} vs ${yCol} — ${valCol}`
    : `${xCol} vs ${yCol} Heatmap`;

  const spec = {
    id: 'heatmap1',
    title,
    type: 'heatmap',
    x_column: xCol,
    y_column: yCol,
    aggregation: aggn,
    width: 2,
    _category_column: xCol,
    _y_column: yCol,
    _aggregation: aggn
  };
  if (valCol) { spec.value_column = valCol; }

  const existingIdx = charts.findIndex(c => c.type === 'heatmap');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    spec.id = `heatmap${charts.length + 1}`;
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   SUNBURST INJECTION
═══════════════════════════════════════════════ */
function _injectSunburstIfRequested(charts, prompt, columns, colTypes) {
  if (!/\bsunburst\b|\bradial\s+hierarchy\b|\bcircular\s+hierarchy\b/i.test(prompt)) return;
  // Always resolve and replace — Ollama won't know sunburst column rules.

  const cats = _goodXCols(columns, colTypes).filter(c => colTypes[c] !== 'date');
  const allCats = columns.filter(c => colTypes[c] !== 'number' && colTypes[c] !== 'date');
  const nums = columns.filter(c => colTypes[c] === 'number' && !/\b(id|no|num|serial|rank|index|row|sr)\b/i.test(c));

  // Parent = first cat, child = second cat (adds depth to the sunburst)
  let parentCol = cats[0] || allCats[0] || null;
  let childCol  = (cats.length > 1 ? cats.find(c => c !== parentCol) : null)
               || allCats.find(c => c !== parentCol) || null;
  let valCol    = nums[0] || null;

  // Parse "sunburst of X by Y weighted by Z"
  const ofM = /\bsunburst\s+(?:of\s+)?([\w][\w\s]{1,25}?)\s+(?:by|and)\s+([\w][\w\s]{1,25}?)(?:\s+weight|\s+by|\s*[,;.]|\s*$)/i.exec(prompt);
  if (ofM) {
    parentCol = _findBestCol(ofM[1].trim(), allCats, colTypes, false) || parentCol;
    childCol  = _findBestCol(ofM[2].trim(), allCats, colTypes, false) || childCol;
  }
  const wtM = /\bweighted?\s+by\s+([\w][\w\s]{1,25}?)(?:\s*[,;.]|\s*$)/i.exec(prompt);
  if (wtM) valCol = _findBestCol(wtM[1].trim(), nums, colTypes, true) || valCol;

  if (!parentCol) return;

  const title = childCol
    ? `${parentCol} → ${childCol} Sunburst`
    : `${parentCol} Sunburst`;

  const spec = {
    id: 'sunburst1',
    title,
    type: 'sunburst',
    x_column: parentCol,
    y_column: valCol,
    color_column: childCol,
    aggregation: valCol ? 'sum' : 'count',
    width: 2,
    _category_column: parentCol,
    _y_column: valCol,
    _aggregation: valCol ? 'sum' : 'count'
  };

  const existingIdx = charts.findIndex(c => c.type === 'sunburst');
  if (existingIdx >= 0) {
    spec.id = charts[existingIdx].id;
    charts[existingIdx] = spec;
  } else {
    spec.id = `sunburst${charts.length + 1}`;
    charts.push(spec);
  }
}

/* ═══════════════════════════════════════════════
   FAST MULTI-LINE SPEC BUILDER  (zero Ollama calls)
   Resolves each prompt line server-side using the
   same injection chain as the single-line Ollama path.
   For N charts this is N× faster than the old approach
   of firing N parallel Ollama calls.
═══════════════════════════════════════════════ */
function _detectChartType(line) {
  if (/\bkpi\b|\bkpis\b|\bkpi\s+cards?\b|\bscorecard\b|\bmetrics?\s+card\b/i.test(line) &&
      !/\bmulti[-\s]?row\b/i.test(line)) return 'kpi';
  if (/\bmulti[-\s]?row\s+card\b/i.test(line)) return 'multi_row_card';
  if (/\bdata\s*table\b|\btable\s*(?:chart|visual|view)?\b/i.test(line) &&
      !/\bmatrix\b/i.test(line)) return 'table';
  if (/\bmatrix\b/i.test(line)) return 'matrix';
  if (/\bgauge\b/i.test(line)) return 'gauge';
  if (/\bhistogram\b/i.test(line)) return 'histogram';
  if (/\btreemap\b|\btree\s*map\b/i.test(line)) return 'treemap';
  if (/\bwaterfall\b/i.test(line)) return 'waterfall';
  if (/\bfunnel\b/i.test(line)) return 'funnel';
  if (/\bbubble\b/i.test(line)) return 'bubble';
  if (/\bscatter\b/i.test(line)) return 'scatter';
  if (/\bchoropleth\b|\bfilled\s+map\b|\bmap\b/i.test(line)) return 'choropleth';
  if (/\bdonut\b|\bdoughnut\b/i.test(line)) return 'donut';
  if (/\bpie\b/i.test(line)) return 'pie';
  if (/\bcombo\b|\bline\s+and\s+(?:column|bar)\b/i.test(line)) return 'combo';
  if (/\bstacked\s+area\b/i.test(line)) return 'area';
  if (/\barea\b/i.test(line)) return 'area';
  if (/\bstacked\b/i.test(line)) return 'bar';
  if (/\bhorizontal\s+bar\b|\bclustered\s+bar\b|\bbar\b|\bcolumn\b/i.test(line)) return 'bar';
  if (/\bline\b/i.test(line)) return 'line';
  if (/\bsankey\b/i.test(line)) return 'sankey';
  if (/\bgantt\b/i.test(line)) return 'gantt';
  if (/\bbullet\b/i.test(line)) return 'bullet';
  if (/\bheatmap\b|\bheat\s*map\b/i.test(line)) return 'heatmap';
  if (/\bsunburst\b|\bradial\s+hierarchy\b/i.test(line)) return 'sunburst';
  if (/\bhierarchy\s*tree\b|\borg\s*chart\b|\bicicle\b/i.test(line)) return 'icicle';
  if (/\bhierarchy\b/i.test(line)) return 'icicle';
  if (/\bslicer\b/i.test(line)) return 'slicer';
  if (/\bbox\s*(?:and\s*)?whisker\b|\bbox\s*plot\b|\bbox\s*chart\b|\bwhisker\b/i.test(line)) return 'box';
  return 'bar';
}

function _buildMultiLineSpec(promptLines, fullPrompt, columns, colTypes, csvData, fileName) {
  const tableName = fileNameToTableName(fileName);
  const charts    = [];
  const kpi_cards = [];
  const seenF     = new Set();
  const filters   = [];

  for (const [idx, line] of promptLines.entries()) {
    const type = _detectChartType(line);

    /* ── Slicer/filter: populates the filters array, no chart visual ── */
    if (type === 'slicer') {
      _injectSlicerIfRequested(filters, line, columns, colTypes);
      continue;
    }

    /* ── KPI cards ─────────────────────────────────────────────────── */
    if (type === 'kpi') {
      // Strip the "Create KPI cards for / Add KPIs showing" preamble
      const raw = line
        .replace(/^(?:create\s+)?kpi\s+(?:cards?\s+)?(?:for|showing|with|:)?\s*/i, '')
        .replace(/^(?:add\s+)?kpi\s+(?:cards?\s+)?/i, '')
        .trim();
      const titles = raw.split(/\s*,\s*|\s+and\s+/i).map(t => t.trim()).filter(t => t.length > 1);
      if (!titles.length) titles.push(line);
      for (const t of titles) {
        const resolved = titleToKpi(t, columns, colTypes);
        kpi_cards.push({ title: t, ...resolved });
      }
      _injectComparisonKPIs(kpi_cards, line, columns, colTypes);
      continue;
    }

    /* ── Regular chart ─────────────────────────────────────────────── */
    const title = line
      .replace(/^(?:create\s+(?:a\s+)?|add\s+(?:a\s+)?|show\s+(?:a\s+)?|build\s+(?:a\s+)?)/i, '')
      .trim();

    /* ── Special chart types: let injection functions build from scratch ──
       If we seed these types first, the injection guard (charts.find c.type)
       fires and skips column resolution → null x/y → renderer falls back to bar.
       Instead we pass an EMPTY array so injection creates a fully-wired spec.
    ── */
    if (type === 'box') {
      const lineCharts = [];
      _injectBoxIfRequested(lineCharts, line, columns, colTypes);
      if (!lineCharts.length) continue;
      lineCharts[0].id = `c${idx}`;
      charts.push(...lineCharts);
      const lf = _extractFiltersFromPrompt(line, columns, colTypes) || [];
      for (const f of lf) {
        if (f?.column && !seenF.has(f.column)) { seenF.add(f.column); filters.push(f); }
      }
      continue;
    }

    if (type === 'marimekko') {
      const lineCharts = [];
      _injectMarimekkoIfRequested(lineCharts, line, columns, colTypes);
      if (!lineCharts.length) continue;
      lineCharts[0].id = `c${idx}`;
      charts.push(...lineCharts);
      const lf = _extractFiltersFromPrompt(line, columns, colTypes) || [];
      for (const f of lf) {
        if (f?.column && !seenF.has(f.column)) { seenF.add(f.column); filters.push(f); }
      }
      continue;
    }

    if (type === 'sankey' || type === 'gantt' || type === 'bullet' ||
        type === 'heatmap' || type === 'sunburst') {
      const lineCharts = [];
      _injectSankeyIfRequested(lineCharts, line, columns, colTypes);
      _injectGanttIfRequested(lineCharts, line, columns, colTypes);
      _injectBulletIfRequested(lineCharts, line, columns, colTypes);
      _injectHeatmapIfRequested(lineCharts, line, columns, colTypes);
      _injectSunburstIfRequested(lineCharts, line, columns, colTypes);
      if (!lineCharts.length) {
        // Injection couldn't find suitable columns — best-effort bar fallback
        const fb = titleToChart(title, 'bar', idx, columns, colTypes);
        lineCharts.push({ id: `c${idx}`, title, type: 'bar', ...fb, width: 1 });
      }
      charts.push(...lineCharts);
      const lf = _extractFiltersFromPrompt(line, columns, colTypes) || [];
      for (const f of lf) {
        if (f?.column && !seenF.has(f.column)) { seenF.add(f.column); filters.push(f); }
      }
      continue;
    }

    // Seed a base chart entry — injection functions will refine / override it
    let seed;
    if (type === 'table') {
      seed = { id: `c${idx}`, title, type: 'table', x_column: null, y_column: null,
               columns: _extractTableColumns(line, columns), aggregation: 'none', width: 2 };
    } else if (type === 'matrix') {
      const rowCol = columns.find(c => colTypes[c] !== 'number') || columns[0];
      const colCol = columns.find(c => colTypes[c] !== 'number' && c !== rowCol) || null;
      const valCol = columns.find(c => colTypes[c] === 'number') || null;
      seed = { id: `c${idx}`, title, type: 'matrix', x_column: rowCol, y_column: valCol,
               color_column: colCol, aggregation: 'count', width: 2,
               _y_column: valCol, _category_column: rowCol, _aggregation: 'count' };
    } else {
      const resolved = titleToChart(title, type, idx, columns, colTypes);
      seed = { id: `c${idx}`, title, type, ...resolved, width: 1 };
    }

    const lineCharts = [seed];

    // Run the full injection chain using just THIS line as the prompt
    _injectMatrixChart(lineCharts, line, columns, colTypes);
    _injectStackedBarIfRequested(lineCharts, line, columns, colTypes);
    _injectStackedAreaIfRequested(lineCharts, line, columns, colTypes);
    _injectComboIfRequested(lineCharts, line, columns, colTypes);
    _injectWaterfallIfRequested(lineCharts, line, columns, colTypes);
    _injectPieIfRequested(lineCharts, line, columns, colTypes);
    _injectBubbleIfRequested(lineCharts, line, columns, colTypes);
    _injectMapIfRequested(lineCharts, line, columns, colTypes);
    _injectTreemapIfRequested(lineCharts, line, columns, colTypes);
    _injectIcicleIfRequested(lineCharts, line, columns, colTypes);
    _injectHistogramIfRequested(lineCharts, line, columns, colTypes);
    _injectBoxIfRequested(lineCharts, line, columns, colTypes);
    _injectMarimekkoIfRequested(lineCharts, line, columns, colTypes);
    _injectGaugeIfRequested(lineCharts, line, columns, colTypes);
    _injectMultiRowCardIfRequested(lineCharts, line, columns, colTypes);
    _injectBarChartIfRequested(lineCharts, line, columns, colTypes);
    _injectSankeyIfRequested(lineCharts, line, columns, colTypes);
    _injectGanttIfRequested(lineCharts, line, columns, colTypes);
    _injectBulletIfRequested(lineCharts, line, columns, colTypes);
    _injectHeatmapIfRequested(lineCharts, line, columns, colTypes);
    _injectSunburstIfRequested(lineCharts, line, columns, colTypes);

    charts.push(...lineCharts);

    // Collect any explicit filters from this line
    const lf = _extractFiltersFromPrompt(line, columns, colTypes) || [];
    for (const f of lf) {
      if (f?.column && !seenF.has(f.column)) { seenF.add(f.column); filters.push(f); }
    }
  }

  // Auto-filters when prompt contained no explicit filter instructions
  if (filters.length === 0) {
    for (const f of _autoFilters(columns, colTypes)) {
      if (!seenF.has(f.column)) { seenF.add(f.column); filters.push(f); }
    }
  }

  // Renumber IDs sequentially
  charts.forEach((c, i) => { c.id = `chart${i + 1}`; });

  // KPI-only / chart-only guards (mirrors single-line path)
  const _kpiOnly = /\bkpi\s*cards?\b|\bkpis\b|\bkpi\s+visual\b|\bscorecard\b/i.test(fullPrompt) &&
    !/\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s*table\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bmulti[-\s]?row\b|\bslicer\b/i.test(fullPrompt);
  if (_kpiOnly) charts.splice(0);

  const _kpiExplicitly = /\bkpi\b|\bkpis\b|\bmetrics?\s+card\b|\bcard\s+visual\b|\bscorecard\b/i.test(fullPrompt);
  if (!_kpiExplicitly) kpi_cards.splice(0);

  // NL axis correction — ensure time-series charts use a date column
  const _dateCols = columns.filter(c => colTypes[c] === 'date');
  if (_dateCols.length && /\btrend\b|\bover\s+time\b|\bmonthly\b|\bweekly\b|\bdaily\b|\btime\s+series\b/i.test(fullPrompt)) {
    charts.forEach(c => {
      if ((c.type === 'line' || c.type === 'area') && (!c.x_column || colTypes[c.x_column] !== 'date'))
        c.x_column = _dateCols[0];
    });
  }
  // Histogram / box sanity
  charts.forEach(c => {
    if (c.type === 'histogram') { c.aggregation = 'none'; c.y_column = null; }
    if (c.type === 'box') {
      c.aggregation = 'none';
      // y_column must be numeric (the distribution values)
      const numCols = columns.filter(col => colTypes[col] === 'number');
      if (!c.y_column || colTypes[c.y_column] !== 'number') {
        c.y_column = numCols[0] || null;
      }
      // x_column (grouping) must be categorical — if it's numeric, clear it
      if (c.x_column && colTypes[c.x_column] === 'number') {
        const goodX = _goodXCols(columns, colTypes);
        c.x_column = goodX[0] || null;
      }
      c.width = c.x_column ? 2 : 1;
    }
    if (c.type === 'marimekko') {
      c.width = 2;
      const goodX   = _goodXCols(columns, colTypes);
      const numCols = columns.filter(col => colTypes[col] === 'number');
      if (!c.x_column || colTypes[c.x_column] === 'number') c.x_column = goodX[0] || null;
      if (!c.color_column || colTypes[c.color_column] === 'number' || c.color_column === c.x_column)
        c.color_column = goodX.find(col => col !== c.x_column) || null;
      if (c.aggregation === 'count') c.y_column = null;
      else if (c.y_column && colTypes[c.y_column] !== 'number') c.y_column = numCols[0] || null;
    }
  });

  // Enrich with internal _column/_aggregation fields the browser renderer expects
  kpi_cards.forEach(k => {
    k._column = k.column; k._aggregation = k.aggregation;
    if (k.value_column) k._value_column = k.value_column;
  });
  charts.forEach(c => {
    if (!c._y_column)        c._y_column        = c.y_column;
    if (!c._category_column) c._category_column = c.x_column;
    if (!c._aggregation)     c._aggregation     = c.aggregation;
  });

  const dax_measures = buildDaxMeasures(kpi_cards, charts, tableName);
  kpi_cards.forEach(k => { k.measure_name = k.title; });
  charts.forEach(c => { c.measure_name = c.title; c.category_column = c.x_column; });

  return { title: `${fileName} Dashboard`, table_name: tableName,
           kpi_cards, charts, dax_measures, filters };
}

/* ═══════════════════════════════════════════════
   MAIN ENTRY POINT
═══════════════════════════════════════════════ */

async function buildDashboardWithOllama(csvData, columns, colTypes, prompt, fileName) {

  /* ── Multi-line prompt: fast server-side path (zero Ollama calls) ──────────
     When the user submits multiple chart requests (newline-separated) we resolve
     each line entirely server-side — chart type from keywords, columns via the
     same injection chain the single-line path uses after Ollama.
     This replaces the old approach of N parallel Ollama calls which serialised
     inside Ollama and took N× longer.
  ─────────────────────────────────────────────────────────────────────────── */
  const CHART_KW = /\bchart\b|\bgraph\b|\bplot\b|\bvisual\b|\bkpi\b|\bcard\b|\bslicer\b|\bfilter\b|\btable\b|\bmatrix\b|\bmap\b|\bgauge\b|\bdonut\b|\bpie\b|\bbar\b|\bline\b|\barea\b|\bscatter\b|\bfunnel\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bsankey\b|\bgantt\b|\bbullet\b|\bheatmap\b|\bheat\s+map\b|\bsunburst\b|\bhierarchy\b/i;
  const _promptLines = (prompt || '')
    .split(/\n/)
    .map(l => l.replace(/^\s*[-•*\d.)\]]+\s*/, '').trim())
    .filter(l => l.length > 8 && CHART_KW.test(l));

  if (_promptLines.length > 1) {
    return _buildMultiLineSpec(_promptLines, prompt, columns, colTypes, csvData, fileName);
  }
  /* ── Single-line path: one Ollama call ────────────────────────────────── */

  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model     = process.env.OLLAMA_MODEL || 'llama3.2';
  const tableName = fileNameToTableName(fileName);

  // Ask Ollama for TITLES AND TYPES ONLY — no columns, no aggregations
  const colProfile  = buildColumnProfile(columns, colTypes, csvData);
  const userMessage = `Dataset columns:\n${colProfile}\n\nUser requirements: ${prompt}\n\nReturn JSON with dashboard title, kpi titles, and chart titles/types only.`;

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage }
    ],
    stream: true,
    format: 'json',
    options: { temperature: 0.1, num_predict: 4096, num_ctx: 4096 }
  });

  const responseText = await httpPost(ollamaUrl, '/api/chat', payload);
  const data    = JSON.parse(responseText);
  const content = data?.message?.content || '';
  if (!content) throw new Error('Ollama returned empty response. Run: ollama pull ' + model);

  const raw = extractJson(content);
  if (!raw) throw new Error('Could not parse JSON from Ollama response.');

  // Sanitize chart type values — include all types the renderers support
  const validTypes = ['bar','line','area','pie','donut','scatter','funnel','table','matrix',
                      'combo','waterfall','bubble','treemap','histogram','box','marimekko','gauge','heatmap',
                      'choropleth','scattergeo','sankey','gantt','bullet','sunburst'];
  const sanitizeType = v => {
    const s = String(v||'').toLowerCase().replace(/[^a-z]/g,'');
    if (s === 'boxandwhisker' || s === 'boxwhisker' || s === 'boxplot') return 'box';
    if (s === 'mekko' || s === 'mosaic') return 'marimekko';
    return validTypes.includes(s) ? s : 'bar';
  };

  // Detect legend/color column from prompt (for clustered/grouped bar charts)
  const colorColFromPrompt = /\bcluster(?:ed)?\b|\bgrouped\b|\blegend\b|\bsplit\s+by\b|\bcolor\s+by\b/i.test(prompt)
    ? _extractColorColFromPrompt(prompt, columns, colTypes) : null;

  // Build KPIs — resolve columns server-side by title
  const kpi_cards = (raw.kpis || raw.kpi_cards || []).map((k, i) => {
    const title  = String(k.title || `KPI ${i+1}`);
    const resolved = titleToKpi(title, columns, colTypes);
    return { title, ...resolved };
  });

  // Inject comparison/secondary sub-specs from "comparison against X" / "secondary indicator for Y"
  _injectComparisonKPIs(kpi_cards, prompt, columns, colTypes);

  // Build charts — resolve x/y columns server-side by title + index
  const rawCharts = Array.isArray(raw.charts) ? raw.charts : [];
  const _promptLineTypesMain = _chartTypesFromPromptLines(prompt);
  const charts = rawCharts.map((c, i) => {
    try {
      const title = String(c.title || `Chart ${i+1}`);
      const type  = (_promptLineTypesMain[i]) ? _promptLineTypesMain[i] : sanitizeType(c.type);
      if (type === 'table') {
        return { id: `chart${i+1}`, title, type: 'table', x_column: null, y_column: null,
                 columns: _extractTableColumns(prompt, columns), aggregation: 'none', width: 2 };
      }
      if (type === 'matrix') {
        const rowCol = c.x_column     || columns.find(col => colTypes[col] !== 'number') || columns[0];
        const colCol = c.color_column || columns.find(col => colTypes[col] !== 'number' && col !== rowCol) || null;
        const valCol = c.y_column     || columns.find(col => colTypes[col] === 'number') || null;
        const agg    = c.aggregation  || 'count';
        return { id: `chart${i+1}`, title, type: 'matrix',
                 x_column: rowCol, y_column: valCol, color_column: colCol,
                 aggregation: agg, width: 2,
                 _y_column: valCol, _category_column: rowCol, _aggregation: agg };
      }
      const resolved = titleToChart(title, type, i, columns, colTypes);
      const color_column = (type === 'bar' && colorColFromPrompt) ? colorColFromPrompt : null;
      return { id: `chart${i+1}`, title, type, ...resolved, color_column, width: c.width === 2 ? 2 : 1 };
    } catch(e) {
      return null;
    }
  }).filter(Boolean);

  // Inject matrix chart if prompt requests one but Ollama didn't produce it
  _injectMatrixChart(charts, prompt, columns, colTypes);
  // Stacked / 100%-stacked bar or column chart injection
  _injectStackedBarIfRequested(charts, prompt, columns, colTypes);
  // Stacked area chart injection
  _injectStackedAreaIfRequested(charts, prompt, columns, colTypes);
  // Combo (line + bar) chart injection
  _injectComboIfRequested(charts, prompt, columns, colTypes);
  // Waterfall chart injection
  _injectWaterfallIfRequested(charts, prompt, columns, colTypes);
  // Pie / donut chart injection (fixes Ollama returning bar for pie requests)
  _injectPieIfRequested(charts, prompt, columns, colTypes);
  // Bubble chart injection
  _injectBubbleIfRequested(charts, prompt, columns, colTypes);
  // Map (choropleth / scattergeo) injection
  _injectMapIfRequested(charts, prompt, columns, colTypes);
  // Treemap injection
  _injectTreemapIfRequested(charts, prompt, columns, colTypes);
  // Icicle (hierarchy tree / org chart) injection — distinct from treemap
  _injectIcicleIfRequested(charts, prompt, columns, colTypes);
  // Histogram injection
  _injectHistogramIfRequested(charts, prompt, columns, colTypes);
  // Box and whisker plot injection
  _injectBoxIfRequested(charts, prompt, columns, colTypes);
  // Marimekko / mekko / mosaic chart injection
  _injectMarimekkoIfRequested(charts, prompt, columns, colTypes);
  // Gauge / KPI indicator injection
  _injectGaugeIfRequested(charts, prompt, columns, colTypes);
  // Multi-row card → table injection
  _injectMultiRowCardIfRequested(charts, prompt, columns, colTypes);
  // Fix/inject bar chart axis placement when prompt explicitly names axes
  _injectBarChartIfRequested(charts, prompt, columns, colTypes);
  // Special chart types
  _injectSankeyIfRequested(charts, prompt, columns, colTypes);
  _injectGanttIfRequested(charts, prompt, columns, colTypes);
  _injectBulletIfRequested(charts, prompt, columns, colTypes);
  _injectHeatmapIfRequested(charts, prompt, columns, colTypes);
  _injectSunburstIfRequested(charts, prompt, columns, colTypes);

  // Filters — honour explicit user request first, fall back to auto-generation
  const filters = _extractFiltersFromPrompt(prompt, columns, colTypes) || _autoFilters(columns, colTypes);
  // Slicer injection — adds filter entries (must run after filters array is built)
  _injectSlicerIfRequested(filters, prompt, columns, colTypes);

  // ── Special-chart-only cleanup ─────────────────────────────────────────
  // Ollama always returns a bar/generic chart — strip it when only a special
  // chart type was requested so the user sees only the requested chart.
  const _OTHER_CHART_KW = /\bbar\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s*table\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bmulti[-\s]?row\b/i;
  const _sankeyOnly = /\bsankey\b/i.test(prompt) && !_OTHER_CHART_KW.test(prompt) && !/\bgantt\b|\bbullet\b/i.test(prompt);
  if (_sankeyOnly) {
    kpi_cards.splice(0);
    const sc = charts.filter(c => c.type === 'sankey');
    if (sc.length) { charts.splice(0, charts.length, ...sc); filters.splice(0); }
  }
  const _ganttOnly = /\bgantt\b/i.test(prompt) && !_OTHER_CHART_KW.test(prompt) && !/\bsankey\b|\bbullet\b/i.test(prompt);
  if (_ganttOnly) {
    kpi_cards.splice(0);
    const gc = charts.filter(c => c.type === 'gantt');
    if (gc.length) { charts.splice(0, charts.length, ...gc); filters.splice(0); }
  }
  const _bulletOnly = /\bbullet\b/i.test(prompt) && !_OTHER_CHART_KW.test(prompt) && !/\bsankey\b|\bgantt\b/i.test(prompt);
  if (_bulletOnly) {
    kpi_cards.splice(0);
    const bc = charts.filter(c => c.type === 'bullet');
    if (bc.length) { charts.splice(0, charts.length, ...bc); filters.splice(0); }
  }
  const _heatmapOnly = /\bheatmap\b|\bheat\s*map\b/i.test(prompt) && !_OTHER_CHART_KW.test(prompt) && !/\bsankey\b|\bgantt\b|\bbullet\b|\bsunburst\b/i.test(prompt);
  if (_heatmapOnly) {
    kpi_cards.splice(0);
    const hc = charts.filter(c => c.type === 'heatmap');
    if (hc.length) { charts.splice(0, charts.length, ...hc); filters.splice(0); }
  }
  const _sunburstOnly = /\bsunburst\b/i.test(prompt) && !_OTHER_CHART_KW.test(prompt) && !/\bsankey\b|\bgantt\b|\bbullet\b|\bheatmap\b/i.test(prompt);
  if (_sunburstOnly) {
    kpi_cards.splice(0);
    const sbc = charts.filter(c => c.type === 'sunburst');
    if (sbc.length) { charts.splice(0, charts.length, ...sbc); filters.splice(0); }
  }
  const _icicleOnly = /\bhierarchy\s*tree\b|\borg\s*chart\b|\bicicle\b|\bhierarchy\b/i.test(prompt) &&
    !_OTHER_CHART_KW.test(prompt) && !/\bsankey\b|\bgantt\b|\bbullet\b|\bheatmap\b|\bsunburst\b|\btreemap\b/i.test(prompt);
  if (_icicleOnly) {
    kpi_cards.splice(0);
    const ic = charts.filter(c => c.type === 'icicle');
    if (ic.length) { charts.splice(0, charts.length, ...ic); filters.splice(0); }
  }

  // Matrix-only request: strip all Ollama-generated KPI cards, extra charts, and filters
  const _matrixOnly = /\bmatrix\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_matrixOnly) {
    kpi_cards.splice(0);
    const matrixOnly = charts.filter(c => c.type === 'matrix');
    charts.splice(0, charts.length, ...matrixOnly);
    filters.splice(0);
  }

  // Table-only request: user clicked "Data Table" button or typed "data table" with no other chart types.
  // Ollama (tiny model) typically returns a bar chart for table prompts — strip everything and ensure
  // a clean table chart is the only output.
  const _tableOnly = /\bdata\s*table\b|\btable\s*(?:chart|visual|view)\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bslicer\b/i.test(prompt);
  if (_tableOnly) {
    kpi_cards.splice(0);
    const tableCharts = charts.filter(c => c.type === 'table');
    if (tableCharts.length > 0) {
      charts.splice(0, charts.length, ...tableCharts);
    } else {
      // Ollama returned a non-table chart — replace it with a proper table chart
      charts.splice(0, charts.length, {
        id: 'table1', title: 'Data Table', type: 'table',
        x_column: null, y_column: null,
        columns: _extractTableColumns(prompt, columns), aggregation: 'none', width: 2
      });
    }
    filters.splice(0);
  }

  // Bar-chart-only request: strip Ollama-invented extra charts (e.g. unwanted line charts)
  // Triggers on "bar chart" / "horizontal bar" / "clustered bar" (non-stacked, non-combo)
  const _barChartOnly = /\bbar\s+chart\b|\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(prompt) &&
    !/\bstacked\b|\bcombo\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bwaterfall\b|\bbubble\b|\btreemap\b|\bKPI\b|\bcard\b|\bslicer\b/i.test(prompt);
  if (_barChartOnly) {
    const barCharts = charts.filter(c => c.type === 'bar');
    if (barCharts.length > 0) { charts.splice(0, charts.length, ...barCharts); filters.splice(0); }
  }

  // Stacked bar/column-only request (not a stacked combo — combo has its own path)
  const _stackedOnly = /\bstacked\b/i.test(prompt) && !/\bstacked\s+area\b/i.test(prompt) &&
    !/\bcombo\b|\bKPI\b|\bcard\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_stackedOnly) {
    kpi_cards.splice(0);
    const stackedCharts = charts.filter(c => c.type === 'bar' && c.stack_mode);
    charts.splice(0, charts.length, ...stackedCharts);
    filters.splice(0);
  }

  // Stacked area-only request
  const _stackedAreaOnly = /\bstacked\s+area\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_stackedAreaOnly) {
    kpi_cards.splice(0);
    const stackedAreaCharts = charts.filter(c => c.type === 'area' && c.stack_mode);
    charts.splice(0, charts.length, ...stackedAreaCharts);
    filters.splice(0);
  }

  // Advanced single-type-only cleanups (combo / waterfall / bubble / treemap / map / multi-row card / histogram)
  // keepKpis:true → don't strip KPI cards for that chart type (maps benefit from KPI cards showing counts/averages)
  const _advancedTypes = [
    { test: /\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with)\s+line\b/i,  filter: c => c.type === 'combo' },
    { test: /\bwaterfall\b/i,                                      filter: c => c.type === 'waterfall' },
    { test: /\bbubble\b/i,                                         filter: c => c.type === 'bubble' },
    { test: /\btreemap\b|\btree\s*map\b/i,                        filter: c => c.type === 'treemap' },
    { test: /\bhistogram\b|\bfrequency\s+dist(?:ribution)?\b/i,   filter: c => c.type === 'histogram' },
    { test: /\bchoropleth\b|\bfilled[\s\-]?map\b|\bmap\b|\bgeograph/i,
                                                                   filter: c => c.type === 'choropleth' || c.type === 'scattergeo',
                                                                   keepKpis: true },
    { test: /\bmulti[-\s]?row\s+card\b/i,                         filter: c => c.type === 'multi_row_card' },
    { test: /\bgauge\b|\bkpi\s+(?:visual|indicator|gauge)\b|\bspeedometer\b/i,
                                                                   filter: c => c.type === 'gauge',
                                                                   keepKpis: true },
  ];
  // "multi-row card" contains the word "card" which would otherwise make _noExtraTypes false.
  // Treat a dedicated multi-row card prompt as a single-type request (no extra chart types).
  const _isMultiRowCardPrompt = /\bmulti[-\s]?row\s+card\b/i.test(prompt);
  // For combo prompts "stacked"/"clustered" and "line" are part of the combo spec — not separate chart types.
  const _isAnyComboPrompt = /\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with)\s+line\b/i.test(prompt);
  const _noExtraTypes = _isMultiRowCardPrompt
    ? !/\bbar\s+chart\b|\bcolumn\s+chart\b|\bstacked\b|\bline\s+chart\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bwaterfall\b|\btreemap\b|\bmatrix\b|\bcombo\b/i.test(prompt)
    : _isAnyComboPrompt
      // combo prompt: "stacked"/"line" are combo components, not separate chart types
      ? !/\bKPI\b|\bcard\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bfilter\b|\bslicer\b/i.test(prompt)
      : !/\bKPI\b|\bcard\b|\bbar\s+chart\b|\bcolumn\s+chart\b|\bstacked\b|\bline\s+chart\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bfilter\b|\bslicer\b/i.test(prompt);
  for (const adv of _advancedTypes) {
    if (adv.test.test(prompt) && _noExtraTypes) {
      if (!adv.keepKpis) kpi_cards.splice(0);
      const advCharts = charts.filter(adv.filter);
      if (advCharts.length > 0) { charts.splice(0, charts.length, ...advCharts); filters.splice(0); }
      break;
    }
  }

  // Slicer-only request: keep filters, strip KPIs and charts
  const _slicerOnly = /\bslicer\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bbubble\b|\btreemap\b|\bwaterfall\b|\bcombo\b|\bdata\s+table\b|\bmatrix\b/i.test(prompt);
  if (_slicerOnly) {
    kpi_cards.splice(0);
    charts.splice(0);
  }

  // KPI-only request: user asked only for KPI cards — strip all Ollama-invented charts.
  // Triggers when prompt explicitly names KPI cards/KPIs and mentions NO other chart type keywords.
  const _kpiOnly = /\bkpi\s*cards?\b|\bkpis\b|\bkpi\s+visual\b|\bscorecard\b/i.test(prompt) &&
    !/\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s*table\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bmulti[-\s]?row\b|\bslicer\b/i.test(prompt);
  if (_kpiOnly && charts.length > 0) {
    charts.splice(0);
    filters.splice(0);
  }

  // ── General KPI suppression ──────────────────────────────────────────────
  // Ollama frequently injects KPI cards even when the user only asked for a
  // specific chart type.  Strip them unless the prompt explicitly requests
  // KPI cards / metrics cards / scorecards.
  // Note: "multi-row card" and gauge are already handled above (keepKpis/advancedTypes)
  // but we still guard here in case those paths did not fire.
  const _kpiExplicitlyRequested =
    /\bkpi\b|\bkpis\b|\bmetrics?\s+card\b|\bcard\s+visual\b|\bscorecard\b/i.test(prompt);
  if (!_kpiExplicitlyRequested && kpi_cards.length) {
    kpi_cards.splice(0);
  }

  /* ── NL-aware axis correction ──────────────────────────────────────────
     Fix common Ollama mistake: line/area chart uses a categorical x when
     the prompt asks for a time-series trend and a date column is available.
  ───────────────────────────────────────────────────────────────────────── */
  const _dateCols = columns.filter(c => colTypes[c] === 'date');
  const _pLower   = (prompt || '').toLowerCase();
  const _isTrendPrompt = /\btrend\b|\bover\s+time\b|\bby\s+(month|date|week|day|year|quarter)\b|\bmonthly\b|\bweekly\b|\bdaily\b|\btime\s+series\b/.test(_pLower);

  if (_isTrendPrompt && _dateCols.length) {
    charts.forEach(c => {
      if ((c.type === 'line' || c.type === 'area') && c.x_column && colTypes[c.x_column] !== 'date') {
        // Only reassign if x_column is not already a date column
        c.x_column = _dateCols[0];
      }
      // If line chart has no x_column at all, set to first date column
      if ((c.type === 'line' || c.type === 'area') && !c.x_column) {
        c.x_column = _dateCols[0];
      }
    });
  }

  /* ── histogram: x must be numeric, aggregation must be 'none' ── */
  charts.forEach(c => {
    if (c.type === 'histogram') {
      c.aggregation = 'none';
      if (c.x_column && colTypes[c.x_column] !== 'number') {
        c.x_column = columns.filter(col => colTypes[col] === 'number')[0] || c.x_column;
      }
      c.y_column = null;
    }
  });

  // Store resolved _column/_aggregation/_y_column/_category_column for browser
  kpi_cards.forEach(k => {
    k._column = k.column;
    k._aggregation = k.aggregation;
    if (k.value_column) k._value_column = k.value_column;
  });
  charts.forEach(c => {
    if (!c._y_column)        c._y_column        = c.y_column;
    if (!c._category_column) c._category_column = c.x_column;
    if (!c._aggregation)     c._aggregation     = c.aggregation;
  });

  // Generate DAX from resolved columns
  const dax_measures = buildDaxMeasures(kpi_cards, charts, tableName);

  // Set measure_name and category_column for pbit-builder
  kpi_cards.forEach(k => { k.measure_name = k.title; });
  charts.forEach(c => { c.measure_name = c.title; c.category_column = c.x_column; });

  const spec = { title: raw.title || `${fileName} Dashboard`, table_name: tableName, kpi_cards, charts, dax_measures, filters };

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
   PROMPT-LINE → CHART TYPE EXTRACTOR
   Parses each bullet line from the chart-type-card
   UI (e.g. "- Create a line chart showing …") and
   returns the canonical chart type string.
   Used to override whatever type the LLM returned,
   which is often wrong for multi-chart prompts.
═══════════════════════════════════════════════ */

function _typeFromPromptLine(line) {
  const l = line.toLowerCase();
  // Order matters: more-specific patterns first
  if (/\bsankey\b/.test(l))                                         return 'sankey';
  if (/\bgantt\b/.test(l))                                          return 'gantt';
  if (/\bbullet\b/.test(l))                                         return 'bullet';
  if (/\bsunburst\b/.test(l))                                       return 'sunburst';
  if (/\bhierarchy\s*tree\b|\borg\s*chart\b|\bicicle\b|\bhierarchy\b/.test(l)) return 'icicle';
  if (/\btreemap\b|\btree\s*map\b/.test(l))                         return 'treemap';
  if (/\bheatmap\b|\bheat\s*map\b/.test(l))                         return 'heatmap';
  if (/\bchoropleth\b|\bfilled\s*map\b/.test(l))                    return 'choropleth';
  if (/\bmap\s+visual\b|\bscatter\s*geo\b|\bbubble\s*map\b/.test(l)) return 'scattergeo';
  if (/\bgauge\b|\bspeedometer\b|\bkpi\s+(?:visual|indicator)\b/.test(l)) return 'gauge';
  if (/\bmulti[-\s]?row\s+card\b|\bmetrics?\s+card\b/.test(l))     return 'multi_row_card';
  if (/\bmatrix\b|\bcross[-\s]tab\b|\bpivot\b/.test(l))            return 'matrix';
  if (/\bdata\s*table\b|\btable\s+(?:chart|visual)\b/.test(l))     return 'table';
  if (/\bbox\s+(?:and\s+)?whisker\b|\bbox\s*plot\b/.test(l))       return 'box';
  if (/\bmarimekko\b|\bmekko\b|\bmosaic\b/.test(l))                return 'marimekko';
  if (/\bhistogram\b|\bfrequency\s+dist/.test(l))                  return 'histogram';
  if (/\bwaterfall\b/.test(l))                                      return 'waterfall';
  if (/\bfunnel\b/.test(l))                                         return 'funnel';
  if (/\bcombo\b|\bline\s+and\s+(?:stacked|clustered)?\s*(?:bar|column)\b|\b(?:stacked|clustered)?\s*(?:bar|column)\s+and\s+line\b/.test(l)) return 'combo';
  if (/\bbubble\b/.test(l))                                         return 'bubble';
  if (/\bscatter\b/.test(l))                                        return 'scatter';
  if (/\bdonut\b|\bdoughnut\b/.test(l))                             return 'donut';
  if (/\bpie\b/.test(l))                                            return 'pie';
  if (/\bstacked\s+area\b/.test(l))                                 return 'area';
  if (/\barea\b/.test(l))                                           return 'area';
  if (/\bline\b/.test(l))                                           return 'line';
  if (/\bstacked\s+(?:bar|column)\b|100\s*%\s*stacked\b/.test(l))  return 'bar';
  if (/\bhorizontal\s+bar\b|\bclustered\s+bar\b/.test(l))          return 'bar';
  if (/\bbar\b|\bcolumn\b/.test(l))                                 return 'bar';
  return null;
}

/* Extract an ordered list of chart types from multi-line bullet prompts.
   Returns [] when the prompt is free-form (not from the chart-type-card UI). */
function _chartTypesFromPromptLines(prompt) {
  if (!prompt) return [];
  const lines = prompt.split(/\n/).map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  // Only apply when there are 2+ lines (single-line = free-form or single chart)
  if (lines.length < 2) return [];
  const types = lines.map(l => _typeFromPromptLine(l));
  // If fewer than half the lines resolved, this is free-form text — don't override
  const resolved = types.filter(Boolean).length;
  if (resolved < Math.ceil(lines.length / 2)) return [];
  return types; // may contain nulls for non-chart lines (KPI lines etc.)
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

  const validTypes2 = ['bar','line','area','pie','donut','scatter','funnel','table','matrix',
                       'combo','waterfall','bubble','treemap','histogram','box','marimekko','gauge','heatmap',
                       'choropleth','scattergeo','sankey','gantt','bullet','sunburst'];
  const sanitizeType = v => {
    const s = String(v||'').toLowerCase().replace(/[^a-z]/g,'');
    if (s === 'boxandwhisker' || s === 'boxwhisker' || s === 'boxplot') return 'box';
    if (s === 'mekko' || s === 'mosaic') return 'marimekko';
    return validTypes2.includes(s) ? s : 'bar';
  };

  const colorColFromPrompt = /\bcluster(?:ed)?\b|\bgrouped\b|\blegend\b|\bsplit\s+by\b|\bcolor\s+by\b/i.test(prompt)
    ? _extractColorColFromPrompt(prompt, columns, colTypes) : null;

  const kpi_cards = (raw.kpis || raw.kpi_cards || []).map((k, i) => {
    const title    = String(k.title || `KPI ${i+1}`);
    const resolved = titleToKpi(title, columns, colTypes);
    return { title, ...resolved };
  });

  // Inject comparison/secondary sub-specs from "comparison against X" / "secondary indicator for Y"
  _injectComparisonKPIs(kpi_cards, prompt, columns, colTypes);

  const rawCharts2 = Array.isArray(raw.charts) ? raw.charts : [];

  // When the user built the prompt using the chart-type-card UI, each bullet line names
  // an explicit chart type. Extract those types and use them to override whatever the LLM
  // returned — small/fast models (llama-3.1-8b-instant) reliably misassign types for
  // multi-chart prompts, returning "bar" for everything.
  const _promptLineTypes = _chartTypesFromPromptLines(prompt);

  const charts = rawCharts2.map((c, i) => {
    try {
      const title    = String(c.title || `Chart ${i+1}`);
      // Override LLM type with the type parsed directly from the matching prompt line when available
      const type     = (_promptLineTypes[i]) ? _promptLineTypes[i] : sanitizeType(c.type);
      if (type === 'table') {
        return { id: `chart${i+1}`, title, type: 'table', x_column: null, y_column: null,
                 columns: _extractTableColumns(prompt, columns), aggregation: 'none', width: 2 };
      }
      if (type === 'matrix') {
        const rowCol = c.x_column     || columns.find(col => colTypes[col] !== 'number') || columns[0];
        const colCol = c.color_column || columns.find(col => colTypes[col] !== 'number' && col !== rowCol) || null;
        const valCol = c.y_column     || columns.find(col => colTypes[col] === 'number') || null;
        const agg    = c.aggregation  || 'count';
        return { id: `chart${i+1}`, title, type: 'matrix',
                 x_column: rowCol, y_column: valCol, color_column: colCol,
                 aggregation: agg, width: 2,
                 _y_column: valCol, _category_column: rowCol, _aggregation: agg };
      }
      const resolved = titleToChart(title, type, i, columns, colTypes);
      const color_column = (type === 'bar' && colorColFromPrompt) ? colorColFromPrompt : null;
      return { id: `chart${i+1}`, title, type, ...resolved, color_column, width: c.width === 2 ? 2 : 1 };
    } catch(e) {
      return null;
    }
  }).filter(Boolean);

  // Inject matrix chart if prompt requests one but Ollama didn't produce it
  _injectMatrixChart(charts, prompt, columns, colTypes);
  // Stacked / 100%-stacked bar or column chart injection
  _injectStackedBarIfRequested(charts, prompt, columns, colTypes);
  // Stacked area chart injection
  _injectStackedAreaIfRequested(charts, prompt, columns, colTypes);
  // Combo (line + bar) chart injection
  _injectComboIfRequested(charts, prompt, columns, colTypes);
  // Waterfall chart injection
  _injectWaterfallIfRequested(charts, prompt, columns, colTypes);
  // Pie / donut chart injection (fixes Ollama returning bar for pie requests)
  _injectPieIfRequested(charts, prompt, columns, colTypes);
  // Bubble chart injection
  _injectBubbleIfRequested(charts, prompt, columns, colTypes);
  // Map (choropleth / scattergeo) injection
  _injectMapIfRequested(charts, prompt, columns, colTypes);
  // Treemap injection
  _injectTreemapIfRequested(charts, prompt, columns, colTypes);
  // Icicle (hierarchy tree / org chart) injection — distinct from treemap
  _injectIcicleIfRequested(charts, prompt, columns, colTypes);
  // Histogram injection
  _injectHistogramIfRequested(charts, prompt, columns, colTypes);
  // Box and whisker plot injection
  _injectBoxIfRequested(charts, prompt, columns, colTypes);
  // Marimekko / mekko / mosaic chart injection
  _injectMarimekkoIfRequested(charts, prompt, columns, colTypes);
  // Gauge / KPI indicator injection
  _injectGaugeIfRequested(charts, prompt, columns, colTypes);
  // Multi-row card → table injection
  _injectMultiRowCardIfRequested(charts, prompt, columns, colTypes);
  // Fix/inject bar chart axis placement when prompt explicitly names axes
  _injectBarChartIfRequested(charts, prompt, columns, colTypes);
  // Special chart types
  _injectSankeyIfRequested(charts, prompt, columns, colTypes);
  _injectGanttIfRequested(charts, prompt, columns, colTypes);
  _injectBulletIfRequested(charts, prompt, columns, colTypes);
  _injectHeatmapIfRequested(charts, prompt, columns, colTypes);
  _injectSunburstIfRequested(charts, prompt, columns, colTypes);

  // Special-chart-only cleanup (processOllamaContent path)
  const _OTHER_KW2 = /\bbar\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s*table\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bmulti[-\s]?row\b/i;
  if (/\bsankey\b/i.test(prompt) && !_OTHER_KW2.test(prompt) && !/\bgantt\b|\bbullet\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const sc2 = charts.filter(c => c.type === 'sankey');
    if (sc2.length) { charts.splice(0, charts.length, ...sc2); }
  }
  if (/\bgantt\b/i.test(prompt) && !_OTHER_KW2.test(prompt) && !/\bsankey\b|\bbullet\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const gc2 = charts.filter(c => c.type === 'gantt');
    if (gc2.length) { charts.splice(0, charts.length, ...gc2); }
  }
  if (/\bbullet\b/i.test(prompt) && !_OTHER_KW2.test(prompt) && !/\bsankey\b|\bgantt\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const bc2 = charts.filter(c => c.type === 'bullet');
    if (bc2.length) { charts.splice(0, charts.length, ...bc2); }
  }
  if (/\bheatmap\b|\bheat\s*map\b/i.test(prompt) && !_OTHER_KW2.test(prompt) && !/\bsunburst\b|\bsankey\b|\bgantt\b|\bbullet\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const hc2 = charts.filter(c => c.type === 'heatmap');
    if (hc2.length) { charts.splice(0, charts.length, ...hc2); }
  }
  if (/\bsunburst\b/i.test(prompt) && !_OTHER_KW2.test(prompt) && !/\bheatmap\b|\bsankey\b|\bgantt\b|\bbullet\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const sbc2 = charts.filter(c => c.type === 'sunburst');
    if (sbc2.length) { charts.splice(0, charts.length, ...sbc2); }
  }
  if (/\bhierarchy\s*tree\b|\borg\s*chart\b|\bicicle\b|\bhierarchy\b/i.test(prompt) &&
      !_OTHER_KW2.test(prompt) && !/\bsankey\b|\bgantt\b|\bbullet\b|\bheatmap\b|\bsunburst\b|\btreemap\b/i.test(prompt)) {
    kpi_cards.splice(0);
    const ic2 = charts.filter(c => c.type === 'icicle');
    if (ic2.length) { charts.splice(0, charts.length, ...ic2); }
  }

  const filters = _extractFiltersFromPrompt(prompt, columns, colTypes) || _autoFilters(columns, colTypes);
  // Slicer injection — adds filter entries
  _injectSlicerIfRequested(filters, prompt, columns, colTypes);

  // Matrix-only request
  const _matrixOnly2 = /\bmatrix\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_matrixOnly2) {
    kpi_cards.splice(0);
    const matrixOnly2 = charts.filter(c => c.type === 'matrix');
    charts.splice(0, charts.length, ...matrixOnly2);
    filters.splice(0);
  }

  // Table-only request (processOllamaContent path)
  const _tableOnly2 = /\bdata\s*table\b|\btable\s*(?:chart|visual|view)\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bslicer\b/i.test(prompt);
  if (_tableOnly2) {
    kpi_cards.splice(0);
    const tableCharts2 = charts.filter(c => c.type === 'table');
    if (tableCharts2.length > 0) {
      charts.splice(0, charts.length, ...tableCharts2);
    } else {
      charts.splice(0, charts.length, {
        id: 'table1', title: 'Data Table', type: 'table',
        x_column: null, y_column: null,
        columns: _extractTableColumns(prompt, columns), aggregation: 'none', width: 2
      });
    }
    filters.splice(0);
  }

  // Bar-chart-only request (processOllamaContent path)
  const _barChartOnly2 = /\bbar\s+chart\b|\bhorizontal\s+bar\b|\bclustered\s+bar\b/i.test(prompt) &&
    !/\bstacked\b|\bcombo\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bwaterfall\b|\bbubble\b|\btreemap\b|\bKPI\b|\bcard\b|\bslicer\b/i.test(prompt);
  if (_barChartOnly2) {
    const barCharts2 = charts.filter(c => c.type === 'bar');
    if (barCharts2.length > 0) { charts.splice(0, charts.length, ...barCharts2); filters.splice(0); }
  }

  // Stacked bar/column-only request (not a stacked combo — combo has its own path)
  const _stackedOnly2 = /\bstacked\b/i.test(prompt) && !/\bstacked\s+area\b/i.test(prompt) &&
    !/\bcombo\b|\bKPI\b|\bcard\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_stackedOnly2) {
    kpi_cards.splice(0);
    const stackedCharts2 = charts.filter(c => c.type === 'bar' && c.stack_mode);
    charts.splice(0, charts.length, ...stackedCharts2);
    filters.splice(0);
  }

  // Stacked area-only request
  const _stackedAreaOnly2 = /\bstacked\s+area\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s+table\b|\bmatrix\b|\bfilter\b|\bslicer\b/i.test(prompt);
  if (_stackedAreaOnly2) {
    kpi_cards.splice(0);
    const stackedAreaCharts2 = charts.filter(c => c.type === 'area' && c.stack_mode);
    charts.splice(0, charts.length, ...stackedAreaCharts2);
    filters.splice(0);
  }

  // Advanced single-type-only cleanups
  const _advancedTypes2 = [
    { test: /\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with)\s+line\b/i,  filter: c => c.type === 'combo' },
    { test: /\bwaterfall\b/i,                                      filter: c => c.type === 'waterfall' },
    { test: /\bbubble\b/i,                                         filter: c => c.type === 'bubble' },
    { test: /\btreemap\b|\btree\s*map\b/i,                        filter: c => c.type === 'treemap' },
    { test: /\bhistogram\b|\bfrequency\s+dist(?:ribution)?\b/i,   filter: c => c.type === 'histogram' },
    { test: /\bchoropleth\b|\bfilled[\s\-]?map\b|\bmap\b|\bgeograph/i,
                                                                   filter: c => c.type === 'choropleth' || c.type === 'scattergeo',
                                                                   keepKpis: true },
    { test: /\bmulti[-\s]?row\s+card\b/i,                         filter: c => c.type === 'multi_row_card' },
    { test: /\bgauge\b|\bkpi\s+(?:visual|indicator|gauge)\b|\bspeedometer\b/i,
                                                                   filter: c => c.type === 'gauge',
                                                                   keepKpis: true },
  ];
  const _isMultiRowCardPrompt2 = /\bmulti[-\s]?row\s+card\b/i.test(prompt);
  const _isAnyComboPrompt2 = /\bcombo\b|\bline\s+(?:and|&|plus)\s+(?:stacked\s+|clustered\s+)?(?:bar|column)\b|\b(?:stacked\s+|clustered\s+)?(?:bar|column)\s+(?:and|&|plus|with)\s+line\b/i.test(prompt);
  const _noExtraTypes2 = _isMultiRowCardPrompt2
    ? !/\bbar\s+chart\b|\bcolumn\s+chart\b|\bstacked\b|\bline\s+chart\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bwaterfall\b|\btreemap\b|\bmatrix\b|\bcombo\b/i.test(prompt)
    : _isAnyComboPrompt2
      ? !/\bKPI\b|\bcard\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bfilter\b|\bslicer\b/i.test(prompt)
      : !/\bKPI\b|\bcard\b|\bbar\s+chart\b|\bcolumn\s+chart\b|\bstacked\b|\bline\s+chart\b|\bpie\b|\bdonut\b|\barea\s+chart\b|\bscatter\b|\bfunnel\b|\bfilter\b|\bslicer\b/i.test(prompt);
  for (const adv of _advancedTypes2) {
    if (adv.test.test(prompt) && _noExtraTypes2) {
      if (!adv.keepKpis) kpi_cards.splice(0);
      const advCharts2 = charts.filter(adv.filter);
      if (advCharts2.length > 0) { charts.splice(0, charts.length, ...advCharts2); filters.splice(0); }
      break;
    }
  }

  // Slicer-only request
  const _slicerOnly2 = /\bslicer\b/i.test(prompt) &&
    !/\bKPI\b|\bcard\b|\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bbubble\b|\btreemap\b|\bwaterfall\b|\bcombo\b|\bdata\s+table\b|\bmatrix\b/i.test(prompt);
  if (_slicerOnly2) {
    kpi_cards.splice(0);
    charts.splice(0);
  }

  // KPI-only request (processOllamaContent path)
  const _kpiOnly2 = /\bkpi\s*cards?\b|\bkpis\b|\bkpi\s+visual\b|\bscorecard\b/i.test(prompt) &&
    !/\bbar\b|\bcolumn\b|\bline\b|\bpie\b|\bdonut\b|\barea\b|\bscatter\b|\bfunnel\b|\bgauge\b|\bdata\s*table\b|\bmatrix\b|\bwaterfall\b|\btreemap\b|\bbubble\b|\bhistogram\b|\bcombo\b|\bmulti[-\s]?row\b|\bslicer\b/i.test(prompt);
  if (_kpiOnly2 && charts.length > 0) {
    charts.splice(0);
    filters.splice(0);
  }

  // ── General KPI suppression (processOllamaContent path) ─────────────────
  const _kpiExplicitlyRequested2 =
    /\bkpi\b|\bkpis\b|\bmetrics?\s+card\b|\bcard\s+visual\b|\bscorecard\b/i.test(prompt);
  if (!_kpiExplicitlyRequested2 && kpi_cards.length) {
    kpi_cards.splice(0);
  }

  /* ── NL-aware axis correction (processOllamaContent path) ── */
  const _dateCols2    = columns.filter(c => colTypes[c] === 'date');
  const _pLower2      = (prompt || '').toLowerCase();
  const _isTrendPmt2  = /\btrend\b|\bover\s+time\b|\bby\s+(month|date|week|day|year|quarter)\b|\bmonthly\b|\bweekly\b|\bdaily\b|\btime\s+series\b/.test(_pLower2);
  if (_isTrendPmt2 && _dateCols2.length) {
    charts.forEach(c => {
      if ((c.type === 'line' || c.type === 'area') && (!c.x_column || colTypes[c.x_column] !== 'date')) {
        c.x_column = _dateCols2[0];
      }
    });
  }
  charts.forEach(c => {
    if (c.type === 'histogram') { c.aggregation = 'none'; c.y_column = null;
      if (c.x_column && colTypes[c.x_column] !== 'number')
        c.x_column = columns.filter(col => colTypes[col] === 'number')[0] || c.x_column;
    }
  });

  kpi_cards.forEach(k => {
    k._column       = k.column;
    k._aggregation  = k.aggregation;
    if (k.value_column) k._value_column = k.value_column;
  });
  charts.forEach(c => {
    if (!c._y_column)        c._y_column        = c.y_column;
    if (!c._category_column) c._category_column = c.x_column;
    if (!c._aggregation)     c._aggregation     = c.aggregation;
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

  return spec;
}

module.exports = { buildDashboardWithOllama, processOllamaContent, checkOllamaHealth, buildColumnProfile, SYSTEM_PROMPT };
