const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a senior Power BI architect and DAX expert. Given a dataset and user requirements, create a complete dashboard specification.

RULES:
1. Follow user requests EXACTLY — create only what they ask for
2. All DAX measures must use the exact table_name you define and exact column names from the dataset
3. DAX format: SUM('TableName'[ColumnName]), DISTINCTCOUNT('TableName'[ColumnName]), AVERAGE(...), etc.
4. For time intelligence, always check if a date column exists first
5. Choose appropriate chart types: bar for comparisons, line/area for trends, pie/donut for distributions (<=8 categories)
6. Always create 3-6 KPI cards with the most important metrics
7. table_name: use a clean PascalCase version of the file name, e.g. "SalesData"`;

const TOOL = {
  name: 'create_dashboard_spec',
  description: 'Create a complete Power BI dashboard specification with DAX measures, KPI cards, charts, and filters based on the dataset and user prompt.',
  input_schema: {
    type: 'object',
    required: ['title', 'kpi_cards', 'charts', 'dax_measures'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      table_name: { type: 'string', description: 'Name for the Power BI table, e.g. SalesData' },
      dax_measures: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'expression', 'format_string'],
          properties: {
            name: { type: 'string' },
            expression: { type: 'string', description: "Valid DAX expression, e.g. SUM('SalesData'[Revenue])" },
            format_string: { type: 'string', description: 'e.g. "$#,0.00" or "#,0" or "0.00%"' },
            description: { type: 'string' }
          }
        }
      },
      kpi_cards: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'measure_name'],
          properties: {
            title: { type: 'string' },
            measure_name: { type: 'string', description: 'Must match a name in dax_measures' },
            format: { type: 'string', enum: ['currency', 'number', 'percentage', 'text'] }
          }
        }
      },
      charts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'title', 'type', 'measure_name'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'funnel'] },
            measure_name: { type: 'string', description: 'Must match a name in dax_measures' },
            category_column: { type: 'string', description: 'Column name for X axis / grouping' },
            width: { type: 'number', enum: [1, 2], description: '2 = full width' },
            top_n: { type: 'number', description: 'Limit to top N categories' }
          }
        }
      },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            label: { type: 'string' }
          }
        }
      }
    }
  }
};

/**
 * Build a human-readable column profile for Claude to understand the dataset.
 */
function buildColumnProfile(columns, colTypes, csvData) {
  // Parse a sample of rows from csvData for cardinality + sample values
  const lines = csvData.split('\n').filter(l => l.trim());
  const headers = lines[0] ? lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim()) : columns;
  const sampleLines = lines.slice(1, Math.min(201, lines.length)); // up to 200 rows

  // Simple CSV parse for sample values
  const rows = sampleLines.map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });

  const totalRows = lines.length - 1;

  return columns.map(col => {
    const type = colTypes[col] || 'string';
    const vals = rows.map(r => r[col]).filter(v => v != null && v !== '');
    const unique = [...new Set(vals)];
    const cardinality = unique.length;
    const samples = unique.slice(0, 5).map(v => `"${v}"`).join(', ');

    let extra = '';
    if (type === 'number') {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      if (nums.length) {
        const mn = Math.min(...nums), mx = Math.max(...nums);
        extra = ` | range: ${mn.toLocaleString()} – ${mx.toLocaleString()}`;
      }
    }

    return `  ${col} [${type}] — ${cardinality} unique values${extra} — samples: ${samples}`;
  }).join('\n') + `\n  (Total rows in dataset: ${totalRows.toLocaleString()})`;
}

/**
 * Derive a PascalCase table name from the file name.
 */
function fileNameToTableName(fileName) {
  if (!fileName) return 'DataTable';
  const base = fileName.replace(/\.[^.]+$/, ''); // remove extension
  return base
    .split(/[\s_\-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .replace(/[^a-zA-Z0-9]/g, '')
    || 'DataTable';
}

/**
 * Main entry point: call Claude with tool_use to get a structured dashboard spec.
 */
async function buildDashboardWithClaude(csvData, columns, colTypes, prompt, fileName) {
  const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  const model  = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  const tableName = fileNameToTableName(fileName);
  const colProfile = buildColumnProfile(columns, colTypes, csvData);

  const userMessage = `File: ${fileName || 'data.csv'}
Suggested table name: ${tableName}

COLUMN PROFILES:
${colProfile}

USER REQUIREMENTS:
${prompt}

Use the create_dashboard_spec tool to return the complete Power BI dashboard specification.
All DAX expressions must reference table '${tableName}' and use exact column names from the profiles above.`;

  console.log(`[claude-agent] Calling ${model} with tool_use…`);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: userMessage }]
  });

  // Extract tool_use block
  if (response.stop_reason === 'tool_use') {
    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'create_dashboard_spec');
    if (toolBlock && toolBlock.input) {
      const spec = toolBlock.input;
      // Ensure table_name is set
      if (!spec.table_name) spec.table_name = tableName;
      console.log(`[claude-agent] Got spec: "${spec.title}" — ${spec.charts?.length || 0} charts, ${spec.dax_measures?.length || 0} measures`);
      return spec;
    }
  }

  // Fallback: try to parse JSON from text response
  const textBlock = response.content.find(b => b.type === 'text');
  if (textBlock) {
    console.warn('[claude-agent] No tool_use block; attempting text JSON parse fallback');
    const spec = extractJsonFromText(textBlock.text);
    if (spec) {
      if (!spec.table_name) spec.table_name = tableName;
      return spec;
    }
  }

  throw new Error('Claude did not return a valid dashboard specification. Check the model and API key.');
}

/**
 * Fallback: extract the first valid JSON object from a text string.
 */
function extractJsonFromText(text) {
  const s = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '');

  let pos = 0;
  while (pos < s.length) {
    const idx = s.indexOf('{', pos);
    if (idx === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = idx; i < s.length; i++) {
      const c = s[i];
      if (esc)               { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"')         { inStr = !inStr; continue; }
      if (inStr)             continue;
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

module.exports = { buildDashboardWithClaude };
