require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { buildDashboardWithOllama, processOllamaContent, checkOllamaHealth } = require('./ollama-agent');
const { buildDashboardWithGroq, checkGroqHealth } = require('./groq-agent');
const { generatePbit } = require('./pbit-builder');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..')));

/* ── Shared pbit response helper ───────────────────────── */
async function _respond(res, spec, csvData, columns, colTypes, fileName) {
  const pbitBuffer  = await generatePbit(spec, csvData, columns, colTypes, fileName);
  const outFileName = `dashboard_${Date.now()}.pbit`;
  res.json({ success: true, spec, pbitBase64: pbitBuffer.toString('base64'), fileName: outFileName });
}

/* ══ Main build endpoint ══════════════════════════════════
   Uses Groq cloud LLM when GROQ_API_KEY is set (default for
   hosted deployments). Falls back to local Ollama otherwise.
══════════════════════════════════════════════════════════ */
app.post('/api/build-powerbi', async (req, res) => {
  try {
    const { csvData, columns, colTypes, prompt, fileName } = req.body;
    if (!csvData) throw new Error('No CSV data provided');
    if (!prompt)  throw new Error('No prompt provided');

    const useGroq = !!process.env.GROQ_API_KEY;
    console.log(`[PowerBI] "${fileName || 'data'}" via ${useGroq ? 'Groq cloud' : 'local Ollama'}`);

    const spec = useGroq
      ? await buildDashboardWithGroq(csvData, columns, colTypes, prompt, fileName)
      : await buildDashboardWithOllama(csvData, columns, colTypes, prompt, fileName);

    await _respond(res, spec, csvData, columns, colTypes, fileName);
  } catch (err) {
    console.error('[PowerBI Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══ Client-Ollama endpoint (browser calls Ollama itself) ══
   Kept for users who run Ollama locally and prefer it.
══════════════════════════════════════════════════════════ */
app.post('/api/build-powerbi-client-ollama', async (req, res) => {
  try {
    const { ollamaContent, csvData, columns, colTypes, prompt, fileName } = req.body;
    if (!ollamaContent) throw new Error('No Ollama content provided');
    if (!csvData)       throw new Error('No CSV data provided');
    if (!prompt)        throw new Error('No prompt provided');

    console.log(`[PowerBI-Local] "${fileName || 'data'}" — ${columns?.length || 0} cols`);
    const spec = await processOllamaContent(ollamaContent, csvData, columns, colTypes, prompt, fileName);
    await _respond(res, spec, csvData, columns, colTypes, fileName);
  } catch (err) {
    console.error('[PowerBI-Local Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══ Health check ════════════════════════════════════════ */
app.get('/api/health', async (req, res) => {
  const groq  = await checkGroqHealth();
  const useGroq = groq.configured;

  if (useGroq) {
    res.json({
      status:     'ok',
      llmMode:    'groq',
      groqReady:  groq.reachable,
      groqModel:  groq.model,
      error:      groq.error || null
    });
    return;
  }

  // Fall back: check local Ollama
  const ollamaUrl = process.env.OLLAMA_URL  || 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL || 'llama3.2';
  try {
    const { models, modelLoaded } = await checkOllamaHealth(ollamaUrl, model);
    res.json({ status: 'ok', llmMode: 'ollama', ollamaReachable: true, modelLoaded, model, availableModels: models });
  } catch (e) {
    res.json({ status: 'ok', llmMode: 'ollama', ollamaReachable: false, modelLoaded: false, model, error: e.message });
  }
});

/* ══ Start ═══════════════════════════════════════════════ */
app.listen(PORT, () => {
  const useGroq = !!process.env.GROQ_API_KEY;
  console.log('\n=== AI Dashboard Builder ===');
  console.log(`   App:  http://localhost:${PORT}`);
  console.log(`   LLM:  ${useGroq ? `Groq cloud (${process.env.GROQ_MODEL || 'llama-3.1-8b-instant'})` : 'Local Ollama — run: ollama serve'}`);
  if (!useGroq) console.log(`   Tip:  set GROQ_API_KEY for cloud LLM (free at console.groq.com)`);
  console.log('============================\n');
});
