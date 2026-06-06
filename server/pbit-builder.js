/**
 * pbit-builder.js
 * Generates a valid .pbit (Power BI Template) ZIP file from a dashboard spec + CSV data.
 */

const JSZip = require('jszip');
const crypto = require('crypto');

/* ════════════════════════════════════════════
   ENTRY POINT
   ════════════════════════════════════════════ */

async function generatePbit(spec, csvData, columns, colTypes, fileName) {
  const tableName = spec.table_name || fileNameToTableName(fileName);
  const reportId  = crypto.randomUUID ? crypto.randomUUID() : generateUUID();

  const zip = new JSZip();

  zip.file('[Content_Types].xml', buildContentTypes());
  zip.file('_rels/.rels',        buildRootRels());
  zip.file('Version',            '2.137.1500.0');
  zip.file('SecurityBindings',   Buffer.alloc(0));
  zip.file('Metadata',           JSON.stringify(buildMetadata(reportId)));
  zip.file('DataModelSchema',    JSON.stringify(buildDataModelSchema(spec, tableName, columns, colTypes, csvData)));

  // Mashup is a nested ZIP
  const mashupZip = new JSZip();
  buildMashupZip(mashupZip, spec, tableName, csvData, columns, colTypes);
  const mashupBytes = await mashupZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  zip.file('Mashup', mashupBytes);

  zip.file('Report/Layout',            JSON.stringify(buildReportLayout(spec, tableName)));
  zip.file('Report/_rels/Layout.rels', buildLayoutRels());

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return buffer;
}

/* ════════════════════════════════════════════
   CONTENT TYPES
   ════════════════════════════════════════════ */

function buildContentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Override PartName="/DataModelSchema" ContentType="application/json" />
  <Override PartName="/Report/Layout" ContentType="application/json" />
  <Override PartName="/Version" ContentType="application/octet-stream" />
  <Override PartName="/Metadata" ContentType="application/json" />
  <Override PartName="/SecurityBindings" ContentType="application/octet-stream" />
  <Override PartName="/Mashup" ContentType="application/octet-stream" />
</Types>`;
}

function buildRootRels() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/Report/Layout" Id="rId1" />
</Relationships>`;
}

function buildLayoutRels() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
}

/* ════════════════════════════════════════════
   METADATA
   ════════════════════════════════════════════ */

function buildMetadata(reportId) {
  return {
    version: '4.0',
    createdFrom: 'D',
    sku: 'Developer',
    defLocale: 'en-US',
    reportId: reportId,
    pbiFormatVersion: '2.137.1500.0'
  };
}

/* ════════════════════════════════════════════
   DATA MODEL SCHEMA (TMSL)
   ════════════════════════════════════════════ */

function buildDataModelSchema(spec, tableName, columns, colTypes, csvData) {
  const cols = columns.map(c => buildColumn(c, colTypes[c] || 'string'));
  const measures = (spec.dax_measures || []).map(m => buildMeasure(m));
  const mCode = buildMCode(tableName, csvData, columns, colTypes);

  return {
    name: 'Model',
    defaultPowerBIDataSourceVersion: 'powerBI_V3',
    culture: 'en-US',
    dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true },
    model: {
      culture: 'en-US',
      tables: [
        {
          name: tableName,
          columns: cols,
          measures: measures,
          partitions: [
            {
              name: 'Partition',
              dataView: 'full',
              source: {
                type: 'm',
                expression: mCode
              }
            }
          ],
          annotations: [{ name: 'PBI_ResultType', value: 'Table' }]
        }
      ],
      relationships: [],
      cultures: [
        {
          name: 'en-US',
          linguisticMetadata: { Version: '1.0.0', Language: 'en-US' }
        }
      ],
      annotations: [
        { name: 'PBIDesktopVersion', value: '2.137.1500.0 (24.11)' },
        { name: 'PBI_QueryOrder', value: JSON.stringify([tableName]) }
      ]
    }
  };
}

function buildColumn(name, type) {
  const col = {
    name: name,
    dataType: type === 'number' ? 'double' : type === 'date' ? 'dateTime' : 'string',
    sourceColumn: name,
    summarizeBy: type === 'number' ? 'sum' : 'none'
  };
  if (type === 'date') {
    col.annotations = [{ name: 'UnderlyingDateTimeDataType', value: 'Date' }];
  }
  return col;
}

function buildMeasure(m) {
  const measure = {
    name: m.name,
    expression: m.expression,
    formatString: m.format_string || '#,0'
  };
  // Add currency annotation for $ formats
  if (m.format_string && m.format_string.includes('$')) {
    measure.annotations = [{ name: 'PBI_FormatHint', value: '{"currencyCulture":"en-US"}' }];
  }
  if (m.description) measure.description = m.description;
  return measure;
}

/* ════════════════════════════════════════════
   POWER QUERY M CODE
   ════════════════════════════════════════════ */

function buildMCode(tableName, csvData, columns, colTypes) {
  const b64 = toBase64(csvData);

  const typeList = columns.map(c => {
    const t = colTypes[c] === 'number' ? 'type number'
            : colTypes[c] === 'date'   ? 'type datetime'
            :                            'type text';
    return `{${mStr(c)}, ${t}}`;
  }).join(', ');

  return [
    'let',
    `    Source = Csv.Document(Binary.FromText("${b64}", BinaryEncoding.Base64), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.None]),`,
    '    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),',
    `    Typed = Table.TransformColumnTypes(Headers, {${typeList}})`,
    'in',
    '    Typed'
  ].join('\n');
}

/* ════════════════════════════════════════════
   MASHUP ZIP
   ════════════════════════════════════════════ */

function buildMashupZip(mzip, spec, tableName, csvData, columns, colTypes) {
  mzip.file('[Content_Types].xml', `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/Package/Formulas/Section1.m" ContentType="application/vnd.ms-pkgm.formula; charset=utf-8"/>
  <Override PartName="/Package/Metadata/metadata.json" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/Package/QueryGroups/queryGroups.json" ContentType="application/json; charset=utf-8"/>
  <Override PartName="/Package/QueryMetadata/queryMetadata.json" ContentType="application/json; charset=utf-8"/>
</Types>`);

  mzip.file('Package/Formulas/Section1.m', buildSection1M(tableName, csvData, columns, colTypes));
  mzip.file('Package/Metadata/metadata.json', JSON.stringify({ version: '2.1' }));
  mzip.file('Package/QueryGroups/queryGroups.json', '[]');
  mzip.file('Package/QueryMetadata/queryMetadata.json', JSON.stringify({
    SavedQueries: [{
      Id: '0',
      Name: tableName,
      ResultType: 'Table',
      QueryGroupId: null,
      LoadEnabled: true
    }]
  }));
}

function buildSection1M(tableName, csvData, columns, colTypes) {
  const b64 = toBase64(csvData);
  const typeList = columns.map(c => {
    const t = colTypes[c] === 'number' ? 'type number'
            : colTypes[c] === 'date'   ? 'type datetime'
            :                            'type text';
    return `        {${mStr(c)}, ${t}}`;
  }).join(',\n');

  // Escape table name for M identifier
  const mTableId = tableName.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/) ? tableName : `#"${tableName}"`;

  return `section Section1;

shared ${mTableId} = let
    Source = Csv.Document(
        Binary.FromText("${b64}", BinaryEncoding.Base64),
        [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.None]
    ),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    Typed = Table.TransformColumnTypes(Headers, {
${typeList}
    })
in
    Typed;
`;
}

/* ════════════════════════════════════════════
   REPORT LAYOUT
   ════════════════════════════════════════════ */

const PAGE_W  = 1280;
const MARGIN  = 20;
const CARD_H  = 110;
const CARD_Y  = 20;
const CHART_H = 280;
const CHART_START_Y = 150;  // below KPI row
const CHART_GAP = 20;

function buildReportLayout(spec, tableName) {
  const kpis   = spec.kpi_cards || [];
  const charts = spec.charts    || [];

  const containers = [];
  let tabOrder = 1;

  // ── KPI cards row ──
  if (kpis.length > 0) {
    const cardCount = Math.min(kpis.length, 6);
    const cardW = Math.floor((PAGE_W - MARGIN * 2 - (cardCount - 1) * 10) / cardCount);
    kpis.slice(0, cardCount).forEach((kpi, i) => {
      const x = MARGIN + i * (cardW + 10);
      const pos = { x, y: CARD_Y, z: 0, width: cardW, height: CARD_H };
      containers.push(makeCardVisual(tableName, kpi.measure_name, kpi.title, pos, tabOrder++));
    });
  }

  // ── Charts ──
  let cy = CHART_START_Y;
  let cx = MARGIN;
  const halfW = Math.floor((PAGE_W - MARGIN * 2 - CHART_GAP) / 2);

  charts.forEach(chart => {
    const wide = chart.width === 2;
    const cw   = wide ? PAGE_W - MARGIN * 2 : halfW;

    if (!wide && cx > MARGIN) {
      // Second chart in row — place to the right
      // (cx is already set to MARGIN + halfW + gap from previous iteration)
    } else if (!wide && cx === MARGIN) {
      // First chart in row, leave cx as-is
    }

    // Support both PBI-builder style (measure_name/category_column) and
    // Ollama-agent style (y_column/x_column) — fall back gracefully
    const measureName    = chart.measure_name    || chart.y_column    || '';
    const categoryColumn = chart.category_column || chart.x_column    || '';

    const pos = { x: cx, y: cy, z: 0, width: cw, height: CHART_H };
    containers.push(makeChartVisual(
      tableName,
      measureName,
      categoryColumn,
      chart.type || 'bar',
      chart.title,
      pos,
      tabOrder++,
      chart.top_n || null,
      chart          // pass full chart for type-specific handling
    ));

    if (wide) {
      cx = MARGIN;
      cy += CHART_H + CHART_GAP;
    } else {
      if (cx === MARGIN) {
        cx = MARGIN + halfW + CHART_GAP;
      } else {
        cx = MARGIN;
        cy += CHART_H + CHART_GAP;
      }
    }
  });

  const pageH = Math.max(720, cy + CHART_H + MARGIN);

  return {
    id: 0,
    sections: [
      {
        id: 0,
        name: 'ReportSection',
        displayName: spec.title || 'Dashboard',
        filters: '[]',
        ordinal: 0,
        visualContainers: containers,
        config: JSON.stringify({ relationships: [] }),
        height: pageH,
        width: PAGE_W
      }
    ],
    config: JSON.stringify({
      version: '5.47',
      themeCollection: { baseTheme: { name: 'CY24SU10', reportVersionAtImport: '5.47' } }
    }),
    filters: '[]'
  };
}

/* ── Card visual container ── */
function makeCardVisual(tableName, measureName, title, position, tabOrder) {
  const queryRef = `${tableName}.${measureName || 'Measure'}`;
  const safeTitle = String(title || measureName || 'KPI').replace(/'/g, "\\'");

  const config = {
    name: `card_${tabOrder}`,
    layouts: [{
      id: 0,
      position: { x: position.x, y: position.y, z: position.z || 0, width: position.width, height: position.height, tabOrder, displayState: { mode: 0 } }
    }],
    singleVisual: {
      visualType: 'card',
      projections: {
        Values: [{ queryRef, active: true }]
      },
      prototypeQuery: {
        Version: 2,
        From: [{ Name: 't', Entity: tableName, Type: 0 }],
        Select: [{
          Measure: { Expression: { SourceRef: { Source: 't' } }, Property: measureName },
          Name: queryRef
        }]
      },
      vcObjects: {
        title: [{
          properties: {
            show: { expr: { Literal: { Value: 'true' } } },
            text: { expr: { Literal: { Value: `'${safeTitle}'` } } }
          }
        }],
        labels: [{
          properties: {
            fontSize: { expr: { Literal: { Value: '24D' } } }
          }
        }]
      }
    }
  };

  const query = {
    Version: 2,
    From: [{ Name: 't', Entity: tableName, Type: 0 }],
    Select: [{
      Measure: { Expression: { SourceRef: { Source: 't' } }, Property: measureName },
      Name: queryRef
    }]
  };

  return {
    x: position.x, y: position.y, z: position.z || 0,
    width: position.width, height: position.height,
    config: JSON.stringify(config),
    filters: '[]',
    query: JSON.stringify(query),
    dataTransforms: JSON.stringify({
      queryMetadata: {
        Select: [{ Restatement: title, Name: queryRef, Type: { Numeric: 4 } }]
      }
    })
  };
}

/* ── Chart visual container ── */
function makeChartVisual(tableName, measureName, categoryColumn, chartType, title, position, tabOrder, topN, chartObj) {
  const pbiTypeMap = {
    bar:           'clusteredColumnChart',
    column:        'clusteredColumnChart',
    line:          'lineChart',
    area:          'areaChart',
    pie:           'pieChart',
    donut:         'donutChart',
    scatter:       'scatterChart',
    funnel:        'funnel',
    waterfall:     'waterfallChart',
    treemap:       'treemap',
    gauge:         'gauge',
    choropleth:    'filledMap',
    scattergeo:    'filledMap',
    histogram:     'clusteredColumnChart',
    stackedbar:    'stackedColumnChart',
    stackedarea:   'areaChart',
    combo:         'lineClusteredColumnComboChart',   // plain combo (line + clustered column)
    matrix:        'tableEx',
    multi_row_card:'tableEx',                         // render as table in pbit (preview uses custom HTML)
    sankey:        'tableEx',                         // no native sankey in default PBI visuals → table
    gantt:         'tableEx',                         // Gantt needs a custom visual → table fallback
    bullet:        'clusteredBarChart'                // bullet → horizontal bar in PBI
  };
  // Stacked column combo → different Power BI type
  const isStackedCombo = chartType === 'combo' && chartObj && (chartObj.stack_mode === 'stack' || chartObj.stack_mode === 'percent');
  const pbiType = isStackedCombo ? 'lineStackedColumnComboChart' : (pbiTypeMap[chartType] || 'clusteredColumnChart');
  const isMap     = pbiType === 'filledMap';
  const isGauge   = pbiType === 'gauge';

  const measureRef = measureName ? `${tableName}.${measureName}` : null;
  const catRef     = categoryColumn ? `${tableName}.${categoryColumn}` : null;
  const safeTitle  = String(title || measureName || 'Chart').replace(/'/g, "\\'");

  // Build projections based on chart type
  const projections = {};
  if (isMap) {
    // Filled map uses Location bucket for geographic column + Values for measure
    if (catRef)     projections.Location = [{ queryRef: catRef }];
    if (measureRef) projections.Values   = [{ queryRef: measureRef }];
  } else if (isGauge) {
    // Gauge uses Y for the value, with optional min/max/target
    if (measureRef) projections.Y       = [{ queryRef: measureRef }];
    // min/max/target are properties, not projections — handled via vcObjects below
  } else if (chartType === 'multi_row_card') {
    // Multi-row card → table visual: project all metric columns as Values
    // x_column (category) is the row grouping; metric columns are the Values
    if (catRef) projections.Values = [{ queryRef: catRef }];
    if (chartObj && Array.isArray(chartObj.metrics)) {
      chartObj.metrics.forEach(metric => {
        if (metric.column) {
          const mRef = `${tableName}.${metric.column}`;
          if (!projections.Values) projections.Values = [];
          if (!projections.Values.find(v => v.queryRef === mRef)) {
            projections.Values.push({ queryRef: mRef });
          }
        }
      });
    } else if (measureRef) {
      if (!projections.Values) projections.Values = [];
      projections.Values.push({ queryRef: measureRef });
    }
  } else if (['pie', 'donut', 'treemap', 'funnel'].includes(chartType)) {
    if (catRef)     projections.Category = [{ queryRef: catRef }];
    if (measureRef) projections.Y        = [{ queryRef: measureRef }];
  } else {
    if (catRef)     projections.Category = [{ queryRef: catRef }];
    if (measureRef) projections.Y        = [{ queryRef: measureRef }];
  }

  const fromClause   = [{ Name: 't', Entity: tableName, Type: 0 }];
  const selectClause = [];

  if (categoryColumn) {
    selectClause.push({
      Column: { Expression: { SourceRef: { Source: 't' } }, Property: categoryColumn },
      Name: catRef
    });
  }
  if (chartType === 'multi_row_card' && chartObj && Array.isArray(chartObj.metrics)) {
    // For multi_row_card: add each metric column as a column in the select clause
    const addedCols = new Set(categoryColumn ? [categoryColumn] : []);
    chartObj.metrics.forEach(metric => {
      if (metric.column && !addedCols.has(metric.column)) {
        addedCols.add(metric.column);
        const mRef = `${tableName}.${metric.column}`;
        selectClause.push({
          Column: { Expression: { SourceRef: { Source: 't' } }, Property: metric.column },
          Name: mRef
        });
      }
    });
  } else if (measureName) {
    selectClause.push({
      Measure: { Expression: { SourceRef: { Source: 't' } }, Property: measureName },
      Name: measureRef
    });
  }

  const protoQuery = {
    Version: 2,
    From: fromClause,
    Select: selectClause
  };
  // Sorting only makes sense for ranked chart types (not multi_row_card or map or gauge)
  if (!isMap && !isGauge && chartType !== 'multi_row_card' && measureName) {
    protoQuery.OrderBy = [{
      Direction: 2,
      Expression: { Measure: { Expression: { SourceRef: { Source: 't' } }, Property: measureName } }
    }];
  }
  if (topN) protoQuery.Top = { Count: topN };

  // Build vcObjects (title + gauge-specific range)
  const vcObjects = {
    title: [{
      properties: {
        show: { expr: { Literal: { Value: 'true' } } },
        text: { expr: { Literal: { Value: `'${safeTitle}'` } } }
      }
    }]
  };

  if (isGauge && chartObj) {
    const gaugeProps = {};
    const c = chartObj;
    if (c.min_value    != null) gaugeProps.minValue    = { expr: { Literal: { Value: `${c.min_value}D`    } } };
    if (c.max_value    != null) gaugeProps.maxValue    = { expr: { Literal: { Value: `${c.max_value}D`    } } };
    if (c.target_value != null) gaugeProps.targetValue = { expr: { Literal: { Value: `${c.target_value}D` } } };
    if (Object.keys(gaugeProps).length) {
      vcObjects.gauge = [{ properties: gaugeProps }];
    }
  }

  const config = {
    name: `chart_${tabOrder}`,
    layouts: [{
      id: 0,
      position: { x: position.x, y: position.y, z: position.z || 0, width: position.width, height: position.height, tabOrder, displayState: { mode: 0 } }
    }],
    singleVisual: {
      visualType: pbiType,
      projections,
      prototypeQuery: protoQuery,
      vcObjects
    }
  };

  const queryObj = { ...protoQuery };

  const dtSelect = [];
  if (categoryColumn && catRef) {
    dtSelect.push({ Restatement: categoryColumn, Name: catRef, Type: { Category: 'BasicText' } });
  }
  if (measureName && measureRef) {
    dtSelect.push({ Restatement: title || measureName, Name: measureRef, Type: { Numeric: 4 } });
  }

  return {
    x: position.x, y: position.y, z: position.z || 0,
    width: position.width, height: position.height,
    config: JSON.stringify(config),
    filters: '[]',
    query: JSON.stringify(queryObj),
    dataTransforms: JSON.stringify({ queryMetadata: { Select: dtSelect } })
  };
}

/* ════════════════════════════════════════════
   UTILITIES
   ════════════════════════════════════════════ */

/**
 * Chunked base64 encoding to avoid call-stack overflow on large payloads.
 */
function toBase64(str) {
  // Use Node.js Buffer directly — much simpler and faster than browser btoa
  return Buffer.from(str, 'utf8').toString('base64');
}

function mStr(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

function fileNameToTableName(fileName) {
  if (!fileName) return 'DataTable';
  const base = fileName.replace(/\.[^.]+$/, '');
  return base
    .split(/[\s_\-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .replace(/[^a-zA-Z0-9]/g, '')
    || 'DataTable';
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { generatePbit };
