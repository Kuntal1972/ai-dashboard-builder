/**
 * data-joiner.js — Visual join editor + hash-join engine
 */

let _pendingJoinResult = null;

/* ── Join state ─────────────────────────────────────────── */
const _jm = {
  leftTableId:  null,
  rightTableId: null,
  connections:  [],   // [{id, leftCol, rightCol}]
  dragging:     null, // {fromSide, fromCol, svgX, svgY}
  nextId:       0,
};

const _JM_COLORS = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2',
  '#59a14f','#edc948','#b07aa1','#ff9da7',
  '#9c755f','#bab0ac'
];

/* ── Open modal ─────────────────────────────────────────── */

function openJoinModal() {
  if (AppState.datasets.length < 2) {
    toast('Load at least 2 data files to join', 'warn');
    return;
  }
  _jm.leftTableId  = AppState.datasets[0].id;
  _jm.rightTableId = AppState.datasets[1].id;
  _jm.connections  = [];
  _jm.dragging     = null;
  _jm.nextId       = 0;

  _jmRenderBody();
  openModal('modal-join');

  requestAnimationFrame(() => {
    _jmBindEvents();
    _jmDrawConnections();
  });
}

/* ── Render modal body ──────────────────────────────────── */

function _jmRenderBody() {
  const body = document.getElementById('jm-body');

  const leftOpts  = _jmTableOptions(_jm.leftTableId);
  const rightOpts = _jmTableOptions(_jm.rightTableId);

  body.innerHTML = `
    <div class="jm-visual-wrapper" id="jm-visual-wrapper">

      <!-- Left table panel -->
      <div class="jm-panel" id="jm-left-panel">
        <div class="jm-panel-hdr">
          <select class="jm-panel-sel" id="jm-left-sel"
                  onchange="jmSelectTable('left',this.value)">${leftOpts}</select>
          <div class="jm-panel-meta" id="jm-left-meta"></div>
        </div>
        <div class="jm-panel-cols" id="jm-left-cols"></div>
      </div>

      <!-- Center gap (hint text, decorative) -->
      <div class="jm-gap">
        <div class="jm-gap-hint">drag ● to connect</div>
      </div>

      <!-- Right table panel -->
      <div class="jm-panel jm-right-panel" id="jm-right-panel">
        <div class="jm-panel-hdr">
          <select class="jm-panel-sel" id="jm-right-sel"
                  onchange="jmSelectTable('right',this.value)">${rightOpts}</select>
          <div class="jm-panel-meta" id="jm-right-meta"></div>
        </div>
        <div class="jm-panel-cols" id="jm-right-cols"></div>
      </div>

      <!-- SVG overlay — draws connection lines above everything -->
      <svg class="jm-svg" id="jm-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="jm-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
      </svg>
    </div>

    <!-- Conditions list -->
    <div class="jm-conds-section">
      <div class="jm-section-hdr">
        Join Conditions
        <span class="jm-cond-badge" id="jm-cond-badge"></span>
      </div>
      <div id="jm-cond-list"></div>
      <div id="jm-cond-empty" class="jm-cond-empty">
        Drag a <strong>●</strong> port from any column on the left to a column on the right to create a join condition
      </div>
    </div>

    <!-- Join type -->
    <div class="jm-join-type">
      <span class="jm-type-label">Join Type:</span>
      <label><input type="radio" name="join-type" value="inner" checked />
        Inner &mdash; matching rows only</label>
      <label style="margin-left:16px"><input type="radio" name="join-type" value="left" />
        Left &mdash; all rows from first file</label>
    </div>`;

  _jmRenderPanel('left');
  _jmRenderPanel('right');
}

function _jmTableOptions(selectedId) {
  return AppState.datasets.map(ds =>
    `<option value="${ds.id}" ${ds.id === selectedId ? 'selected' : ''}>${_jmShort(ds.fileName)}</option>`
  ).join('');
}

function _jmShort(name) {
  return name.length > 24 ? name.slice(0, 22) + '…' : name;
}

/* ── Panel rendering ────────────────────────────────────── */

function jmSelectTable(side, id) {
  if (side === 'left') _jm.leftTableId = id;
  else                 _jm.rightTableId = id;
  _jmRenderPanel(side);
  requestAnimationFrame(_jmDrawConnections);
}

function _jmRenderPanel(side) {
  const dsId = side === 'left' ? _jm.leftTableId : _jm.rightTableId;
  const ds   = AppState.datasets.find(d => d.id === dsId);
  if (!ds) return;

  const metaEl = document.getElementById(`jm-${side}-meta`);
  const colsEl = document.getElementById(`jm-${side}-cols`);
  if (!metaEl || !colsEl) return;

  metaEl.textContent = `${ds.rawData.length.toLocaleString()} rows · ${ds.columns.length} cols`;

  const connectedSet = new Set(
    _jm.connections.map(c => side === 'left' ? c.leftCol : c.rightCol)
  );

  colsEl.innerHTML = ds.columns.map(c => {
    const t      = ds.colTypes[c];
    const cls    = t === 'number' ? 'num' : t === 'date' ? 'date' : 'cat';
    const badge  = t === 'number' ? 'N'   : t === 'date' ? 'D'   : 'T';
    const linked = connectedSet.has(c) ? ' jm-connected' : '';
    const safeC  = c.replace(/&/g,'&amp;').replace(/"/g,'&quot;');

    // Port on RIGHT edge for left panel, LEFT edge for right panel
    const port = `<div class="jm-port" title="Drag to connect"></div>`;
    const inner = side === 'left'
      ? `<span class="jm-col-badge ${cls}">${badge}</span><span class="jm-col-name">${safeC}</span>${port}`
      : `${port}<span class="jm-col-badge ${cls}">${badge}</span><span class="jm-col-name">${safeC}</span>`;

    return `<div class="jm-vcol-item${linked}" data-col="${safeC}" data-side="${side}">${inner}</div>`;
  }).join('');

  // Redraw connections when this panel scrolls
  colsEl.onscroll = _jmDrawConnections;
}

/* ── SVG drawing ────────────────────────────────────────── */

function _jmGetPortPos(side, col) {
  const wrapper = document.getElementById('jm-visual-wrapper');
  if (!wrapper) return null;
  const wr = wrapper.getBoundingClientRect();
  let port = null;
  for (const item of wrapper.querySelectorAll(`.jm-vcol-item[data-side="${side}"]`)) {
    if (item.dataset.col === col) { port = item.querySelector('.jm-port'); break; }
  }
  if (!port) return null;
  const pr = port.getBoundingClientRect();
  return { x: pr.left + pr.width / 2 - wr.left, y: pr.top + pr.height / 2 - wr.top };
}

function _jmDrawConnections() {
  const svg     = document.getElementById('jm-svg');
  const wrapper = document.getElementById('jm-visual-wrapper');
  if (!svg || !wrapper) return;

  // Remove previous lines/temp (keep <defs>)
  svg.querySelectorAll('.jm-line-g, .jm-temp-path').forEach(e => e.remove());

  // Permanent connections
  _jm.connections.forEach((conn, i) => {
    const from = _jmGetPortPos('left',  conn.leftCol);
    const to   = _jmGetPortPos('right', conn.rightCol);
    if (!from || !to) return;
    svg.appendChild(_jmMakeLine(from, to, _JM_COLORS[i % _JM_COLORS.length], conn.id));
  });

  // Temp dragging line
  if (_jm.dragging) {
    const { fromSide, fromCol, svgX, svgY } = _jm.dragging;
    const from = _jmGetPortPos(fromSide, fromCol);
    if (from) {
      const [x1, y1, x2, y2] = fromSide === 'left'
        ? [from.x, from.y, svgX, svgY]
        : [svgX, svgY, from.x, from.y];
      const path = _svgEl('path', {
        class:              'jm-temp-path',
        d:                  _jmBez(x1, y1, x2, y2),
        stroke:             'var(--blue)',
        'stroke-width':     '2',
        'stroke-dasharray': '6,4',
        fill:               'none',
        opacity:            '0.75',
      });
      svg.appendChild(path);
    }
  }
}

function _jmBez(x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2;
  return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
}

function _jmMakeLine(from, to, color, connId) {
  const g = _svgEl('g', { class: 'jm-line-g' });

  // Line
  g.appendChild(_svgEl('path', {
    d:            _jmBez(from.x, from.y, to.x, to.y),
    stroke:       color,
    'stroke-width': '2.5',
    fill:         'none',
    opacity:      '0.9',
  }));

  // Endpoint dots
  g.appendChild(_jmDot(from.x, from.y, color));
  g.appendChild(_jmDot(to.x,   to.y,   color));

  // Delete button at midpoint
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const del = _svgEl('g', { class: 'jm-del-btn-svg', style: 'pointer-events:all;cursor:pointer' });
  del.addEventListener('click', () => jmRemoveConnection(connId));

  del.appendChild(_svgEl('circle', {
    cx: mx, cy: my, r: '9',
    fill: color, stroke: 'var(--bg)', 'stroke-width': '2.5',
  }));
  const txt = _svgEl('text', {
    x: mx, y: String(my + 4),
    'text-anchor': 'middle',
    fill: '#fff',
    'font-size': '13',
    'font-family': 'sans-serif',
    style: 'pointer-events:none',
  });
  txt.textContent = '×';
  del.appendChild(txt);
  g.appendChild(del);

  return g;
}

function _jmDot(x, y, color) {
  return _svgEl('circle', {
    cx: x, cy: y, r: '4',
    fill: color, stroke: 'var(--bg)', 'stroke-width': '2',
  });
}

function _svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/* ── Mouse drag ─────────────────────────────────────────── */

function _jmBindEvents() {
  const wrapper = document.getElementById('jm-visual-wrapper');
  if (!wrapper) return;
  wrapper.addEventListener('mousedown', _jmMouseDown);
  document.addEventListener('mousemove', _jmMouseMove);
  document.addEventListener('mouseup',   _jmMouseUp);
}

function _jmUnbindEvents() {
  const wrapper = document.getElementById('jm-visual-wrapper');
  if (wrapper) wrapper.removeEventListener('mousedown', _jmMouseDown);
  document.removeEventListener('mousemove', _jmMouseMove);
  document.removeEventListener('mouseup',   _jmMouseUp);
}

function _jmMouseDown(e) {
  const port = e.target.closest('.jm-port');
  if (!port) return;
  e.preventDefault();
  const item    = port.closest('.jm-vcol-item');
  const col     = item.dataset.col;
  const side    = item.dataset.side;
  const wrapper = document.getElementById('jm-visual-wrapper');
  const wr      = wrapper.getBoundingClientRect();
  _jm.dragging  = { fromSide: side, fromCol: col, svgX: e.clientX - wr.left, svgY: e.clientY - wr.top };
  document.body.style.userSelect = 'none';
  _jmDrawConnections();
}

function _jmMouseMove(e) {
  if (!_jm.dragging) return;
  const wrapper = document.getElementById('jm-visual-wrapper');
  if (!wrapper) return;
  const wr = wrapper.getBoundingClientRect();
  _jm.dragging.svgX = e.clientX - wr.left;
  _jm.dragging.svgY = e.clientY - wr.top;

  // Highlight valid drop targets
  const oppSide = _jm.dragging.fromSide === 'left' ? 'right' : 'left';
  wrapper.querySelectorAll(`.jm-vcol-item[data-side="${oppSide}"]`).forEach(el => {
    const r = el.getBoundingClientRect();
    const over = e.clientX >= r.left && e.clientX <= r.right &&
                 e.clientY >= r.top  && e.clientY <= r.bottom;
    el.classList.toggle('jm-drag-over', over);
  });

  _jmDrawConnections();
}

function _jmMouseUp(e) {
  if (!_jm.dragging) return;
  const { fromSide, fromCol } = _jm.dragging;
  _jm.dragging = null;
  document.body.style.userSelect = '';

  // Clear highlights
  document.querySelectorAll('.jm-drag-over').forEach(el => el.classList.remove('jm-drag-over'));

  // Find target column item in opposite panel
  const oppSide    = fromSide === 'left' ? 'right' : 'left';
  const targetItem = document.elementFromPoint(e.clientX, e.clientY)
                      ?.closest(`.jm-vcol-item[data-side="${oppSide}"]`);

  if (targetItem) {
    const targetCol = targetItem.dataset.col;
    const leftCol   = fromSide === 'left' ? fromCol    : targetCol;
    const rightCol  = fromSide === 'left' ? targetCol  : fromCol;

    const isDup = _jm.connections.some(c => c.leftCol === leftCol && c.rightCol === rightCol);
    if (!isDup) {
      _jm.connections.push({ id: `c${_jm.nextId++}`, leftCol, rightCol });
      _jmRenderPanel('left');
      _jmRenderPanel('right');
      _jmRenderConditions();
    }
  }

  _jmDrawConnections();
}

/* ── Condition list ─────────────────────────────────────── */

function jmRemoveConnection(id) {
  _jm.connections = _jm.connections.filter(c => c.id !== id);
  _jmRenderPanel('left');
  _jmRenderPanel('right');
  _jmRenderConditions();
  requestAnimationFrame(_jmDrawConnections);
}

function _jmRenderConditions() {
  const list  = document.getElementById('jm-cond-list');
  const empty = document.getElementById('jm-cond-empty');
  const badge = document.getElementById('jm-cond-badge');
  if (!list) return;

  const leftDs  = AppState.datasets.find(d => d.id === _jm.leftTableId);
  const rightDs = AppState.datasets.find(d => d.id === _jm.rightTableId);
  const lName   = _jmShort(leftDs?.fileName  || 'Table 1');
  const rName   = _jmShort(rightDs?.fileName || 'Table 2');

  if (empty) empty.style.display = _jm.connections.length ? 'none' : '';
  if (badge) badge.textContent   = _jm.connections.length ? String(_jm.connections.length) : '';

  list.innerHTML = _jm.connections.map((conn, i) => {
    const color = _JM_COLORS[i % _JM_COLORS.length];
    return `
      <div class="jm-cond-chip">
        <span class="jm-cond-dot" style="background:${color}"></span>
        <span class="jm-cond-text">
          <strong>${lName}</strong>.<em>${conn.leftCol}</em>
          <span class="jm-cond-eq">=</span>
          <strong>${rName}</strong>.<em>${conn.rightCol}</em>
        </span>
        <button class="jm-cond-rm" onclick="jmRemoveConnection('${conn.id}')" title="Remove">✕</button>
      </div>`;
  }).join('');
}

/* ── Execute join ────────────────────────────────────────── */

function runJoin() {
  if (!_jm.connections.length) {
    toast('Draw at least one connection between columns', 'warn');
    return;
  }
  if (_jm.leftTableId === _jm.rightTableId) {
    toast('Select different tables on left and right', 'warn');
    return;
  }

  const conditions = _jm.connections.map(conn => ({
    leftTableId:  _jm.leftTableId,
    leftCol:      conn.leftCol,
    rightTableId: _jm.rightTableId,
    rightCol:     conn.rightCol,
  }));

  const joinType = document.querySelector('input[name="join-type"]:checked')?.value || 'inner';

  try {
    const result = _executeJoin(AppState.datasets, conditions, joinType);
    if (!result.rawData.length) {
      toast('Join produced 0 rows — check your join columns', 'warn');
      return;
    }
    _jmUnbindEvents();
    _pendingJoinResult = result;
    closeModal('modal-join');
    _openColumnSelector(result);
  } catch (err) {
    toast(`Join error: ${err.message}`, 'error');
  }
}

/* ── Column Selector (shuttle UI) ───────────────────────── */

// State: two ordered arrays of column names
const _cs = {
  avail:  [],   // left panel — not yet selected
  chosen: [],   // right panel — will be kept
  colTypes: {},
  activeAvail:  new Set(),  // highlighted in left
  activeChosen: new Set(),  // highlighted in right
};

function _openColumnSelector(result) {
  _cs.colTypes  = result.colTypes;
  _cs.avail     = [...result.columns];
  _cs.chosen    = [];
  _cs.activeAvail.clear();
  _cs.activeChosen.clear();

  document.getElementById('cs-row-count').textContent =
    `${result.rawData.length.toLocaleString()} rows · ${result.columns.length} columns`;
  document.getElementById('cs-sel-count').textContent = '';

  _csRender();
  openModal('modal-col-select');
}

function _csRender() {
  _csRenderList('cs-avail-list',  _cs.avail,   _cs.activeAvail);
  _csRenderList('cs-chosen-list', _cs.chosen,  _cs.activeChosen);
  document.getElementById('cs-avail-count').textContent  = String(_cs.avail.length);
  document.getElementById('cs-chosen-count').textContent = String(_cs.chosen.length);
  const selInfo = document.getElementById('cs-sel-count');
  if (selInfo) selInfo.textContent = _cs.chosen.length
    ? `${_cs.chosen.length} column${_cs.chosen.length > 1 ? 's' : ''} selected`
    : '';
}

function _csRenderList(elId, cols, activeSet) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = cols.map(c => {
    const t     = _cs.colTypes[c];
    const cls   = t === 'number' ? 'num' : t === 'date' ? 'date' : 'cat';
    const badge = t === 'number' ? 'N'   : t === 'date' ? 'D'    : 'T';
    const active = activeSet.has(c) ? ' cs-active' : '';
    const safe  = c.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    return `<div class="cs-col-row ${cls}${active}" data-col="${safe}">
      <span class="cs-col-badge">${badge}</span>
      <span class="cs-col-name">${safe}</span>
    </div>`;
  }).join('');
}

function csListClick(e, side) {
  const row = e.target.closest('.cs-col-row');
  if (!row) return;
  const col = row.dataset.col;
  const activeSet = side === 'avail' ? _cs.activeAvail : _cs.activeChosen;

  if (e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd: toggle individual
    if (activeSet.has(col)) activeSet.delete(col);
    else activeSet.add(col);
  } else if (e.shiftKey) {
    // Shift: range select
    const list = side === 'avail' ? _cs.avail : _cs.chosen;
    const last  = [...activeSet].pop();
    const lastIdx = last ? list.indexOf(last) : -1;
    const thisIdx = list.indexOf(col);
    if (lastIdx >= 0) {
      const [lo, hi] = [Math.min(lastIdx, thisIdx), Math.max(lastIdx, thisIdx)];
      list.slice(lo, hi + 1).forEach(c => activeSet.add(c));
    } else {
      activeSet.add(col);
    }
  } else {
    // Plain click: exclusive select
    activeSet.clear();
    activeSet.add(col);
  }

  _csRender();
}

function csMoveSel(dir) {
  if (dir === 'right') {
    const moving = _cs.avail.filter(c => _cs.activeAvail.has(c));
    if (!moving.length) return;
    _cs.avail   = _cs.avail.filter(c => !_cs.activeAvail.has(c));
    _cs.chosen  = [..._cs.chosen, ...moving];
    _cs.activeAvail.clear();
    _cs.activeChosen = new Set(moving);
  } else {
    const moving = _cs.chosen.filter(c => _cs.activeChosen.has(c));
    if (!moving.length) return;
    _cs.chosen  = _cs.chosen.filter(c => !_cs.activeChosen.has(c));
    _cs.avail   = [..._cs.avail, ...moving];
    _cs.activeChosen.clear();
    _cs.activeAvail = new Set(moving);
  }
  _csRender();
}

function csMoveAll(dir) {
  if (dir === 'right') {
    _cs.chosen  = [..._cs.chosen, ..._cs.avail];
    _cs.avail   = [];
    _cs.activeAvail.clear();
    _cs.activeChosen.clear();
  } else {
    _cs.avail   = [..._cs.avail, ..._cs.chosen];
    _cs.chosen  = [];
    _cs.activeChosen.clear();
    _cs.activeAvail.clear();
  }
  _csRender();
}

function applyColumnSelection() {
  if (!_pendingJoinResult) return;
  const selected = _cs.chosen;
  if (!selected.length) { toast('Move at least one column to the Selected panel', 'warn'); return; }

  const finalData = _pendingJoinResult.rawData.map(row => {
    const r = {};
    selected.forEach(c => { r[c] = row[c]; });
    return r;
  });
  const finalTypes = {};
  selected.forEach(c => { finalTypes[c] = _pendingJoinResult.colTypes[c]; });

  AppState.rawData  = finalData;
  AppState.columns  = selected;
  AppState.colTypes = finalTypes;
  AppState.datasets = [];
  AppState.fileName = 'joined_dataset.csv';

  document.getElementById('multi-ds-bar').classList.add('hidden');
  document.getElementById('multi-ds-view').classList.add('hidden');
  document.getElementById('single-ds-view').classList.remove('hidden');

  renderDataPanel('joined_dataset.csv', finalData);
  updateDatasetPill('joined_dataset.csv');
  closeModal('modal-col-select');
  _pendingJoinResult = null;

  setStatus(`Joined dataset — ${finalData.length.toLocaleString()} rows · ${selected.length} columns`);
  toast(`Joined dataset ready — ${finalData.length.toLocaleString()} rows · ${selected.length} columns`, 'success');
}

/* ── Hash join engine ────────────────────────────────────── */

function _executeJoin(datasets, conditions, joinType) {
  let mergedData  = datasets[0].rawData.map(r => ({ ...r }));
  let mergedCols  = [...datasets[0].columns];
  let mergedTypes = { ...datasets[0].colTypes };
  const joinedIds = new Set([datasets[0].id]);

  const remaining = datasets.slice(1).slice();
  let guard = datasets.length * 3;

  while (remaining.length && guard-- > 0) {
    let progress = false;

    for (let i = 0; i < remaining.length; i++) {
      const rightDS = remaining[i];

      const conds = conditions.filter(c =>
        (joinedIds.has(c.leftTableId)  && c.rightTableId === rightDS.id) ||
        (joinedIds.has(c.rightTableId) && c.leftTableId  === rightDS.id)
      );
      if (!conds.length) continue;

      const normConds = conds.map(c =>
        joinedIds.has(c.leftTableId)
          ? { leftCol: c.leftCol,  rightCol: c.rightCol }
          : { leftCol: c.rightCol, rightCol: c.leftCol  }
      );

      const rightMap = new Map();
      for (const row of rightDS.rawData) {
        const key = normConds.map(nc => String(row[nc.rightCol] ?? '')).join('\x00');
        if (!rightMap.has(key)) rightMap.set(key, []);
        rightMap.get(key).push(row);
      }

      const skipRight  = new Set(normConds.map(nc => nc.rightCol));
      const rightNew   = rightDS.columns.filter(c => !skipRight.has(c));
      const prefix     = rightDS.fileName.replace(/\.[^.]+$/, '');
      const nameMap    = {};
      rightNew.forEach(c => { nameMap[c] = mergedCols.includes(c) ? `${prefix}_${c}` : c; });

      const newMerged = [];
      for (const leftRow of mergedData) {
        const key     = normConds.map(nc => String(leftRow[nc.leftCol] ?? '')).join('\x00');
        const matches = rightMap.get(key) || [];
        if (matches.length) {
          for (const rightRow of matches) {
            const newRow = { ...leftRow };
            rightNew.forEach(c => { newRow[nameMap[c]] = rightRow[c]; });
            newMerged.push(newRow);
          }
        } else if (joinType === 'left') {
          const newRow = { ...leftRow };
          rightNew.forEach(c => { newRow[nameMap[c]] = null; });
          newMerged.push(newRow);
        }
      }

      mergedData = newMerged;
      rightNew.forEach(c => {
        mergedCols.push(nameMap[c]);
        mergedTypes[nameMap[c]] = rightDS.colTypes[c];
      });
      joinedIds.add(rightDS.id);
      remaining.splice(i, 1);
      progress = true;
      break;
    }
    if (!progress) break;
  }

  return { rawData: mergedData, columns: mergedCols, colTypes: mergedTypes };
}
