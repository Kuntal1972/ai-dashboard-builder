# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server (serves the app at http://localhost:3001)
npm start
# or directly:
node server/index.js

# Install dependencies
npm install

# Manual chart-type integration tests (no test runner — run individually)
node test_charts_live.js
node test_combo_live.js
node test_gauge_live.js
node test_map_live.js
node test_stackedarea_live.js
node test_waterfall_live.js
```

There is no linter or automated test suite configured.

## Environment

`server/.env` (copy from `server/.env.example`):
```
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
PORT=3001
```

`GROQ_API_KEY` in the environment activates Groq cloud mode and **overrides Ollama entirely**. Set `GROQ_MODEL` to change the model (default: `llama-3.1-8b-instant`).

Client-side settings (Claude API key, model, chart colors, UI limits) live in `config/config.json`.

## Architecture

### Two operating modes

**API mode** (default) — The browser calls the Claude API directly using the key stored in `localStorage`. `js/claude-api.js` sends the full column profile + user prompt in one shot and expects back a complete dashboard JSON spec with all column names resolved.

**Power BI mode** — Generates a `.pbit` (Power BI Template) file. The pipeline runs entirely on the Node server:
1. `server/index.js` `POST /api/build-powerbi` receives CSV data + user prompt
2. Routes to `groq-agent.js` (if `GROQ_API_KEY` set) or `ollama-agent.js`
3. The LLM is asked for **titles and chart types only** — no column names. This is intentional because small models (llama3.2:1b) hallucinate column names.
4. `processOllamaContent()` in `ollama-agent.js` resolves all column bindings server-side
5. A cascade of `_inject*` fixup functions corrects LLM failures for specific chart types
6. `pbit-builder.js` generates the ZIP-structured `.pbit` file

### The `_inject*` pattern in `ollama-agent.js`

This is the most important pattern in the codebase. Because small LLMs reliably ignore axis/orientation/stack-mode instructions, every special chart type has a dedicated injection function:

| Function | Triggers on |
|---|---|
| `_injectBarChartIfRequested` | bar/column chart keywords + axis or "by" patterns |
| `_injectStackedBarIfRequested` | "stacked" + bar/column keywords |
| `_injectStackedAreaIfRequested` | "stacked area" |
| `_injectMatrixChart` | "matrix", "cross-tab", "pivot table" |
| `_injectComboIfRequested` | "combo", "line and bar/column" |
| `_injectPieChartIfRequested` | pie/donut keywords |
| `_injectMapIfRequested` | map/choropleth keywords |
| `_injectGaugeIfRequested` | gauge/speedometer/indicator keywords |
| `_injectMultiRowCardIfRequested` | "multi-row card" |
| `_injectHistogramIfRequested` | histogram/distribution keywords |
| `_injectTreemapIfRequested` | treemap keywords |
| `_injectHierarchyIfRequested` | hierarchy/icicle/org chart keywords |
| `_injectSankeyIfRequested` | sankey keywords |
| `_injectSlicerIfRequested` | slicer keywords — adds to `filters[]`, not `charts[]` |
| `_injectComparisonKPIs` | "comparison against X", "secondary indicator for Y" |

These run inside `processOllamaContent()` after the LLM response is parsed. They either fix an existing chart entry in place or push a new one.

### Column resolution (`ollama-agent.js`)

Two main resolvers:
- `titleToKpi(title, columns, colTypes)` — maps a KPI card title to `{column, aggregation, format}`
- `titleToChart(title, type, idx, columns, colTypes)` — maps a chart title + type to `{x_column, y_column, aggregation}`

Both use `_findBestCol(hint, columns, colTypes, preferNumeric)` which tries: exact match → substring → word-by-word → `SYNONYM_GROUPS` expansion (a large domain vocabulary table). `_goodXCols()` returns string columns filtered of raw IDs and high-cardinality free-text, used as safe x-axis candidates.

### Frontend script loading order

Declared in `index.html`, must remain:
```
state.js → ui-helpers.js → file-parser.js → data-processor.js
→ claude-api.js → chart-renderer.js → dashboard.js → app.js
```
Plus: `auto-dashboard.js`, `prompt-generator.js`, `data-joiner.js`, `pbix-exporter.js`, `ollama-client.js`

`AppState` (in `state.js`) is the single global store — all modules read/write it directly.

### `dashboard.js` mirrors server logic

`dashboard.js` contains client-side versions of the injection functions (e.g. `_injectTableIfRequested`, `_injectSlicerIfRequested`) for the browser-rendered dashboard (non-Power BI mode). When fixing a server-side injection bug, check if the same logic exists client-side and fix both.

### RAG engine (`server/chart-rag.js`)

Indexes chart-type descriptions using Ollama embeddings (or TF-IDF fallback) and caches to `server/chart-embeddings.json`. Used by `GET /api/rag/charts` and `POST /api/rag/search`. Initialised non-blocking at server startup.

### `.pbit` file format (`server/pbit-builder.js`)

A `.pbit` is a ZIP containing: `DataModelSchema` (column types, DAX measures), `Mashup` (nested ZIP with M query / embedded CSV), `Report/Layout` (visual positions and config), `Metadata`, `[Content_Types].xml`. DAX measures are generated by `buildDaxMeasures()` in `ollama-agent.js`.

## Key design decisions

- **LLM asked for titles/types only, never column names.** All column binding is deterministic server-side code. This makes the output predictable regardless of model quality.
- **`_inject*` functions always overwrite LLM output.** If a user asks for a bar chart with "Department on Y-axis", the inject function ignores what Ollama put in `x_column`/`y_column` and rewrites them correctly.
- **Groq takes priority over Ollama** when `GROQ_API_KEY` is set. The Groq agent calls `processOllamaContent` for post-processing, so the same column resolution and injection logic applies to both paths.
- **`colTypes`** values are `'number'`, `'string'`, or `'date'`. Many column resolution decisions branch on this.
