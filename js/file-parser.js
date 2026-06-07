/* ══ Upload modal wiring ══════════════════════════════════ */

let _pendingFiles = [];

function initUploadModal() {
  const zone  = document.getElementById('uzone');
  const input = document.getElementById('file-in');

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-on'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-on'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-on');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) _handleFileSelection(files);
  });
  zone.addEventListener('click', e => {
    if (!e.target.closest('label')) input.click();
  });

  input.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    if (files.length) _handleFileSelection(files);
    e.target.value = '';
  });

  document.querySelectorAll('input[name="delim"]').forEach(r =>
    r.addEventListener('change', () => {
      if (_pendingFiles.length === 1) previewFile(_pendingFiles[0], true);
    })
  );
  document.getElementById('cdelim').addEventListener('input', () => {
    if (_pendingFiles.length === 1) previewFile(_pendingFiles[0], true);
  });
}

function _handleFileSelection(files) {
  _pendingFiles = files;
  if (files.length === 1) {
    previewFile(files[0]);
  } else {
    _previewMultipleFiles(files);
  }
}

function _previewMultipleFiles(files) {
  let tbl = '<table><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>';
  files.forEach(f => {
    const kb = (f.size / 1024).toFixed(1);
    tbl += `<tr><td>${f.name}</td><td>${kb} KB</td></tr>`;
  });
  tbl += '</tbody></table>';

  document.getElementById('uprev-info').textContent = `${files.length} files selected`;
  document.getElementById('uprev-table').innerHTML  = tbl;
  document.getElementById('uprev').classList.remove('hidden');
  document.getElementById('ustatus').textContent  = '';
  document.getElementById('btn-import').disabled  = false;
  document.getElementById('btn-import').textContent = `Import ${files.length} Files`;
}

function previewFile(file, silent) {
  _pendingFiles = [file];
  document.getElementById('btn-import').textContent = 'Import Dataset';
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const ext  = file.name.split('.').pop().toLowerCase();
      const data = ext === 'json' ? parseJSON(ev.target.result) : parseDelimited(ev.target.result, getParseOpts());
      if (!data || !data.length) {
        document.getElementById('ustatus').textContent = 'No data rows found.';
        document.getElementById('btn-import').disabled = true;
        return;
      }
      const cols = Object.keys(data[0] || {});
      const rows = data.slice(0, 8);
      let tbl = `<table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
      rows.forEach(r => {
        tbl += `<tr>${cols.map(c => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`;
      });
      tbl += '</tbody></table>';
      document.getElementById('uprev-info').textContent = `${data.length.toLocaleString()} rows · ${cols.length} columns`;
      document.getElementById('uprev-table').innerHTML  = tbl;
      document.getElementById('uprev').classList.remove('hidden');
      document.getElementById('ustatus').textContent  = '';
      document.getElementById('btn-import').disabled  = false;
      if (!silent) toast(`Preview ready — ${data.length.toLocaleString()} rows`, 'success');
    } catch (err) {
      document.getElementById('ustatus').textContent = `Error: ${err.message}`;
      document.getElementById('btn-import').disabled  = true;
    }
  };
  reader.readAsText(file);
}

function importFile() {
  if (!_pendingFiles.length) return;

  let done = 0;
  const newDatasets = [];

  _pendingFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const ext  = file.name.split('.').pop().toLowerCase();
        const data = ext === 'json'
          ? parseJSON(ev.target.result)
          : parseDelimited(ev.target.result, getParseOpts());
        if (data && data.length) {
          const { columns, colTypes } = _analyzeColumnsForDS(data);
          newDatasets.push({
            id:       `ds_${Date.now()}_${idx}`,
            fileName: file.name,
            rawData:  data,
            columns,
            colTypes
          });
        } else {
          toast(`${file.name}: no data rows found`, 'error');
        }
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
      done++;
      if (done === _pendingFiles.length) _finalizeImport(newDatasets);
    };
    reader.readAsText(file);
  });
}

function _finalizeImport(newDatasets) {
  if (!newDatasets.length) return;

  // Build the full list: existing datasets + any current rawData + new
  let existing = [];
  if (AppState.datasets.length > 0) {
    existing = AppState.datasets;
  } else if (AppState.rawData) {
    const { columns, colTypes } = _analyzeColumnsForDS(AppState.rawData);
    existing = [{
      id:       `ds_existing_${Date.now()}`,
      fileName: AppState.fileName || 'dataset.csv',
      rawData:  AppState.rawData,
      columns,
      colTypes
    }];
  }

  const allDatasets = [...existing, ...newDatasets];
  closeModal('modal-upload');

  if (allDatasets.length === 1) {
    // Single mode — existing behaviour
    const ds = allDatasets[0];
    AppState.datasets = [];
    AppState.rawData  = ds.rawData;
    AppState.fileName = ds.fileName;
    AppState.columns  = ds.columns;
    AppState.colTypes = ds.colTypes;
    renderDataPanel(ds.fileName, ds.rawData);
    updateDatasetPill(ds.fileName);
    setStatus(`Dataset: ${ds.fileName} — ${ds.rawData.length.toLocaleString()} rows`);
    toast(`Loaded ${ds.rawData.length.toLocaleString()} rows · ${ds.columns.length} columns`, 'success');
    const excelBtn = document.getElementById('btn-download-excel');
    if (excelBtn) excelBtn.disabled = false;
  } else {
    // Multi mode
    AppState.datasets = allDatasets;
    AppState.rawData  = null;
    AppState.fileName = '';
    AppState.columns  = [];
    AppState.colTypes = {};
    renderMultiDataPanel();
    updateDatasetPill(`${allDatasets.length} files`);
    setStatus(`${allDatasets.length} datasets loaded — use Map & Join to merge`);
    toast(`${newDatasets.length} file(s) loaded — ${allDatasets.length} datasets total`, 'success');
  }
}

/* ══ Parse options ════════════════════════════════════════ */

function getParseOpts() {
  const delimVal = document.querySelector('input[name="delim"]:checked')?.value || 'auto';
  let delimiter;
  if (delimVal === 'auto')   delimiter = null;
  else if (delimVal === 'custom') delimiter = document.getElementById('cdelim').value || ';';
  else delimiter = delimVal;
  return {
    delimiter,
    header:         document.getElementById('chk-hdr').checked,
    dynamicTyping:  document.getElementById('chk-dyn').checked,
    skipEmptyLines: document.getElementById('chk-skip').checked
  };
}

/* ══ Parsers ══════════════════════════════════════════════ */

function parseDelimited(text, opts = {}) {
  const delimiter = opts.delimiter || detectDelimiter(text);
  const result = Papa.parse(text, {
    delimiter,
    header:         opts.header !== false,
    skipEmptyLines: opts.skipEmptyLines !== false,
    dynamicTyping:  opts.dynamicTyping !== false,
    trimHeaders:    true
  });
  if (result.errors.length && !result.data.length) throw new Error(result.errors[0].message);
  return result.data;
}

function detectDelimiter(text) {
  const line = text.split('\n')[0];
  const candidates = [',', '\t', '|', ';'];
  let best = ',', bestCount = 0;
  candidates.forEach(d => {
    const count = line.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  });
  return best;
}

function parseJSON(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  for (const key of Object.keys(parsed)) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  throw new Error('JSON must be an array or object containing an array.');
}

/* ══ Column analysis ══════════════════════════════════════ */

function _analyzeColumnsForDS(data) {
  const cols   = Object.keys(data[0] || {});
  const types  = {};
  const sample = data.slice(0, AppState.config?.ui?.sampleRowsForAnalysis ?? 300);

  // Column-name keywords that indicate a dimension/period even when values are integers
  const periodNameRe = /\b(year|yr|fiscal|fy|quarter|qtr|month|mon|week|wk|semester|season|period|phase|cycle|term|grade|level|rank|rating|code|id\b|key\b|flag|bin|bucket|class|tier|band|group|cohort|batch|wave|series|num\b|no\b)\b/i;

  cols.forEach(c => {
    const vals = sample.map(r => r[c]).filter(v => v !== null && v !== undefined && v !== '');
    if (!vals.length) { types[c] = 'string'; return; }

    // ── Date detection ──
    if (vals.some(v => typeof v === 'string' && /^\d{2,4}[-\/]\d{1,2}/.test(v))) {
      types[c] = 'date'; return;
    }

    // ── Numeric check ──
    const allNumeric = vals.every(v => typeof v === 'number' || (!isNaN(toNum(v)) && v !== ''));
    if (!allNumeric) { types[c] = 'string'; return; }

    // All values are numeric — decide: true measure vs categorical dimension
    const nums      = vals.map(v => typeof v === 'number' ? v : toNum(v));
    const uniqueSet = new Set(nums);
    const uniqueCnt = uniqueSet.size;
    const allInts   = nums.every(n => Number.isFinite(n) && n === Math.floor(n));

    // 1. 4-digit year range (1900–2100) → always categorical
    if (allInts && nums.every(n => n >= 1900 && n <= 2100)) {
      types[c] = 'string'; return;
    }

    // 2. Column name looks like a period / code dimension → treat as categorical
    if (periodNameRe.test(c)) {
      types[c] = 'string'; return;
    }

    // 3. Small integers (1–366) with low cardinality (≤ 20 unique) → likely month/quarter/rank
    if (allInts && nums.every(n => n >= 1 && n <= 366) && uniqueCnt <= 20) {
      types[c] = 'string'; return;
    }

    // 4. Low cardinality overall (≤ 15 unique values out of sample) → treat as category
    if (uniqueCnt <= 15 && uniqueCnt < vals.length * 0.1) {
      types[c] = 'string'; return;
    }

    types[c] = 'number';
  });
  return { columns: cols, colTypes: types };
}

function analyzeColumns(data) {
  const { columns, colTypes } = _analyzeColumnsForDS(data);
  AppState.columns  = columns;
  AppState.colTypes = colTypes;
}

/* ══ Data panel — single mode ═════════════════════════════ */

function renderDataPanel(fileName, data) {
  document.getElementById('ds-name').textContent = fileName;
  document.getElementById('ds-meta').textContent =
    `${data.length.toLocaleString()} rows · ${AppState.columns.length} columns`;

  const chips = document.getElementById('col-chips');
  chips.innerHTML = AppState.columns.map(c => {
    const t   = AppState.colTypes[c];
    const cls = t === 'number' ? 'num' : t === 'date' ? 'date' : 'cat';
    const badge = t === 'number' ? 'N' : t === 'date' ? 'D' : 'T';
    return `<span class="col-chip ${cls}" title="${t}">${badge} ${c}</span>`;
  }).join('');

  const previewRows = AppState.config?.ui?.previewRows ?? 100;
  const rows = data.slice(0, previewRows);
  const cols = AppState.columns;
  let html = `<thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach(r => {
    html += `<tr>${cols.map(c => {
      const v = r[c] ?? '';
      return `<td class="${AppState.colTypes[c] === 'number' ? 'n' : ''}" title="${v}">${v}</td>`;
    }).join('')}</tr>`;
  });
  html += '</tbody>';
  document.getElementById('data-preview-table').innerHTML = html;
  document.getElementById('preview-row-info').textContent =
    `Showing ${rows.length} of ${data.length.toLocaleString()}`;
}

/* ══ Data panel — multi mode ══════════════════════════════ */

function renderMultiDataPanel() {
  document.getElementById('multi-ds-bar').classList.remove('hidden');
  document.getElementById('single-ds-view').classList.add('hidden');
  document.getElementById('multi-ds-view').classList.remove('hidden');
  document.getElementById('multi-ds-count').textContent = `${AppState.datasets.length} files loaded`;

  const view = document.getElementById('multi-ds-view');
  view.innerHTML = AppState.datasets.map(ds => {
    const chipsHtml = ds.columns.map(c => {
      const t   = ds.colTypes[c];
      const cls = t === 'number' ? 'num' : t === 'date' ? 'date' : 'cat';
      const badge = t === 'number' ? 'N' : t === 'date' ? 'D' : 'T';
      return `<span class="col-chip ${cls}">${badge} ${c}</span>`;
    }).join('');

    const previewRows = ds.rawData.slice(0, 5);
    let previewHtml = `<table class="mini-table"><thead><tr>${ds.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
    previewRows.forEach(r => {
      previewHtml += `<tr>${ds.columns.map(c => {
        const v = r[c] ?? '';
        return `<td class="${ds.colTypes[c] === 'number' ? 'n' : ''}">${v}</td>`;
      }).join('')}</tr>`;
    });
    previewHtml += '</tbody></table>';

    return `
      <div class="ds-accordion" data-ds-id="${ds.id}">
        <div class="ds-acc-hdr" onclick="toggleDsAccordion('${ds.id}')">
          <span class="ds-acc-icon">▼</span>
          <span class="ds-acc-name">${ds.fileName}</span>
          <span class="ds-acc-meta">${ds.rawData.length.toLocaleString()} rows · ${ds.columns.length} cols</span>
          <button class="ds-acc-del" onclick="event.stopPropagation();removeDataset('${ds.id}')" title="Remove this file">✕</button>
        </div>
        <div class="ds-acc-body" id="acc-body-${ds.id}">
          <div class="ds-acc-chips">${chipsHtml}</div>
          <div class="ds-acc-prev-hdr">Data Preview <span style="font-weight:400;color:var(--mut)">· first 5 rows</span></div>
          <div class="ds-acc-preview">${previewHtml}</div>
        </div>
      </div>`;
  }).join('');
}

function toggleDsAccordion(dsId) {
  const body = document.getElementById(`acc-body-${dsId}`);
  const icon = body?.previousElementSibling?.querySelector('.ds-acc-icon');
  if (!body) return;
  const closing = !body.classList.contains('collapsed');
  body.classList.toggle('collapsed', closing);
  if (icon) icon.textContent = closing ? '▶' : '▼';
}

function removeDataset(dsId) {
  AppState.datasets = AppState.datasets.filter(d => d.id !== dsId);

  if (AppState.datasets.length === 0) {
    document.getElementById('multi-ds-bar').classList.add('hidden');
    document.getElementById('multi-ds-view').classList.add('hidden');
    document.getElementById('single-ds-view').classList.remove('hidden');
    document.getElementById('ds-name').textContent = 'No dataset loaded';
    document.getElementById('ds-meta').textContent = 'Upload a file to begin';
    document.getElementById('col-chips').innerHTML = '';
    document.getElementById('data-preview-table').innerHTML = '';
    document.getElementById('preview-row-info').textContent = '';
    updateDatasetPill('');
    setStatus('Ready — upload a file to begin');
    toast('All files removed', 'ok');
  } else if (AppState.datasets.length === 1) {
    const ds = AppState.datasets[0];
    AppState.datasets = [];
    AppState.rawData  = ds.rawData;
    AppState.fileName = ds.fileName;
    AppState.columns  = ds.columns;
    AppState.colTypes = ds.colTypes;
    document.getElementById('multi-ds-bar').classList.add('hidden');
    document.getElementById('multi-ds-view').classList.add('hidden');
    document.getElementById('single-ds-view').classList.remove('hidden');
    renderDataPanel(ds.fileName, ds.rawData);
    updateDatasetPill(ds.fileName);
    setStatus(`Dataset: ${ds.fileName} — ${ds.rawData.length.toLocaleString()} rows`);
    toast('File removed — 1 dataset remaining', 'ok');
  } else {
    renderMultiDataPanel();
    toast('File removed', 'ok');
  }
}
