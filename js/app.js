/**
 * app.js — Entry point and event wiring.
 * Script loading order: state → ui-helpers → file-parser → data-processor
 *                       → claude-api → chart-renderer → dashboard → app
 */

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  restoreSettings();
  refreshAiBadge();
  initUploadModal();
  wireEvents();
  restoreMode();
  console.info('AI Dashboard Builder ready.');
});

function restoreMode() {
  const saved = localStorage.getItem('dash_mode') || 'api';
  const mode  = saved === 'free' ? 'api' : saved; // migrate away from removed free mode
  AppState.mode = mode;
  document.querySelectorAll('.mseg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  applyModeUI(mode);
}

function applyModeUI(mode) {
  const isPowerBI = mode === 'powerbi';

  /* ── Enable / disable settings fields ── */
  _syncSettingsFields(isPowerBI);

  /* ── Badge & status bar ── */
  refreshAiBadge();

  /* ── Prompt area ── */
  const input = document.getElementById('prompt-input');
  const hint  = document.querySelector('.prompt-hint');
  if (input) {
    if (isPowerBI) {
      input.placeholder = 'Describe your Power BI dashboard… e.g. "Create a sales dashboard with KPI cards for total revenue, orders and margin, bar chart for revenue by region, monthly trend line, and donut for product mix"';
    } else {
      input.placeholder = 'Describe your dashboard… e.g. "Create a sales dashboard with bar charts for revenue by region, monthly trend line, pie chart for product mix, and KPI cards for total revenue, orders, and average order value"';
    }
  }
  if (hint) {
    if (isPowerBI) {
      hint.textContent = 'Power BI Mode: generates a .pbit file via MCP server · start with npm start · Ctrl+Enter to build';
    } else {
      hint.textContent = 'Ctrl+Enter to build · After building, describe changes and click Refine';
    }
  }
}

function _syncSettingsFields(isPowerBI) {
  const keyEl    = document.getElementById('s-apikey');
  const modelEl  = document.getElementById('s-model');
  const testBtn  = document.getElementById('btn-test-key');
  const apiRow   = document.getElementById('settings-api-row');
  const modelRow = document.getElementById('settings-model-row');
  const mcpRow    = document.getElementById('settings-mcp-row');
  const ollamaRow = document.getElementById('settings-ollama-row');

  if (keyEl)    { keyEl.disabled    = isPowerBI; keyEl.style.opacity    = isPowerBI ? '.35' : '1'; }
  if (modelEl)  { modelEl.disabled  = isPowerBI; modelEl.style.opacity  = isPowerBI ? '.35' : '1'; }
  if (testBtn)  { testBtn.disabled  = isPowerBI; testBtn.style.opacity  = isPowerBI ? '.35' : '1'; }
  if (apiRow)   apiRow.style.opacity   = isPowerBI ? '.45' : '1';
  if (modelRow) modelRow.style.opacity = isPowerBI ? '.45' : '1';

  // Show MCP + Ollama rows only in Power BI mode
  if (mcpRow)    mcpRow.style.display    = isPowerBI ? '' : 'none';
  if (ollamaRow) ollamaRow.style.display = isPowerBI ? '' : 'none';
}

async function testMcpConnection() {
  const urlEl    = document.getElementById('s-mcp-url');
  const resultEl = document.getElementById('mcp-test-result');
  const badge    = document.getElementById('mcp-status-badge');
  const url      = (urlEl?.value || 'http://localhost:3001').replace(/\/$/, '');

  if (resultEl) { resultEl.textContent = 'Testing server…'; resultEl.style.color = 'var(--mut)'; }
  if (badge)    { badge.textContent = ''; }

  try {
    const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.llmMode === 'groq') {
        if (data.groqReady) {
          const msg = `✓ Server OK · Cloud LLM ready (Groq ${data.groqModel || 'llama-3.1-8b-instant'}) — no local setup needed`;
          if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--grn)'; }
          if (badge)    { badge.textContent = '✓ Groq ready'; badge.style.color = 'var(--grn)'; }
        } else {
          const msg = `⚠ Server OK but Groq unreachable — check GROQ_API_KEY in Render env vars`;
          if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--acc)'; }
          if (badge)    { badge.textContent = '⚠ Groq error'; badge.style.color = 'var(--acc)'; }
        }
      } else {
        // Local Ollama mode
        if (!data.ollamaReachable) {
          const msg = `⚠ Server OK · Local Ollama not running — run: ollama serve`;
          if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--acc)'; }
          if (badge)    { badge.textContent = '⚠ no Ollama'; badge.style.color = 'var(--acc)'; }
        } else if (!data.modelLoaded) {
          const msg = `⚠ Ollama running but model missing — run: ollama pull ${data.model || 'llama3.2'}`;
          if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--acc)'; }
          if (badge)    { badge.textContent = '⚠ no model'; badge.style.color = 'var(--acc)'; }
        } else {
          const msg = `✓ Server OK · Local Ollama ready (${data.model})`;
          if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--grn)'; }
          if (badge)    { badge.textContent = '✓ ready'; badge.style.color = 'var(--grn)'; }
        }
      }
    } else {
      if (resultEl) { resultEl.textContent = `✗ Server returned ${resp.status}`; resultEl.style.color = 'var(--red)'; }
      if (badge)    { badge.textContent = '✗ error'; badge.style.color = 'var(--red)'; }
    }
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Timeout — is the server running? Run: npm start' : 'Cannot reach server — run: npm start';
    if (resultEl) { resultEl.textContent = `✗ ${msg}`; resultEl.style.color = 'var(--red)'; }
    if (badge)    { badge.textContent = '✗ offline'; badge.style.color = 'var(--red)'; }
  }
}

async function testOllamaConnection() {
  const resultEl = document.getElementById('ollama-test-result');
  const badge    = document.getElementById('ollama-status-badge');

  if (resultEl) { resultEl.textContent = 'Testing Ollama…'; resultEl.style.color = 'var(--mut)'; }
  if (badge)    { badge.textContent = ''; }

  /* Persist whatever is currently typed before testing */
  const ouEl = document.getElementById('s-ollama-url');
  const omEl = document.getElementById('s-ollama-model');
  if (ouEl?.value.trim())  localStorage.setItem('ollama_url',   ouEl.value.trim());
  if (omEl?.value.trim())  localStorage.setItem('ollama_model', omEl.value.trim());

  try {
    const result = await checkOllamaFromBrowser();

    if (result.httpsBlock) {
      const msg = `⚠ HTTPS page cannot call HTTP Ollama — configure an HTTPS Ollama URL (ngrok / Cloudflare Tunnel)`;
      if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--acc)'; }
      if (badge)    { badge.textContent = '⚠ HTTPS block'; badge.style.color = 'var(--acc)'; }
      return;
    }
    const model = result.model || 'llama3.2';
    if (!result.modelLoaded) {
      const msg = `⚠ Ollama running but model "${model}" not found — run: ollama pull ${model}`;
      if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--acc)'; }
      if (badge)    { badge.textContent = '⚠ no model'; badge.style.color = 'var(--acc)'; }
    } else {
      const msg = `✓ Ollama reachable · model "${model}" ready`;
      if (resultEl) { resultEl.textContent = msg; resultEl.style.color = 'var(--grn)'; }
      if (badge)    { badge.textContent = '✓ ready'; badge.style.color = 'var(--grn)'; }
    }
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Timeout — run: ollama serve' : `Cannot reach Ollama — run: ollama serve`;
    if (resultEl) { resultEl.textContent = `✗ ${msg}`; resultEl.style.color = 'var(--red)'; }
    if (badge)    { badge.textContent = '✗ offline'; badge.style.color = 'var(--red)'; }
  }
}

function wireEvents() {
  /* ── Header buttons ─────────────────────────────────── */
  document.getElementById('btn-upload').addEventListener('click', () => {
    _pendingFiles = [];
    document.getElementById('uprev').classList.add('hidden');
    document.getElementById('ustatus').textContent = '';
    document.getElementById('btn-import').disabled = true;
    document.getElementById('btn-import').textContent = 'Import Dataset';
    openModal('modal-upload');
  });

  document.getElementById('btn-join-tables').addEventListener('click', openJoinModal);

  document.getElementById('btn-back-to-join').addEventListener('click', () => {
    closeModal('modal-col-select');
    if (_pendingJoinResult) openModal('modal-join');
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    restoreSettings();
    _syncSettingsFields(AppState.mode === 'powerbi');
    openModal('modal-settings');
  });

  document.getElementById('btn-clear-dash').addEventListener('click', () => {
    if (AppState.currentSpec && !confirm('Clear the current dashboard?')) return;
    clearDashboard();
  });

  document.getElementById('btn-download-pbix').addEventListener('click', () => {
    // If a server-built pbit exists use it, otherwise fall back to client-side JSZip export
    if (AppState.lastPbitBlob) downloadLastPbit();
    else exportAsPBIX();
  });

  /* ── Mode toggle ─────────────────────────────────────── */
  document.querySelectorAll('.mseg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.mode = btn.dataset.mode;
      document.querySelectorAll('.mseg-btn').forEach(b => b.classList.toggle('active', b === btn));
      localStorage.setItem('dash_mode', AppState.mode);
      applyModeUI(AppState.mode);
    });
  });

  /* ── Build / Refine ──────────────────────────────────── */
  document.getElementById('btn-build').addEventListener('click', buildDashboard);
  document.getElementById('btn-refine').addEventListener('click', refineDashboard);
  document.getElementById('btn-prompt-guide').addEventListener('click', () => openModal('modal-prompt-guide'));
  document.getElementById('btn-generate-prompt').addEventListener('click', generateDashboardPrompt);

  /* ── Ctrl+Enter shortcut ─────────────────────────────── */
  document.getElementById('prompt-input').addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (AppState.currentSpec) refineDashboard();
      else buildDashboard();
    }
  });

  /* ── Panel tabs ──────────────────────────────────────── */
  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.addEventListener('click', () => switchPanelTab(btn.dataset.tab));
  });

  /* ── Filter tab clear-all ────────────────────────────── */
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    AppState.filters = {};
    updateFilterStrip();
    renderSlicers(AppState.currentSpec);
    if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
  });

  /* ── Import button ───────────────────────────────────── */
  document.getElementById('btn-import').addEventListener('click', importFile);

  /* ── Settings save & test key ────────────────────────── */
  document.getElementById('btn-save-s').addEventListener('click', saveSettings);
  document.getElementById('btn-test-key').addEventListener('click', testApiKey);
  document.getElementById('btn-test-mcp').addEventListener('click', testMcpConnection);
  document.getElementById('btn-test-ollama')?.addEventListener('click', testOllamaConnection);

  /* ── Modal close buttons ─────────────────────────────── */
  document.querySelectorAll('.mclose, [data-m]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mid = btn.dataset.m;
      if (mid) closeModal(mid);
    });
  });

  /* ── Close modal on overlay click ───────────────────── */
  document.querySelectorAll('.overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  /* ── Close filter dropdowns on outside click ─────────── */
  document.addEventListener('click', e => {
    if (!e.target.closest('.fb-multi')) {
      document.querySelectorAll('.fb-drop').forEach(d => d.classList.add('hidden'));
    }
  });
}
