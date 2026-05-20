/* ══ System prompt ════════════════════════════════════════ */

const SYSTEM_PROMPT = `You are a precise data analyst building dashboard JSON specs from user requirements.

## MOST IMPORTANT RULE — FOLLOW USER REQUESTS EXACTLY
Create ONLY the KPI cards and charts the user explicitly asks for.
- If user asks for 4 KPI cards → create exactly 4, no more, no less.
- If user lists specific charts → create exactly those charts, nothing extra.
- Never add bonus charts or KPI cards "because they might be useful".
- Never omit a requested chart or KPI card.
- Map every requested item to the correct column from the data.

## OUTPUT FORMAT
Respond with ONLY a valid JSON object — no markdown fences, no explanation, no text outside the JSON.

## JSON SCHEMA
{
  "title": "string",
  "description": "string",
  "kpi_cards": [
    { "title": "string", "column": "exact_column_name", "aggregation": "sum|count|count_distinct|mean|max|min|top_label", "format": "number|currency|percentage|text", "prefix": "", "suffix": "", "value_column": "only for top_label" }
  ],
  "filters": [
    { "column": "exact_column_name", "label": "string" }
  ],
  "charts": [
    {
      "id": "c1",
      "title": "string",
      "type": "bar|line|area|scatter|pie|donut|histogram|box|treemap|funnel|heatmap|table",
      "x_column": "exact_column_name or null",
      "y_column": "exact_column_name or null",
      "color_column": "exact_column_name or null",
      "aggregation": "sum|count|mean|max|min|none",
      "sort_by": "y|none",
      "sort_order": "desc|asc",
      "top_n": null,
      "width": 1,
      "orientation": "v|h",
      "color_scheme": "plotly|blues|reds|greens|viridis|sunset",
      "show_values": false,
      "columns": []
    }
  ]
}

## COLUMN NAME RULE
Use EXACT column names from the COLUMN SUMMARY — copy character-for-character including spaces, capitalisation, and punctuation. Never invent column names.

## CHART TYPE RULES
- bar / line / area: x_column = category or date column, y_column = numeric column
- pie / donut / treemap / funnel: x_column = category, y_column = numeric
- scatter: x_column = numeric, y_column = numeric, aggregation = "none"
- histogram: x_column = numeric, y_column = null, aggregation = "none"
- box: y_column = numeric, x_column = category (optional grouping)
- heatmap: x_column = category, y_column = category
- table: set "columns" to the exact array of column names to display (e.g. ["Name","Age","Salary"]), set top_n for row limit (default 100), leave x_column/y_column/aggregation null/none

## VISUAL STYLE RULES (follow these exactly)
- Time series / monthly trends → ALWAYS use type="area", width=2 (full width), the renderer auto-groups date columns by month
- Product/category rankings (Top N by value) → ALWAYS use type="bar", orientation="h", sort_by="y", sort_order="desc", top_n=10
- Distribution of categories (status, method, type) → use type="donut" or type="pie"
- Comparison across few categories → use type="bar", orientation="v"
- Each bar in a ranking chart gets a different colour automatically — do not set color_column for these

## KPI AGGREGATION
- Revenue, Sales, Amount, Cost → aggregation="sum", format="currency"
- Total row count (all records) → aggregation="count", column can be any column
- Unique entities (unique orders, unique customers, unique products) → aggregation="count_distinct", column="the_id_column"
  Example: "Total Orders" on a dataset with one row per order line → { "title":"Total Orders", "column":"Order ID", "aggregation":"count_distinct" }
- Rate, Score, Percentage → aggregation="mean", format="percentage"
- Quantity/units → aggregation="sum", format="number"
- "Top X by Y" (show a NAME, not a number) → aggregation="top_label", column="label_column", value_column="numeric_column"
  Example: "Top Product by Revenue" → { "title":"Top Product", "column":"Product", "value_column":"Revenue", "aggregation":"top_label", "format":"text" }

## FILTERS
- If the user explicitly requests specific filters, create ONLY those exact filters — no extras.
- If the user does NOT mention filters at all, add 1-3 slicers using low-cardinality categorical columns (2-50 unique values).
- Never use numeric columns as filters. Never exceed what the user asked for.`;


/* ══ API call ═════════════════════════════════════════════ */

async function callClaude(messages) {
  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  if (!key) throw new Error('No Claude API key. Enter one in Settings.');

  const model    = localStorage.getItem('claude_model') || 'claude-sonnet-4-6';
  const endpoint = 'https://api.anthropic.com/v1/messages';

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    // Try fallback model on model-not-found errors
    if ((resp.status === 404 || err.error?.type === 'not_found_error') && model !== 'claude-3-5-sonnet-20241022') {
      return callClaudeWithModel(messages, 'claude-3-5-sonnet-20241022');
    }
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const data = await resp.json();
  return data.content[0].text;
}

async function callClaudeWithModel(messages, model) {
  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM_PROMPT, messages })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const data = await resp.json();
  toast(`Note: Used fallback model ${model}`, 'warn');
  return data.content[0].text;
}

/* ══ JSON extraction ══════════════════════════════════════ */

function extractSpec(text) {
  // Try bracket-depth matching to find the outermost { ... }
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
      if (esc)          { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"')    { inStr = !inStr; continue; }
      if (inStr)        continue;
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
  throw new Error('No valid JSON object found in Claude response.');
}

/* ══ API key management ═══════════════════════════════════ */

function saveSettings() {
  const cats = document.getElementById('s-cats').value;
  if (cats) localStorage.setItem('claude_max_cats', cats);

  // Always save MCP URL and Ollama settings regardless of mode
  const mcpUrl     = document.getElementById('s-mcp-url')?.value.trim();
  const ollamaUrl  = document.getElementById('s-ollama-url')?.value.trim();
  const ollamaModel= document.getElementById('s-ollama-model')?.value.trim();
  if (mcpUrl)      localStorage.setItem('mcp_server_url',  mcpUrl);
  if (ollamaUrl)   localStorage.setItem('ollama_url',      ollamaUrl);
  if (ollamaModel) localStorage.setItem('ollama_model',    ollamaModel);

  /* Never persist API credentials while in Free Mode or Power BI Mode */
  if (AppState.mode === 'free' || AppState.mode === 'powerbi') {
    closeModal('modal-settings');
    refreshAiBadge();
    toast('Settings saved ✓', 'success');
    return;
  }

  const key   = document.getElementById('s-apikey').value.replace(/\s/g, '');
  const model = document.getElementById('s-model').value;

  if (key) localStorage.setItem('claude_api_key', key);
  localStorage.setItem('claude_model', model);

  if (AppState.config?.chart) {
    AppState.config.ui = AppState.config.ui || {};
  }

  closeModal('modal-settings');
  refreshAiBadge();
  toast('Settings saved ✓', 'success');
}

function restoreSettings() {
  const key         = localStorage.getItem('claude_api_key') || '';
  const model       = localStorage.getItem('claude_model')   || 'claude-sonnet-4-6';
  const cats        = localStorage.getItem('claude_max_cats')|| '20';
  const mcpUrl      = localStorage.getItem('mcp_server_url') || '';
  const ollamaUrl   = localStorage.getItem('ollama_url')     || 'http://localhost:11434';
  const ollamaModel = localStorage.getItem('ollama_model')   || 'llama3.2';

  document.getElementById('s-apikey').value = key;
  document.getElementById('s-model').value  = model;
  document.getElementById('s-cats').value   = cats;
  const mcpEl = document.getElementById('s-mcp-url');
  if (mcpEl) mcpEl.value = mcpUrl;
  const ouEl = document.getElementById('s-ollama-url');
  if (ouEl) ouEl.value = ollamaUrl;
  const omEl = document.getElementById('s-ollama-model');
  if (omEl) omEl.value = ollamaModel;
}

async function testApiKey() {
  const key = document.getElementById('s-apikey').value.replace(/\s/g, '');
  const resultEl = document.getElementById('api-test-result');
  const badge = document.getElementById('ai-status-badge');
  if (!key) { resultEl.textContent = 'Enter an API key first.'; resultEl.style.color = 'var(--red)'; return; }

  resultEl.textContent = 'Testing…';
  resultEl.style.color = 'var(--mut)';
  badge.textContent = '';

  try {
    const model = document.getElementById('s-model').value || 'claude-sonnet-4-6';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK' }]
      })
    });

    if (resp.ok) {
      resultEl.textContent = `✓ Connected (${model})`;
      resultEl.style.color = 'var(--grn)';
      badge.textContent = '✓ valid';
      badge.style.color = 'var(--grn)';
    } else {
      const err = await resp.json().catch(() => ({}));
      resultEl.textContent = `✗ ${err.error?.message || 'Invalid key'}`;
      resultEl.style.color = 'var(--red)';
      badge.textContent = '✗ invalid';
      badge.style.color = 'var(--red)';
    }
  } catch (e) {
    resultEl.textContent = `✗ ${e.message}`;
    resultEl.style.color = 'var(--red)';
  }
}
