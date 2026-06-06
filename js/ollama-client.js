/* ═══════════════════════════════════════════════════════════
   Ollama Client — browser-side LLM call
   The browser calls the user's Ollama directly (their own
   localhost:11434), so it works both locally AND from a
   hosted website — no server-side Ollama required.
═══════════════════════════════════════════════════════════ */

const OLLAMA_SYSTEM_PROMPT = `You are a dashboard layout designer. Name dashboard components based on user requirements.

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
Create exactly as many kpis and charts as the user requests. Use the user's exact wording for titles.
When the user requests a KPI "with a comparison against X" or "with a secondary indicator for Y", create SEPARATE KPI cards for each metric (primary, comparison metric, and secondary metric).
Example: "Average Annual Salary with comparison against median salary and secondary indicator for Total Headcount" → create 3 KPI cards: "Average Annual Salary", "Median Annual Salary", "Total Headcount".`;

/* Build the same column profile the server would have sent to Ollama */
function _buildColumnProfile(columns, colTypes, csvData) {
  const lines       = csvData.split('\n').filter(l => l.trim());
  const headers     = lines[0] ? lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim()) : columns;
  const sampleLines = lines.slice(1, Math.min(51, lines.length));

  const rows = sampleLines.map(line => {
    const vals = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"')              { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else                         { cur += ch; }
    }
    vals.push(cur.trim());
    const obj = {}; headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });

  return columns.map(col => {
    const type    = colTypes[col] || 'string';
    const vals    = rows.map(r => r[col]).filter(v => v != null && v !== '');
    const unique  = [...new Set(vals)];
    const samples = unique.slice(0, 3).map(v => `"${v}"`).join(', ');
    return `  ${col} [${type}] samples: ${samples}`;
  }).join('\n') + `\n  (${lines.length - 1} rows total)`;
}

/* ── Main entry: call Ollama from the browser ── */
async function callOllamaFromBrowser(columns, colTypes, csvData, userPrompt) {
  const ollamaUrl = (localStorage.getItem('ollama_url')   || 'http://localhost:11434').replace(/\/$/, '');
  const model     =  localStorage.getItem('ollama_model') || 'llama3.2';

  /* Warn clearly when HTTPS page tries to call plain HTTP Ollama */
  if (window.location.protocol === 'https:' && ollamaUrl.startsWith('http:')) {
    throw new Error(
      'HTTPS → HTTP blocked by browser.\n\n' +
      'Your browser prevents an HTTPS page from calling a plain HTTP address.\n\n' +
      'Fix options:\n' +
      '1. Expose Ollama via HTTPS using Cloudflare Tunnel or ngrok, then update the Ollama URL in Settings.\n' +
      '2. Run the dashboard app locally over HTTP (npm start) instead of using the hosted website.'
    );
  }

  const colProfile  = _buildColumnProfile(columns, colTypes, csvData);
  const userMessage = `Dataset columns:\n${colProfile}\n\nUser requirements: ${userPrompt}\n\nReturn JSON with dashboard title, kpi titles, and chart titles/types only.`;

  let resp;
  try {
    resp = await fetch(`${ollamaUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model,
        messages: [
          { role: 'system', content: OLLAMA_SYSTEM_PROMPT },
          { role: 'user',   content: userMessage }
        ],
        stream:  false,
        format:  'json',
        options: { temperature: 0.1, num_predict: 4096 }
      })
    });
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama at ${ollamaUrl}.\n` +
      `Run: ollama serve\n` +
      `(${err.message})`
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ollama returned ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data    = await resp.json();
  const content = data.message?.content || data.response || '';
  if (!content) throw new Error(`Ollama returned empty response. Run: ollama pull ${model}`);
  return content;
}

/* ── Health check called from the Settings panel ── */
async function checkOllamaFromBrowser() {
  const ollamaUrl = (localStorage.getItem('ollama_url')   || 'http://localhost:11434').replace(/\/$/, '');
  const model     =  localStorage.getItem('ollama_model') || 'llama3.2';

  if (window.location.protocol === 'https:' && ollamaUrl.startsWith('http:')) {
    return { ok: false, httpsBlock: true, ollamaUrl, model };
  }

  const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
  const data        = await resp.json();
  const models      = (data.models || []).map(m => m.name);
  const modelLoaded = models.some(m => m === model || m.startsWith(model + ':'));
  return { ok: true, models, modelLoaded, ollamaUrl, model };
}
