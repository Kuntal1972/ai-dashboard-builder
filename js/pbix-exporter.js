/**
 * pbix-exporter.js — Export current dashboard as a Power BI Template (.pbit)
 * Opens in Power BI Desktop; click Refresh Data to populate.
 * Uses JSZip (loaded lazily from CDN).
 */

/* ════════════════════════════
   ENTRY POINT
   ════════════════════════════ */

async function exportAsPBIX() {
  if (!AppState.currentSpec) { toast('Build a dashboard first.', 'error'); return; }
  if (!AppState.rawData)     { toast('No data loaded.', 'error'); return; }

  showLoading('Generating PBIX…', 'Building Power BI template');

  try {
    if (typeof JSZip === 'undefined') {
      await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }

    const spec     = AppState.currentSpec;
    const cols     = AppState.columns;
    const colTypes = AppState.colTypes;
    const data     = AppState.rawData.slice(0, 50000); // cap to keep file size manageable

    const zip = new JSZip();

    zip.file('[Content_Types].xml', _contentTypes());
    zip.file('Version',             '2.0');
    zip.file('Metadata',            JSON.stringify({ version: '3.0' }));
    zip.file('SecurityBindings',    new Uint8Array(0));
    zip.file('DataModelSchema',     JSON.stringify(_dataModelSchema(cols, colTypes)));

    /* Mashup is itself a ZIP (Power Query package) */
    const mzip = new JSZip();
    _fillMashup(mzip, data, cols, colTypes);
    zip.file('Mashup', await mzip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));

    zip.file('Report/Layout',            JSON.stringify(_reportLayout(spec)));
    zip.file('Report/_rels/Layout.rels', _layoutRels());

    const blob  = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const fname = _safe(spec.title || 'dashboard') + '.pbit';
    _download(blob, fname);

    const note = data.length < AppState.rawData.length
      ? ` (first ${data.length.toLocaleString()} of ${AppState.rawData.length.toLocaleString()} rows)`
      : '';
    toast(`Downloaded "${fname}"${note} — open in Power BI Desktop and click Refresh ✓`, 'success');

  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
    console.error('PBIX export error:', err);
  } finally {
    hideLoading();
  }
}

/* ════════════════════════════
   PACKAGE STRUCTURE
   ════════════════════════════ */

function _contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/Version" ContentType="application/octet-stream"/>
  <Override PartName="/Metadata" ContentType="application/octet-stream"/>
  <Override PartName="/DataModelSchema" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/Report/Layout" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/SecurityBindings" ContentType="application/octet-stream"/>
  <Override PartName="/Mashup" ContentType="application/octet-stream"/>
</Types>`;
}

function _layoutRels() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
}

/* ════════════════════════════
   DATA MODEL SCHEMA
   ════════════════════════════ */

function _dataModelSchema(cols, colTypes) {
  return {
    name: 'Model',
    defaultPowerBIDataSourceVersion: 'powerBI_V3',
    tables: [{
      name: 'Dashboard Data',
      columns: cols.map(c => ({
        name: c,
        dataType:    colTypes[c] === 'number' ? 'double'
                   : colTypes[c] === 'date'   ? 'dateTime'
                   :                            'string',
        sourceColumn: c,
        summarizeBy: colTypes[c] === 'number' ? 'sum' : 'none'
      })),
      partitions: [{
        name:     'Partition',
        dataView: 'full',
        source:   { type: 'm', expression: 'Dashboard Data' }
      }]
    }],
    relationships: [],
    annotations: [{ name: 'PBI_QueryOrder', value: '["Dashboard Data"]' }]
  };
}

/* ════════════════════════════
   MASHUP (POWER QUERY)
   ════════════════════════════ */

function _fillMashup(mzip, data, cols, colTypes) {
  mzip.file('[Content_Types].xml', `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/Package/Formulas/Section1.m" ContentType="application/vnd.ms-pkgm.formula; charset=utf-8"/>
  <Override PartName="/Package/Metadata/metadata.json" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/Package/QueryGroups/queryGroups.json" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/Package/QueryMetadata/queryMetadata.json" ContentType="application/json; charset=utf-8"/>
</Types>`);

  mzip.file('Package/Formulas/Section1.m', _mFormula(data, cols, colTypes));
  mzip.file('Package/Metadata/metadata.json', JSON.stringify({ version: '2.1' }));
  mzip.file('Package/QueryGroups/queryGroups.json', '[]');
  mzip.file('Package/QueryMetadata/queryMetadata.json', JSON.stringify({
    SavedQueries: [{
      Id: '0',
      Name: 'Dashboard Data',
      ResultType: 'Table',
      QueryGroupId: null,
      LoadEnabled: true
    }]
  }));
}

function _mFormula(data, cols, colTypes) {
  /* Build CSV, UTF-8 encode, base64 — avoids all string-escaping issues in M */
  const lines = [cols.map(_csvEsc).join(',')];
  data.forEach(r => lines.push(cols.map(c => _csvEsc(r[c] ?? '')).join(',')));
  const csvText = lines.join('\r\n');

  /* Chunked base64 to avoid call-stack overflow on large payloads */
  const bytes  = new TextEncoder().encode(csvText);
  const chunk  = 8192;
  let   binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);

  const typeList = cols.map(c => {
    const t = colTypes[c] === 'number' ? 'type number'
            : colTypes[c] === 'date'   ? 'type datetime'
            :                            'type text';
    return `{${_mStr(c)}, ${t}}`;
  }).join(', ');

  return `section Section1;

shared #"Dashboard Data" = let
    b64    = "${b64}",
    bytes  = Binary.FromText(b64, BinaryEncoding.Base64),
    Source = Csv.Document(bytes, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),
    #"Changed Types"    = Table.TransformColumnTypes(#"Promoted Headers", {${typeList}})
in
    #"Changed Types";
`;
}

/* ════════════════════════════
   REPORT LAYOUT
   ════════════════════════════ */

function _reportLayout(spec) {
  const PAGE_W   = 1280;
  const MARGIN   = 18;
  const CARD_W   = 196, CARD_H  = 90,  CARD_GAP = 12;
  const CHART_H  = 280, CHART_GAP = 14;

  const kpis   = (spec.kpi_cards || []).filter(k => k.column || k.aggregation === 'count');
  const charts = spec.charts || [];

  const containers = [];
  let vcId = 1;

  /* ── KPI card row ── */
  const cardRowW  = kpis.length * CARD_W + (kpis.length - 1) * CARD_GAP;
  const cardStartX = Math.max(MARGIN, Math.floor((PAGE_W - cardRowW) / 2));
  const cardY     = MARGIN;

  kpis.forEach((kpi, i) => {
    const x = cardStartX + i * (CARD_W + CARD_GAP);
    containers.push(_cardVC(vcId++, x, cardY, CARD_W, CARD_H, kpi));
  });

  /* ── Charts ── */
  let cy = kpis.length ? cardY + CARD_H + MARGIN + 8 : MARGIN;
  let cx = MARGIN;
  const halfW = Math.floor((PAGE_W - 2 * MARGIN - CHART_GAP) / 2);

  charts.forEach(chart => {
    const wide = chart.width === 2;
    const cw   = wide ? PAGE_W - 2 * MARGIN : halfW;

    /* Wrap to next row if half-width chart doesn't fit */
    if (!wide && cx + cw > PAGE_W - MARGIN + 4) {
      cx  = MARGIN;
      cy += CHART_H + CHART_GAP;
    }

    containers.push(_chartVC(vcId++, cx, cy, cw, CHART_H, chart));

    if (wide) {
      cx  = MARGIN;
      cy += CHART_H + CHART_GAP;
    } else {
      cx += cw + CHART_GAP;
    }
  });

  const pageH = cy + CHART_H + MARGIN;

  return {
    id: 0,
    sections: [{
      id: 0,
      name: 'ReportSection',
      displayName: spec.title || 'Dashboard',
      filters: '[]',
      ordinal: 0,
      visualContainers: containers,
      config: JSON.stringify({ relationships: [] }),
      height: Math.max(720, pageH),
      width:  PAGE_W
    }],
    config:  JSON.stringify({ version: '5.47', themeCollection: {} }),
    filters: '[]'
  };
}

/* ── KPI card visual container ── */
function _cardVC(id, x, y, w, h, kpi) {
  const col    = kpi.column || AppState.columns[0] || 'value';
  const fn     = _aggFn(kpi.aggregation);
  const qname  = `${_aggLabel(kpi.aggregation)}(Dashboard Data.${col})`;
  const isCount = kpi.aggregation === 'count' || kpi.aggregation === 'count_distinct';

  const select = isCount
    ? [{
        Aggregation: {
          Expression: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: col } },
          Function: fn
        },
        Name: qname
      }]
    : [{
        Aggregation: {
          Expression: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: col } },
          Function: fn
        },
        Name: qname
      }];

  const protoQ = {
    Version: 2,
    From:    [{ Name: 'd', Entity: 'Dashboard Data', Type: 0 }],
    Select:  select
  };

  const cfg = {
    name: `vc${id}`,
    layouts: [{ id: 0, position: { x, y, z: id * 1000, width: w, height: h, displayState: { mode: 0 } } }],
    singleVisual: {
      visualType: 'card',
      projections: { Values: [{ queryRef: qname, active: false }] },
      prototypeQuery: protoQ,
      vcObjects: {
        title: [{ properties: {
          show:      { expr: { Literal: { Value: 'true' } } },
          titleText: { expr: { Literal: { Value: `'${_esc(kpi.title || col)}'` } } }
        }}]
      }
    }
  };

  return { x, y, z: 0, width: w, height: h, config: JSON.stringify(cfg), filters: '[]', query: JSON.stringify(protoQ), dataTransforms: '[]' };
}

/* ── Chart visual container ── */
function _chartVC(id, x, y, w, h, chart) {
  const xCol   = chart.x_column || '';
  const yCol   = chart.y_column || xCol;
  const isH    = chart.orientation === 'h';
  const vtype  = _pbiType(chart.type, isH);
  const fn     = _aggFn(chart.aggregation || 'sum');
  const catRef = `Dashboard Data.${xCol}`;
  const valRef = `${_aggLabel(chart.aggregation || 'sum')}(Dashboard Data.${yCol})`;

  const protoQ = {
    Version: 2,
    From:    [{ Name: 'd', Entity: 'Dashboard Data', Type: 0 }],
    Select:  [
      { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: xCol }, Name: catRef },
      {
        Aggregation: {
          Expression: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: yCol } },
          Function: fn
        },
        Name: valRef
      }
    ]
  };

  const projKey = _projKey(chart.type);
  const cfg = {
    name: `vc${id}`,
    layouts: [{ id: 0, position: { x, y, z: id * 1000, width: w, height: h, displayState: { mode: 0 } } }],
    singleVisual: {
      visualType: vtype,
      projections: {
        Category: [{ queryRef: catRef, active: false }],
        [projKey]: [{ queryRef: valRef, active: false }]
      },
      prototypeQuery: protoQ,
      vcObjects: {
        title: [{ properties: {
          show:      { expr: { Literal: { Value: 'true' } } },
          titleText: { expr: { Literal: { Value: `'${_esc(chart.title || '')}'` } } }
        }}]
      }
    }
  };

  return { x, y, z: 0, width: w, height: h, config: JSON.stringify(cfg), filters: '[]', query: JSON.stringify(protoQ), dataTransforms: '[]' };
}

/* ════════════════════════════
   MAPPING TABLES
   ════════════════════════════ */

function _pbiType(type, horizontal) {
  if ((type === 'bar' || type === 'histogram') && horizontal) return 'clusteredBarChart';
  const map = {
    bar:       'clusteredColumnChart',
    line:      'lineChart',
    area:      'areaChart',
    scatter:   'scatterChart',
    pie:       'pieChart',
    donut:     'donutChart',
    treemap:   'treemap',
    funnel:    'funnel',
    histogram: 'clusteredColumnChart',
    box:       'boxWhiskerChart',
    heatmap:   'tableEx'
  };
  return map[type] || 'clusteredColumnChart';
}

function _projKey(type) {
  if (type === 'treemap') return 'Values';
  return 'Y';
}

function _aggFn(agg) {
  const m = { sum: 0, avg: 1, mean: 1, min: 2, max: 3, count: 4, count_distinct: 5 };
  return m[agg] ?? 0;
}

function _aggLabel(agg) {
  const m = { sum: 'Sum', avg: 'Average', mean: 'Average', min: 'Min', max: 'Max', count: 'Count', count_distinct: 'DistinctCount' };
  return m[agg] ?? 'Sum';
}

/* ════════════════════════════
   UTILITIES
   ════════════════════════════ */

function _mStr(v)   { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }
function _csvEsc(v) {
  const s = String(v ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function _esc(v)    { return String(v ?? '').replace(/'/g, "\\'"); }
function _safe(s)   { return s.replace(/[^a-zA-Z0-9 _\-]/g, '_').trim() || 'dashboard'; }

function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s  = document.createElement('script');
    s.src    = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}
