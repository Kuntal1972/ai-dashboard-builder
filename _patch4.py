
NEW_FN = r"""
async function downloadDashboardDataAsExcel() {
  const spec = AppState.currentSpec;
  if (!spec) { alert('Build a dashboard first.'); return; }
  if (typeof XLSX === 'undefined') { alert('XLSX library not loaded. Refresh the page.'); return; }

  const btn      = document.getElementById('btn-download-excel');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Building Excel…'; }

  try {
    /* ── Data ── */
    const data     = getFilteredData();
    const raw      = AppState.rawData || [];
    const cols     = (AppState.columns && AppState.columns.length)
                       ? AppState.columns : Object.keys(raw[0] || {});
    const colTypes = AppState.colTypes || {};
    const title    = spec.title || 'Dashboard';
    const safe     = title.replace(/[^a-zA-Z0-9_\- ]/g,'').trim()
                          .replace(/\s+/g,'_').slice(0,40) || 'dashboard';

    /* ── KPI formatter ── */
    const fmtKpi = (v, k) => {
      if (typeof v === 'string') return v || '—';
      if (v == null || isNaN(v)) return '—';
      const p = k.format === 'currency' ? (k.prefix != null ? k.prefix : '$') : (k.prefix || '');
      const s = k.suffix || '';
      if (k.format === 'percentage') return p + (v * 100).toFixed(1) + '%' + s;
      if (k.format === 'integer')    return p + Math.round(v).toLocaleString() + s;
      return p + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + s;
    };

    /* ── Chart data aggregator ── */
    const aggChart = ch => {
      const type = ch.type, ag = ch.y_column ? (ch.aggregation || 'sum') : 'count';
      const xc = ch.x_column, yc = ch.y_column, cc = ch.color_column;

      if (type === 'table') {
        const c = (Array.isArray(ch.columns) && ch.columns.length) ? ch.columns : [xc, yc].filter(Boolean);
        if (!c.length) return null;
        return { h: c, r: data.slice(0, ch.top_n || 500).map(row => c.map(col => row[col] != null ? row[col] : '')) };
      }
      if (type === 'matrix') {
        if (!xc || !cc) return null;
        const rvs = [...new Set(data.map(r => String(r[xc] ?? '')))].sort().slice(0, 50);
        const cvs = [...new Set(data.map(r => String(r[cc] ?? '')))].sort().slice(0, 15);
        const byR = {};
        data.forEach(r => { const v = String(r[xc] ?? ''); (byR[v] = byR[v] || []).push(r); });
        const ca = (rows, vc) => {
          const n = vc ? rows.map(r => Number(r[vc])).filter(x => !isNaN(x)) : [];
          if (ag === 'count') return rows.length;
          if (ag === 'mean')  return n.length ? n.reduce((a,b)=>a+b,0)/n.length : 0;
          if (ag === 'max')   return n.length ? Math.max(...n) : 0;
          if (ag === 'min')   return n.length ? Math.min(...n) : 0;
          return n.reduce((a,b)=>a+b,0);
        };
        return {
          h: [xc, ...cvs, 'Total'],
          r: [
            ...rvs.map(rv => { const d2=byR[rv]||[]; return [rv,...cvs.map(cv=>ca(d2.filter(r=>String(r[cc]??'')===cv),yc)),ca(d2,yc)]; }),
            ['Total', ...cvs.map(cv=>ca(data.filter(r=>String(r[cc]??'')===cv),yc)), ca(data,yc)]
          ]
        };
      }
      if (type === 'multi_row_card') {
        const gc = xc;
        let ms = Array.isArray(ch.metrics) && ch.metrics.length ? ch.metrics : null;
        if (!ms) {
          ms = [{ label:'Count', column:null, aggregation:'count' }];
          if (yc) { ms.push({label:'Total '+yc,column:yc,aggregation:'sum'}); ms.push({label:'Avg '+yc,column:yc,aggregation:'mean'}); }
        }
        const cm = (rows, m) => {
          if (m.aggregation==='count'||!m.column) return rows.length;
          const n = rows.map(r=>Number(r[m.column])).filter(x=>!isNaN(x));
          if (!n.length) return 0;
          switch(m.aggregation){ case 'sum': return n.reduce((a,b)=>a+b,0); case 'mean': return n.reduce((a,b)=>a+b,0)/n.length; case 'max': return Math.max(...n); case 'min': return Math.min(...n); default: return n.reduce((a,b)=>a+b,0); }
        };
        const gs = gc ? [...new Set(data.map(r=>r[gc]).filter(v=>v!=null&&v!==''))].sort() : ['(All)'];
        return {
          h: [gc||'Group', ...ms.map(m=>m.label)],
          r: [...gs.map(g=>{ const d2=gc?data.filter(r=>r[gc]===g):data; return [g,...ms.map(m=>cm(d2,m))]; }), ['Total',...ms.map(m=>cm(data,m))]]
        };
      }
      if (type === 'histogram') {
        const hc = xc||yc; if (!hc) return null;
        const vals = data.map(r=>Number(r[hc])).filter(x=>!isNaN(x)).sort((a,b)=>a-b);
        if (!vals.length) return null;
        const bins=20, lo=vals[0], hi=vals[vals.length-1], bw=(hi-lo)/bins||1;
        return { h:[hc+' (range)','Count'], r:Array.from({length:bins},(_,i)=>{ const l2=lo+i*bw,h2=l2+bw; return [l2.toFixed(1)+'-'+h2.toFixed(1),vals.filter(v=>v>=l2&&(i===bins-1?v<=h2:v<h2)).length]; }) };
      }
      if (!xc) return null;
      if (cc) {
        const cats=[...new Set(data.map(r=>String(r[cc]??'')))].sort();
        const xvs=[...new Set(data.map(r=>String(r[xc]??'')))].sort();
        const bm={};
        data.forEach(r=>{ const x=String(r[xc]??''),c2=String(r[cc]??''); if(!bm[x])bm[x]={}; if(!bm[x][c2])bm[x][c2]={n:0,s:0,v:[]}; const g=bm[x][c2]; g.n++; if(yc){const n=Number(r[yc]);if(!isNaN(n)){g.s+=n;g.v.push(n);}} });
        const cy=g=>{ switch(ag){case 'count':return g.n;case 'mean':return g.v.length?g.s/g.v.length:0;case 'max':return g.v.length?Math.max(...g.v):0;case 'min':return g.v.length?Math.min(...g.v):0;default:return g.s;} };
        const eg={n:0,s:0,v:[]};
        return {h:[xc,...cats], r:xvs.map(x=>[x,...cats.map(c2=>cy((bm[x]&&bm[x][c2])||eg))])};
      }
      const mp=new Map();
      data.forEach(r=>{ const k=String(r[xc]??'(blank)'); if(!mp.has(k))mp.set(k,{n:0,s:0,v:[]}); const g=mp.get(k);g.n++; if(yc){const n=Number(r[yc]);if(!isNaN(n)){g.s+=n;g.v.push(n);}} });
      const cy2=g=>{ switch(ag){case 'count':return g.n;case 'mean':return g.v.length?g.s/g.v.length:0;case 'max':return g.v.length?Math.max(...g.v):0;case 'min':return g.v.length?Math.min(...g.v):0;default:return yc?g.s:g.n;} };
      return {h:[xc,yc||'Count'], r:[...mp.entries()].map(([x,g])=>[x,cy2(g)]).sort((a,b)=>b[1]-a[1])};
    };

    /* ── Colours ── */
    const NAVY='1F4E79', TEAL='0F766E', WHITE='FFFFFF', GREY='374151', MGREY='6B7280';
    const LGREY='F3F4F6', STRIPE='F9FAFB', LBLUE='DBEAFE';
    const KPI_COLORS = [
      {fg:'1F4E79', bg:'DBEAFE'}, {fg:'5B21B6', bg:'EDE9FE'},
      {fg:'0F766E', bg:'CCFBF1'}, {fg:'92400E', bg:'FEF3C7'},
      {fg:'166534', bg:'DCFCE7'},
    ];

    /* ── Capture chart images (Plotly → PNG) ── */
    const visCharts  = (spec.charts || []).filter(c => c.type !== 'slicer');
    const TABLE_TYPES = new Set(['table','matrix','multi_row_card']);
    const chartPngs  = {};

    if (typeof Plotly !== 'undefined' && typeof JSZip !== 'undefined') {
      const plotlyCharts = visCharts.filter(c => !TABLE_TYPES.has(c.type));
      let done = 0;
      if (btn) btn.textContent = 'Capturing charts (0/' + plotlyCharts.length + ')…';
      for (const ch of plotlyCharts) {
        try {
          const el  = document.getElementById(ch.id);
          const gd  = (el && el.data && el.data.length) ? el : ch.id;
          const url = await Plotly.toImage(gd, { format:'png', width:900, height:400, scale:2 });
          if (url && url.length > 200)
            chartPngs[ch.id] = url.replace(/^data:image\/png;base64,/, '');
        } catch (e) { console.warn('[xl] capture failed', ch.id, e.message); }
        done++;
        if (btn) btn.textContent = 'Capturing charts (' + done + '/' + plotlyCharts.length + ')…';
      }
    }
    if (btn) btn.textContent = 'Building workbook…';

    /* ── Build worksheet ── */
    const wb     = XLSX.utils.book_new();
    const aoa    = [];   // array-of-arrays
    const meta   = [];   // parallel row metadata
    const merges = [];   // cell merge descriptors
    const imgAnchors = []; // PNG image positions for JSZip
    let R = 0;

    const row = (vals, m) => { aoa.push(vals); meta.push(m || {}); R++; };
    const blank = () => row([], {});

    /* Style helpers */
    const font  = (bold, sz, rgb, name) => ({ bold, sz, color:{ rgb }, name: name||'Calibri' });
    const fill  = rgb  => ({ patternType:'solid', fgColor:{ rgb } });
    const bThin = rgb  => ({ style:'thin',   color:{ rgb } });
    const bMed  = rgb  => ({ style:'medium', color:{ rgb } });
    const bHair = rgb  => ({ style:'hair',   color:{ rgb } });

    /* ── Row 1-2: Title + meta ── */
    row([title],  { t:'title' });
    row(['Exported: ' + new Date().toLocaleString() + '   |   ' + data.length.toLocaleString() + ' rows'], { t:'meta' });
    blank(); blank();

    /* ── KPI SUMMARY ── */
    const kpis = spec.kpi_cards || [];
    if (kpis.length) {
      row(['KPI SUMMARY'], { t:'section' });
      blank();

      const PER = 4;
      for (let i = 0; i < kpis.length; i += PER) {
        const slice = kpis.slice(i, i + PER);
        const clrs  = slice.map((_,j) => KPI_COLORS[(i+j) % KPI_COLORS.length]);

        /* top border */
        row(slice.flatMap(() => ['','',' ']), { t:'kpi_top', clrs });

        /* label row — merge cols 0+1 per card */
        const lblRowIdx = R;
        row(slice.flatMap(k => [k.title || k.column || 'KPI', '', ' ']), { t:'kpi_lbl', clrs });
        slice.forEach((_,ki) => merges.push({ s:{r:lblRowIdx, c:ki*3}, e:{r:lblRowIdx, c:ki*3+1} }));

        /* value row — merge cols 0+1 per card */
        const valRowIdx = R;
        const kpiVals = slice.map(k => { try { return fmtKpi(computeKPI(data, k), k); } catch(_){ return '—'; } });
        row(kpiVals.flatMap(v => [v, '', ' ']), { t:'kpi_val', clrs });
        slice.forEach((_,ki) => merges.push({ s:{r:valRowIdx, c:ki*3}, e:{r:valRowIdx, c:ki*3+1} }));

        /* bottom border */
        row(slice.flatMap(() => ['','',' ']), { t:'kpi_bot', clrs });
        blank();
      }
      blank();
    }

    /* ── CHARTS ── */
    const IMG_ROWS = 22;   // rows reserved per chart screenshot

    for (const ch of visCharts) {
      const chartTitle = ch.title || ch.type || 'Chart';
      const b64        = chartPngs[ch.id];

      /* Section header */
      row([chartTitle], { t:'section' });

      /* Reserve rows for the PNG image */
      if (b64) {
        const imgFrom = R;
        for (let i = 0; i < IMG_ROWS; i++) row([], { t:'img' });
        imgAnchors.push({ fromRow: imgFrom, toRow: imgFrom + IMG_ROWS, b64 });
        blank();
      }

      /* Data table */
      const d = aggChart(ch);
      if (d && d.h && d.r && d.r.length) {
        row(['Data: ' + chartTitle], { t:'data_hdr_label' });
        row(d.h, { t:'hdr' });
        d.r.forEach((dr, ri) =>
          row(dr, { t:'data', alt: ri%2===1, last: ri===d.r.length-1 })
        );
      } else if (!b64 && !TABLE_TYPES.has(ch.type)) {
        row(['(no data)'], { t:'muted' });
      }

      blank(); blank();
    }

    /* ── Build XLSX worksheet ── */
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    /* Apply cell styles */
    aoa.forEach((r2, ri) => {
      const m = meta[ri];
      if (!m || !m.t) return;
      r2.forEach((_, ci) => {
        const addr = XLSX.utils.encode_cell({ r:ri, c:ci });
        if (!ws[addr]) return;
        const v = ws[addr].v, isNum = typeof v === 'number';
        let s;

        if (m.t === 'title') {
          s = { font: font(true,20,NAVY), fill: fill(LBLUE),
                alignment: { horizontal:'left', vertical:'center' },
                border: { bottom: bMed(NAVY) } };

        } else if (m.t === 'meta') {
          s = { font: font(false,9,MGREY), fill: fill(LGREY), alignment:{horizontal:'left'} };

        } else if (m.t === 'section') {
          s = { font: font(true,13,WHITE), fill: fill(NAVY),
                alignment: { horizontal:'left', vertical:'middle' } };

        } else if (m.t === 'kpi_top' || m.t === 'kpi_bot') {
          if (ci % 3 === 2) return;           // spacer col — no style
          const ki  = Math.floor(ci / 3);
          const clr = (m.clrs || [])[ki] || KPI_COLORS[0];
          const bdr = {};
          if (m.t === 'kpi_top') bdr.top    = bMed(clr.fg);
          else                    bdr.bottom  = bMed(clr.fg);
          if (ci % 3 === 0)       bdr.left   = bMed(clr.fg);
          if (ci % 3 === 1)       bdr.right  = bMed(clr.fg);
          s = { fill: fill(clr.bg), border: bdr };

        } else if (m.t === 'kpi_lbl') {
          if (ci % 3 === 2) return;
          const ki  = Math.floor(ci / 3);
          const clr = (m.clrs || [])[ki] || KPI_COLORS[0];
          const bdr = {};
          if (ci % 3 === 0) bdr.left  = bMed(clr.fg);
          if (ci % 3 === 1) bdr.right = bMed(clr.fg);
          s = { font: font(true, 9, clr.fg), fill: fill(clr.bg),
                alignment: { horizontal:'center', vertical:'bottom' }, border: bdr };

        } else if (m.t === 'kpi_val') {
          if (ci % 3 === 2) return;
          const ki  = Math.floor(ci / 3);
          const clr = (m.clrs || [])[ki] || KPI_COLORS[0];
          const bdr = {};
          if (ci % 3 === 0) bdr.left  = bMed(clr.fg);
          if (ci % 3 === 1) bdr.right = bMed(clr.fg);
          s = { font: font(true, 22, clr.fg), fill: fill(clr.bg),
                alignment: { horizontal:'center', vertical:'center' }, border: bdr };

        } else if (m.t === 'data_hdr_label') {
          s = { font: font(true, 10, GREY), fill: fill(LGREY),
                alignment: { horizontal:'left' },
                border: { bottom: bThin(MGREY) } };

        } else if (m.t === 'hdr') {
          s = { font: font(true, 10, WHITE), fill: fill(TEAL),
                alignment: { horizontal: isNum ? 'right' : 'center', vertical:'middle' },
                border: { top: bThin(TEAL), bottom: bThin(TEAL),
                          left: bThin(TEAL), right: bThin(TEAL) } };

        } else if (m.t === 'data') {
          const last = m.last;
          s = { font: font(last, 10, last ? WHITE : GREY),
                fill: fill(last ? TEAL : (m.alt ? STRIPE : WHITE)),
                alignment: { horizontal: isNum ? 'right' : 'left', vertical:'center' },
                border: { bottom: bHair(last ? TEAL : 'E5E7EB') } };

        } else if (m.t === 'muted') {
          s = { font: { italic:true, sz:10, color:{ rgb:MGREY }, name:'Calibri' },
                alignment: { horizontal:'left' } };
        }

        if (s) ws[addr].s = s;
      });
    });

    /* Row heights */
    ws['!rows'] = aoa.map((_,ri) => {
      const t = meta[ri].t;
      if (t === 'title')   return { hpt:36 };
      if (t === 'section') return { hpt:28 };
      if (t === 'kpi_val') return { hpt:44 };
      if (t === 'kpi_lbl') return { hpt:22 };
      if (t === 'kpi_top' || t === 'kpi_bot') return { hpt:6 };
      if (t === 'hdr')     return { hpt:22 };
      if (t === 'data_hdr_label') return { hpt:20 };
      if (t === 'img')     return { hpt:14 };
      return { hpt:18 };
    });

    /* Column widths: col 0 wide (labels), cols 1-29 medium */
    ws['!cols'] = Array.from({ length:30 }, (_, i) => ({ wch: i===0 ? 30 : i<16 ? 16 : 12 }));

    /* Cell merges */
    if (merges.length) ws['!merges'] = merges;

    const sheetTabName = title.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetTabName);

    /* Raw Data sheet */
    if (raw.length && cols.length) {
      const rr = [cols, ...raw.slice(0, 30000).map(r2 => cols.map(c => {
        const v = r2[c] != null ? r2[c] : '';
        return colTypes[c] === 'number' && v !== '' ? Number(v) : v;
      }))];
      const wr = XLSX.utils.aoa_to_sheet(rr);
      cols.forEach((_,ci) => {
        const a = XLSX.utils.encode_cell({r:0,c:ci});
        if (wr[a]) wr[a].s = { font:font(true,10,WHITE), fill:fill(NAVY), alignment:{horizontal:'center'} };
      });
      wr['!cols'] = cols.map(() => ({ wch:16 }));
      wr['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:rr.length-1,c:cols.length-1}}) };
      XLSX.utils.book_append_sheet(wb, wr, 'Raw Data');
    }

    /* Write XLSX bytes */
    let wbArr;
    try   { wbArr = XLSX.write(wb, { bookType:'xlsx', type:'array', cellStyles:true }); }
    catch { wbArr = XLSX.write(wb, { bookType:'xlsx', type:'array' }); }

    /* ── Inject chart PNG images via JSZip ── */
    let finalArr = wbArr;

    if (typeof JSZip !== 'undefined' && imgAnchors.length > 0) {
      try {
        if (btn) btn.textContent = 'Embedding images…';
        const zip = await JSZip.loadAsync(wbArr);

        /* Files to patch */
        let ctXml  = await zip.file('[Content_Types].xml').async('text');
        const WSXML = 'xl/worksheets/sheet1.xml';
        let wsXml  = await zip.file(WSXML).async('text');
        const WRPATH = 'xl/worksheets/_rels/sheet1.xml.rels';
        const wrFile = zip.file(WRPATH);
        let wrXml  = wrFile ? await wrFile.async('text')
          : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

        let drawParts = '', drawRels = '';

        imgAnchors.forEach(({ fromRow, toRow, b64 }, i) => {
          const idx   = i + 1;
          const relId = 'rIdImg' + idx;
          zip.file('xl/media/cimg' + idx + '.png', b64, { base64:true });
          drawParts +=
            '<xdr:twoCellAnchor editAs="oneCell">' +
              '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>' +
              '<xdr:row>' + fromRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
              '<xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff>' +
              '<xdr:row>' + toRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
              '<xdr:pic>' +
                '<xdr:nvPicPr>' +
                  '<xdr:cNvPr id="' + (100+idx) + '" name="ChartImg' + idx + '"/>' +
                  '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>' +
                '</xdr:nvPicPr>' +
                '<xdr:blipFill>' +
                  '<a:blip r:embed="' + relId + '"/>' +
                  '<a:stretch><a:fillRect/></a:stretch>' +
                '</xdr:blipFill>' +
                '<xdr:spPr>' +
                  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>' +
                  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
                '</xdr:spPr>' +
              '</xdr:pic>' +
              '<xdr:clientData/>' +
            '</xdr:twoCellAnchor>';
          drawRels +=
            '<Relationship Id="' + relId + '"' +
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
            ' Target="../media/cimg' + idx + '.png"/>';
        });

        /* Write drawing XML */
        zip.file('xl/drawings/drawing1.xml',
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<xdr:wsDr' +
          ' xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
          ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
          ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          drawParts + '</xdr:wsDr>');

        zip.file('xl/drawings/_rels/drawing1.xml.rels',
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          drawRels + '</Relationships>');

        /* Patch Content_Types */
        if (!ctXml.includes('image/png'))
          ctXml = ctXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
        if (!ctXml.includes('drawing1.xml'))
          ctXml = ctXml.replace('</Types>',
            '<Override PartName="/xl/drawings/drawing1.xml"' +
            ' ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
        zip.file('[Content_Types].xml', ctXml);

        /* Patch sheet1.xml — add xmlns:r if missing, append <drawing> before </worksheet> */
        if (!wsXml.includes('xmlns:r='))
          wsXml = wsXml.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
        if (!wsXml.includes('<drawing '))
          wsXml = wsXml.replace('</worksheet>', '<drawing r:id="rIdDraw1"/></worksheet>');
        zip.file(WSXML, wsXml);

        /* Patch sheet rels */
        if (!wrXml.includes('rIdDraw1'))
          wrXml = wrXml.replace('</Relationships>',
            '<Relationship Id="rIdDraw1"' +
            ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"' +
            ' Target="../drawings/drawing1.xml"/></Relationships>');
        zip.file(WRPATH, wrXml);

        finalArr = await zip.generateAsync({ type:'arraybuffer', compression:'DEFLATE', compressionOptions:{ level:6 } });
      } catch (e) {
        console.warn('[xl] image injection failed:', e.message);
        finalArr = wbArr;
      }
    }

    const blob = new Blob([finalArr], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    _triggerDownload(blob, safe + '_' + _datestamp() + '.xlsx');

  } catch (err) {
    console.error('[excel-export] FATAL:', err);
    alert('Export failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}"""

with open('C:/Users/kunta/ai-dashboard-builder/js/excel-exporter.js', 'r', encoding='utf-8') as f:
    content = f.read()

start = content.find('\nasync function downloadDashboardDataAsExcel()')
end   = content.find('\n\nfunction _uniqueVals(')

if start == -1 or end == -1:
    print('ERROR: markers not found', start, end)
else:
    new_content = content[:start] + '\n' + NEW_FN + content[end:]
    with open('C:/Users/kunta/ai-dashboard-builder/js/excel-exporter.js', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print('Done. old=%d chars, new=%d chars' % (end-start, len(NEW_FN)))
