/**
 * chart-rag.js — Chart-type RAG (Retrieval-Augmented Generation) engine
 *
 * Stores chart type "documents" as vector embeddings.
 * At query time, embeds the user prompt and returns the most semantically
 * similar chart types ranked by cosine similarity.
 *
 * Embedding strategy (in priority order):
 *   1. Ollama /api/embeddings  (nomic-embed-text or mxbai-embed-large)
 *   2. TF-IDF cosine similarity fallback (pure JS, no extra dependencies)
 *
 * Embeddings are cached to disk so they are computed only once.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const CACHE_FILE = path.join(__dirname, 'chart-embeddings.json');

/* ═══════════════════════════════════════════════════════════════
   CHART KNOWLEDGE BASE
   Each entry is one "document" in the RAG store.
   `text`  — the document that gets embedded (rich, descriptive).
   `tags`  — lightweight labels for UI grouping.
═══════════════════════════════════════════════════════════════ */
const CHART_KB = [
  {
    type: 'bar',
    name: 'Bar / Column Chart',
    icon: '▮▮▮',
    tags: ['comparison', 'ranking', 'categorical'],
    promptKey: 'bar chart',
    text: 'bar chart column chart compare values across categories ranking top bottom items count per category total revenue by group vertical bars side by side grouped comparison'
  },
  {
    type: 'horizontal_bar',
    name: 'Horizontal Bar Chart',
    icon: '≡≡≡',
    tags: ['comparison', 'ranking', 'long labels'],
    promptKey: 'horizontal bar chart',
    text: 'horizontal bar chart long category names ranking items compare side by side total per department country region sorted ranked descending ascending'
  },
  {
    type: 'line',
    name: 'Line Chart',
    icon: '📈',
    tags: ['trend', 'time-series', 'temporal'],
    promptKey: 'line chart',
    text: 'line chart trend over time time series monthly weekly daily yearly progression growth change temporal date sequence history forecast movement fluctuation'
  },
  {
    type: 'area',
    name: 'Area Chart',
    icon: '◭',
    tags: ['trend', 'volume', 'cumulative'],
    promptKey: 'area chart',
    text: 'area chart filled line cumulative volume over time stacked area total over months years growth fill under curve volume trend temporal'
  },
  {
    type: 'scatter',
    name: 'Scatter Plot',
    icon: '⋮',
    tags: ['correlation', 'distribution', 'two-numeric'],
    promptKey: 'scatter chart',
    text: 'scatter plot correlation relationship between two numeric columns x y axis variables distribution outliers clusters pattern dots points'
  },
  {
    type: 'bubble',
    name: 'Bubble Chart',
    icon: '⊙',
    tags: ['correlation', 'three-numeric', 'size'],
    promptKey: 'bubble chart with variable size bubbles',
    text: 'bubble chart three variables size weight correlation scatter with size dimension x y z bubble size magnitude emphasis larger smaller population'
  },
  {
    type: 'pie',
    name: 'Pie Chart',
    icon: '◔',
    tags: ['proportion', 'share', 'part-of-whole'],
    promptKey: 'pie chart',
    text: 'pie chart proportion share percentage part whole composition breakdown distribution slice segment contribution relative percentage each category'
  },
  {
    type: 'donut',
    name: 'Donut Chart',
    icon: '◎',
    tags: ['proportion', 'share', 'modern'],
    promptKey: 'donut chart',
    text: 'donut chart doughnut ring proportion share percentage part whole modern clean space centre total KPI proportion of total breakdown'
  },
  {
    type: 'histogram',
    name: 'Histogram',
    icon: '▐▐▐',
    tags: ['distribution', 'frequency', 'bins'],
    promptKey: 'histogram',
    text: 'histogram distribution frequency bins numeric spread normal bell curve skew outliers age salary price range how many fall in each bin'
  },
  {
    type: 'waterfall',
    name: 'Waterfall Chart',
    icon: '⬆⬇',
    tags: ['variance', 'change', 'bridge'],
    promptKey: 'waterfall chart',
    text: 'waterfall chart cumulative change positive negative contributions running total bridge from start to end variance analysis budget vs actual incremental changes'
  },
  {
    type: 'funnel',
    name: 'Funnel Chart',
    icon: '▽',
    tags: ['stages', 'conversion', 'pipeline'],
    promptKey: 'funnel chart',
    text: 'funnel chart pipeline stages conversion rate drop off sales funnel lead opportunity quote close won sequential stages attrition bottleneck'
  },
  {
    type: 'treemap',
    name: 'Treemap',
    icon: '⬜',
    tags: ['hierarchy', 'proportional', 'nested'],
    promptKey: 'treemap chart',
    text: 'treemap hierarchical proportion nested rectangles part whole size relative category subcategory drill down two level hierarchy parent child proportion of total'
  },
  {
    type: 'heatmap',
    name: 'Heatmap',
    icon: '▦',
    tags: ['density', 'cross-tab', 'two-dimensional'],
    promptKey: 'heatmap chart',
    text: 'heatmap heat map density intensity cross tabulation two categorical columns frequency count correlation matrix cell colour coded grid row column intersection activity by time day hour'
  },
  {
    type: 'sunburst',
    name: 'Sunburst Chart',
    icon: '☀',
    tags: ['hierarchy', 'radial', 'drill-down'],
    promptKey: 'sunburst chart',
    text: 'sunburst radial hierarchy circular drill down parent child levels concentric rings proportion within hierarchy org breakdown category subcategory radial layout'
  },
  {
    type: 'treemap',
    name: 'Hierarchy Tree',
    icon: '🌳',
    tags: ['hierarchy', 'tree', 'org-chart'],
    promptKey: 'hierarchy tree chart',
    text: 'hierarchy tree org chart organisational structure parent child nodes levels drill down tree structure reporting structure department team manager subordinate nested hierarchy'
  },
  {
    type: 'gauge',
    name: 'Gauge / KPI Indicator',
    icon: '⊙',
    tags: ['KPI', 'single-value', 'target'],
    promptKey: 'gauge chart',
    text: 'gauge speedometer KPI indicator progress toward target single metric value performance score threshold red amber green percentage completion rate'
  },
  {
    type: 'choropleth',
    name: 'Filled Map (Choropleth)',
    icon: '🗺',
    tags: ['geography', 'map', 'regional'],
    promptKey: 'filled map choropleth',
    text: 'map choropleth geographic filled country region state province colour coded location country distribution geographic spatial territory heat region value map'
  },
  {
    type: 'scattergeo',
    name: 'Bubble Map',
    icon: '🌍',
    tags: ['geography', 'map', 'bubble'],
    promptKey: 'map visual with data bubbles',
    text: 'bubble map geographic scatter circle size country city location latitude longitude bubble proportional map visual data dots on map geographic spread'
  },
  {
    type: 'combo',
    name: 'Combo Chart (Bar + Line)',
    icon: '⊟',
    tags: ['dual-axis', 'mixed', 'bar-line'],
    promptKey: 'line and clustered column combo chart',
    text: 'combo chart bar and line dual axis two measures combined secondary axis revenue and growth rate volume and price bar column with line overlay'
  },
  {
    type: 'sankey',
    name: 'Sankey / Flow Diagram',
    icon: '≋',
    tags: ['flow', 'from-to', 'allocation'],
    promptKey: 'sankey chart',
    text: 'sankey flow diagram source destination from to allocation transfer migration customer journey energy flow material flow budget allocation weighted paths between categories'
  },
  {
    type: 'gantt',
    name: 'Gantt Chart',
    icon: '⊟',
    tags: ['timeline', 'project', 'schedule'],
    promptKey: 'gantt chart',
    text: 'gantt chart project timeline schedule tasks start end date duration milestones phases activities planning timeline horizontal bar date range project management'
  },
  {
    type: 'bullet',
    name: 'Bullet Chart',
    icon: '⊟',
    tags: ['KPI', 'target', 'actual-vs-target'],
    promptKey: 'bullet chart',
    text: 'bullet chart actual vs target comparison performance against goal quota benchmark KPI indicator progress bar with target marker actual achievement versus plan'
  },
  {
    type: 'table',
    name: 'Data Table',
    icon: '⊞',
    tags: ['tabular', 'raw-data', 'detail'],
    promptKey: 'data table',
    text: 'data table tabular view raw records rows columns details all fields report listing show all data grid spreadsheet view individual records'
  },
  {
    type: 'matrix',
    name: 'Matrix / Pivot Table',
    icon: '⊞',
    tags: ['pivot', 'cross-tab', 'aggregated'],
    promptKey: 'matrix table with row and column groupings',
    text: 'matrix pivot table cross tab row column groupings subtotals grand total aggregated summary two dimensional breakdown rows columns intersection'
  },
  {
    type: 'multi_row_card',
    name: 'Multi-Row Card',
    icon: '⊟',
    tags: ['cards', 'metrics', 'group'],
    promptKey: 'multi-row card visual',
    text: 'multi row card metrics per group category scorecard multiple KPIs per category row department country product multiple metrics side by side comparison card'
  }
];

/* ═══════════════════════════════════════════════════════════════
   VECTOR MATH
═══════════════════════════════════════════════════════════════ */

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/* ═══════════════════════════════════════════════════════════════
   TF-IDF FALLBACK
   Pure JS — no extra packages. Used when Ollama embeddings
   are unavailable.
═══════════════════════════════════════════════════════════════ */

const STOPWORDS = new Set([
  'a','an','the','and','or','of','in','to','for','with','on','at','by',
  'from','as','is','was','are','be','been','that','this','it','its',
  'we','you','he','she','they','do','does','did','have','has','had',
  'will','would','can','could','may','might','shall','should'
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function buildTfIdfVectors(docs) {
  // Build vocabulary
  const vocab = new Map();
  docs.forEach(doc => {
    tokenize(doc).forEach(t => { if (!vocab.has(t)) vocab.set(t, vocab.size); });
  });

  // Document frequency
  const df = new Float32Array(vocab.size);
  docs.forEach(doc => {
    const seen = new Set(tokenize(doc));
    seen.forEach(t => { const i = vocab.get(t); if (i !== undefined) df[i]++; });
  });

  const N = docs.length;

  // TF-IDF vectors
  return docs.map(doc => {
    const tokens = tokenize(doc);
    const tf     = new Map();
    tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));

    const vec = new Float32Array(vocab.size);
    tf.forEach((count, t) => {
      const i = vocab.get(t);
      if (i !== undefined && df[i] > 0) {
        vec[i] = (count / tokens.length) * Math.log(N / df[i]);
      }
    });
    return vec;
  });
}

/* ═══════════════════════════════════════════════════════════════
   OLLAMA EMBEDDINGS
═══════════════════════════════════════════════════════════════ */

const EMBED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm'];

async function getOllamaEmbedding(text, ollamaUrl, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, prompt: text });
    const buf  = Buffer.from(body);
    const url  = new URL(ollamaUrl);
    const opts = {
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     '/api/embeddings',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': buf.length }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          if (obj.embedding && obj.embedding.length > 0) resolve(obj.embedding);
          else reject(new Error(`No embedding returned from ${model}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(buf);
    req.end();
  });
}

async function findWorkingEmbedModel(ollamaUrl) {
  for (const model of EMBED_MODELS) {
    try {
      await getOllamaEmbedding('test', ollamaUrl, model);
      return model;
    } catch (_) { /* try next */ }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   RAG STATE
═══════════════════════════════════════════════════════════════ */

let _state = null;   // populated by initRag()

/**
 * initRag(ollamaUrl)
 * Called once at server startup. Tries Ollama embeddings first;
 * falls back to TF-IDF if no embedding model is available.
 * Caches embeddings to disk so subsequent starts are instant.
 */
async function initRag(ollamaUrl) {
  console.log('[rag] Initialising chart-type RAG store…');

  // Try to load from cache first
  const cacheKey = `v3_${CHART_KB.length}`;   // bump prefix when KB changes
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached.cacheKey === cacheKey && cached.mode) {
        _state = {
          mode:       cached.mode,
          embedModel: cached.embedModel || null,
          vectors:    cached.vectors.map(v => new Float32Array(v)),
          kb:         CHART_KB
        };
        console.log(`[rag] Loaded from cache (${_state.mode}, ${CHART_KB.length} entries)`);
        return;
      }
    } catch (_) { /* cache corrupt — regenerate */ }
  }

  // Try Ollama embeddings
  const embedModel = await findWorkingEmbedModel(ollamaUrl);
  if (embedModel) {
    console.log(`[rag] Using Ollama embedding model: ${embedModel}`);
    try {
      const vectors = [];
      for (const entry of CHART_KB) {
        const vec = await getOllamaEmbedding(entry.text, ollamaUrl, embedModel);
        vectors.push(new Float32Array(vec));
      }
      _state = { mode: 'ollama', embedModel, vectors, kb: CHART_KB };
      _saveCache(cacheKey, 'ollama', embedModel, vectors);
      console.log(`[rag] Embeddings generated (${vectors.length} charts, model: ${embedModel})`);
      return;
    } catch (e) {
      console.warn('[rag] Ollama embedding failed, falling back to TF-IDF:', e.message);
    }
  }

  // TF-IDF fallback
  console.log('[rag] Using TF-IDF fallback (no Ollama embed model found)');
  const docs    = CHART_KB.map(e => e.text);
  const vectors = buildTfIdfVectors(docs);
  _state = { mode: 'tfidf', embedModel: null, vectors, kb: CHART_KB };
  _saveCache(cacheKey, 'tfidf', null, vectors);
}

function _saveCache(cacheKey, mode, embedModel, vectors) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      cacheKey, mode, embedModel,
      vectors: vectors.map(v => Array.from(v))
    }));
  } catch (e) {
    console.warn('[rag] Could not save embedding cache:', e.message);
  }
}

/**
 * searchCharts(prompt, topK, ollamaUrl?)
 * Returns top-K chart type matches sorted by similarity score.
 */
async function searchCharts(prompt, topK = 5, ollamaUrl) {
  if (!_state) throw new Error('RAG not initialised — call initRag() first');

  let queryVec;

  if (_state.mode === 'ollama' && ollamaUrl) {
    try {
      const raw = await getOllamaEmbedding(prompt, ollamaUrl, _state.embedModel);
      queryVec  = new Float32Array(raw);
    } catch (_) {
      // Fall through to TF-IDF if live query fails
    }
  }

  if (!queryVec) {
    // TF-IDF query vector
    const docs   = [...CHART_KB.map(e => e.text), prompt];
    const vecs   = buildTfIdfVectors(docs);
    queryVec     = vecs[vecs.length - 1];
    // Re-use pre-built vectors for KB (same vocab would differ, so recompute for fallback)
    const results = vecs.slice(0, CHART_KB.length)
      .map((v, i) => ({
        ...CHART_KB[i],
        score: Math.round(cosineSim(vecs[vecs.length - 1], v) * 100) / 100
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return results;
  }

  // Score every KB entry against the query vector
  const results = _state.vectors.map((v, i) => ({
    ...CHART_KB[i],
    score: Math.round(cosineSim(queryVec, v) * 100) / 100
  }));

  // De-duplicate by promptKey (keep highest score)
  const seen = new Map();
  results.forEach(r => {
    if (!seen.has(r.promptKey) || r.score > seen.get(r.promptKey).score)
      seen.set(r.promptKey, r);
  });

  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * listCharts() — returns the full knowledge base (no scores)
 */
function listCharts() {
  // De-duplicate by promptKey
  const seen = new Map();
  CHART_KB.forEach(e => { if (!seen.has(e.promptKey)) seen.set(e.promptKey, e); });
  return [...seen.values()];
}

/**
 * ragStatus() — quick status summary
 */
function ragStatus() {
  if (!_state) return { ready: false };
  return {
    ready:      true,
    mode:       _state.mode,
    embedModel: _state.embedModel,
    entries:    CHART_KB.length,
    uniqueTypes: listCharts().length
  };
}

module.exports = { initRag, searchCharts, listCharts, ragStatus };
