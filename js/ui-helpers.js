/* ══ Loading overlay ══════════════════════════════════════ */

function showLoading(msg, sub) {
  document.getElementById('loading-msg').textContent = msg || 'Processing…';
  document.getElementById('loading-sub').textContent = sub || '';
  document.getElementById('loading-overlay').classList.remove('hidden');
  document.getElementById('btn-build').disabled = true;
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
  document.getElementById('btn-build').disabled = false;
}

/* ══ Toast notifications ══════════════════════════════════ */

function toast(msg, type) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  const cls = type === 'success' ? 'ok' : type === 'error' ? 'err' : 'warn';
  el.className = `toast ${cls}`;
  el.textContent = msg;
  container.appendChild(el);
  const dur = AppState.config?.ui?.toastDurationMs ?? 4500;
  setTimeout(() => el.remove(), dur);
}

/* ══ Status bar ═══════════════════════════════════════════ */

function setStatus(msg) {
  document.getElementById('sb').textContent = msg;
}

/* ══ Panel tabs ═══════════════════════════════════════════ */

function switchPanelTab(name) {
  document.querySelectorAll('.panel-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  ['data-tab', 'filter-tab', 'log-tab'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  const tabMap = { data: 'data-tab', filters: 'filter-tab', log: 'log-tab' };
  const target = document.getElementById(tabMap[name]);
  if (target) target.classList.remove('hidden');
}

/* ══ AI badge ═════════════════════════════════════════════ */

function refreshAiBadge() {
  const badge = document.getElementById('ai-conn-badge');
  const label = document.getElementById('ai-mode-label');

  if (AppState.mode === 'free') {
    if (badge) { badge.textContent = '⚡ Free Mode'; badge.style.color = '#4ade80'; }
    if (label) { label.textContent = '⚡ Free Mode — no API key needed'; label.style.opacity = '1'; }
    return;
  }

  if (AppState.mode === 'powerbi') {
    const serverUrl = localStorage.getItem('mcp_server_url') || 'http://localhost:3001';
    if (badge) { badge.textContent = '⚡ Power BI Mode'; badge.style.color = '#f59e0b'; }
    if (label) { label.textContent = `Power BI Mode · MCP server: ${serverUrl}`; label.style.opacity = '1'; }
    return;
  }

  const key = (localStorage.getItem('claude_api_key') || '').replace(/\s/g, '');
  if (key) {
    const model = localStorage.getItem('claude_model') || 'claude-sonnet-4-6';
    const shortModel = model.replace('claude-', '').replace(/-\d{8}$/, '');
    if (badge) { badge.textContent = `● AI: ${shortModel}`; badge.style.color = '#4caf50'; }
    if (label) { label.textContent = `Claude AI · ${shortModel}`; label.style.opacity = '1'; }
  } else {
    if (badge) { badge.textContent = '○ No API key'; badge.style.color = '#7a8099'; }
    if (label) { label.textContent = 'No API key — enter one in Settings'; label.style.opacity = '.6'; }
  }
}

/* ══ Dataset pill ════════════════════════════════════════ */

function updateDatasetPill(name) {
  const pill = document.getElementById('dataset-pill');
  if (name) {
    pill.textContent = name;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

/* ══ Log entries ════════════════════════════════════════ */

function addLogEntry(role, text) {
  const log = document.getElementById('history-log');
  const el = document.createElement('div');
  el.className = `log-entry ${role}`;
  const label = role === 'user' ? '👤 You' : '🤖 Claude';
  const preview = text.length > 300 ? text.slice(0, 300) + '…' : text;
  el.innerHTML = `<div class="log-role">${label}</div><div>${preview}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

/* ══ Active filter chips ████████████████████████████████ */

function updateFilterStrip() {
  const chips = document.getElementById('active-chips');
  const rowCount = document.getElementById('row-count');
  const active = Object.entries(AppState.filters).filter(([, v]) => v && v !== 'all');

  chips.innerHTML = active.map(([col, val]) =>
    `<span class="ach">${col}: <strong>${val}</strong>
      <span style="cursor:pointer;margin-left:4px;opacity:.6" onclick="clearFilter('${col}')">✕</span>
    </span>`
  ).join('');

  const total = AppState.rawData?.length || 0;
  const filtered = getFilteredData().length;
  rowCount.textContent = active.length ? `${filtered.toLocaleString()} / ${total.toLocaleString()} rows` : '';
}

function clearFilter(col) {
  delete AppState.filters[col];
  updateFilterStrip();
  renderSlicers(AppState.currentSpec);
  if (AppState.currentSpec) renderDashboard(AppState.currentSpec);
}

/* ══ Modal helpers ════════════════════════════════════════ */

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
