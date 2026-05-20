/* ═══════════════════════════════════════════════════════════
   Groq Cloud LLM Agent
   Calls Groq's free API (llama3 hosted in the cloud) so no
   local Ollama installation is required on any user's machine.
   Get a free API key at: https://console.groq.com
═══════════════════════════════════════════════════════════ */

const { processOllamaContent, buildColumnProfile, SYSTEM_PROMPT } = require('./ollama-agent');

async function buildDashboardWithGroq(csvData, columns, colTypes, prompt, fileName) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set on the server. Add it in your Render environment variables.');

  const model      = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  const colProfile = buildColumnProfile(columns, colTypes, csvData);
  const userMessage = `Dataset columns:\n${colProfile}\n\nUser requirements: ${prompt}\n\nReturn JSON with dashboard title, kpi titles, and chart titles/types only.`;

  console.log(`[groq-agent] Calling ${model} for titles…`);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage }
      ],
      temperature:     0.1,
      max_tokens:      2048,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 401) throw new Error('Groq API key is invalid. Check GROQ_API_KEY in your Render env vars.');
    if (response.status === 429) throw new Error('Groq rate limit hit. Try again in a moment.');
    throw new Error(`Groq API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data    = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('Groq returned empty response. Check your API key and model name.');

  console.log(`[groq-agent] Response received (${content.length} chars)`);
  return processOllamaContent(content, csvData, columns, colTypes, prompt, fileName);
}

async function checkGroqHealth() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { configured: false };

  const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal:  AbortSignal.timeout(6000)
    });
    if (!resp.ok) return { configured: true, reachable: false, error: `HTTP ${resp.status}` };
    const data   = await resp.json();
    const models = (data.data || []).map(m => m.id);
    return { configured: true, reachable: true, model, models };
  } catch (e) {
    return { configured: true, reachable: false, error: e.message };
  }
}

module.exports = { buildDashboardWithGroq, checkGroqHealth };
