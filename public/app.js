/* easyeda2KicadGuiTool - front end */
(() => {
  'use strict';

  // ------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ------------------------------------------------------------ path helpers (client-side preview only)
  const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\');
  function normParts(p) {
    const win = isWinPath(p);
    const parts = p.replace(/\\/g, '/').split('/').filter((x, i) => x !== '' || i === 0);
    const out = [];
    for (const seg of parts) {
      if (seg === '.') continue;
      if (seg === '..' && out.length > 1) out.pop(); else out.push(seg);
    }
    return { win, parts: out };
  }
  function joinPath(base, ...rest) {
    const sep = isWinPath(base) ? '\\' : '/';
    return [base.replace(/[\\/]+$/, ''), ...rest].join(sep);
  }
  function relPath(target, base) {
    if (!target || !base) return null;
    const a = normParts(target); const b = normParts(base);
    const eq = (x, y) => (a.win ? x.toLowerCase() === y.toLowerCase() : x === y);
    if (!eq(a.parts[0] || '', b.parts[0] || '')) return null; // different drive
    let i = 0;
    while (i < a.parts.length && i < b.parts.length && eq(a.parts[i], b.parts[i])) i++;
    const ups = b.parts.slice(i).map(() => '..');
    return [...ups, ...a.parts.slice(i)].join('/') || '.';
  }
  const basename = (p) => normParts(p).parts.filter(Boolean).pop() || p;

  // ------------------------------------------------------------ state
  const state = {
    settings: null,
    parts: [],
    selected: new Set(),
    svgs: {},           // id -> { symbol_svg, footprint_svg }
    running: false,
    outListing: null,   // fs listing of output dir
    projListing: null,  // fs listing of project dir
    platform: '',
  };

  const saveSettings = debounce(() => api('PUT', '/api/settings', state.settings).catch((e) => toast(e.message)), 400);
  const saveLedger = debounce(() => {
    const parts = state.parts.map(({ busy, ...p }) => p);
    api('PUT', '/api/ledger', { parts }).catch((e) => toast(`Ledger not saved: ${e.message}`));
  }, 400);

  // ------------------------------------------------------------ theme
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get('e2k-theme'));
  $('#btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next); store.set('e2k-theme', next);
  });

  // ------------------------------------------------------------ environment status
  async function checkStatus(refresh = false) {
    const pill = $('#envStatus');
    pill.className = 'pill pill-wait'; pill.textContent = 'Checking Python…';
    try {
      const s = await api('GET', `/api/status${refresh ? '?refresh=1' : ''}`);
      state.platform = s.platform;
      document.body.classList.toggle('win', s.platform === 'win32');
      if (s.ok) {
        pill.className = 'pill pill-ok';
        pill.textContent = `Python ${s.pyversion} · easyeda2kicad ${s.easyeda2kicad}`;
        pill.title = s.python;
        $('#btnSetup').classList.add('hidden');
      } else {
        pill.className = 'pill pill-err';
        pill.textContent = s.python ? 'easyeda2kicad not installed' : 'Python 3 not found';
        pill.title = s.error || '';
        $('#btnSetup').classList.toggle('hidden', !s.python);
        if (!s.python) log('error', 'No Python 3 interpreter found. Install Python 3.9+ or set the interpreter path under Options.');
      }
    } catch (e) {
      pill.className = 'pill pill-err'; pill.textContent = 'Server unreachable';
    }
  }

  $('#btnSetup').addEventListener('click', async () => {
    const btn = $('#btnSetup');
    btn.disabled = true;
    log('head', 'Installing easyeda2kicad with pip…');
    try {
      const res = await fetch('/api/install', { method: 'POST' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        dec.decode(value, { stream: true }).split(/\r?\n/).filter(Boolean).forEach((l) => log('debug', l));
      }
    } catch (e) { log('error', e.message); }
    btn.disabled = false;
    checkStatus(true);
  });

  // ------------------------------------------------------------ log
  function log(level, msg, part) {
    const el = $('#log');
    const line = document.createElement('div');
    line.className = `l-${level}`;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    line.innerHTML = `<span class="muted">${ts}</span> ${part ? `<span class="part">[${esc(part)}]</span> ` : ''}${esc(msg)}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  $('#btnClearLog').addEventListener('click', () => { $('#log').innerHTML = ''; });

  // ------------------------------------------------------------ ledger
  const normId = (raw) => {
    let s = String(raw || '').trim().toUpperCase();
    if (/^\d+$/.test(s)) s = `C${s}`;
    return /^C\d+$/.test(s) ? s : null;
  };
  const findPart = (id) => state.parts.find((p) => p.id === id);

  function newPart(id, notes = '') {
    const d = state.settings.defaults;
    return { id, symbol: !!d.symbol, footprint: !!d.footprint, model3d: !!d.model3d, svg: !!d.svg, notes, status: 'new', info: null, result: null };
  }

  function addIds(rawList, notesById = {}) {
    let added = 0; const dup = []; const badIds = [];
    for (const raw of rawList) {
      const id = normId(raw);
      if (!id) { if (String(raw).trim()) badIds.push(raw); continue; }
      if (findPart(id)) { dup.push(id); continue; }
      state.parts.push(newPart(id, notesById[id] || ''));
      added++;
    }
    renderLedger(); saveLedger(); renderTree();
    const bits = [`Added ${added} part${added === 1 ? '' : 's'}`];
    if (dup.length) bits.push(`${dup.length} already in ledger`);
    if (badIds.length) bits.push(`ignored: ${badIds.slice(0, 4).join(', ')}${badIds.length > 4 ? '…' : ''}`);
    toast(bits.join(' · '));
    return added;
  }

  $('#btnAdd').addEventListener('click', () => {
    const raw = $('#idInput').value.split(/[\s,;]+/).filter(Boolean);
    if (!raw.length) return;
    if (addIds(raw)) $('#idInput').value = '';
  });
  $('#idInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btnAdd').click(); }
  });

  function filteredParts() {
    const q = $('#filter').value.trim().toLowerCase();
    if (!q) return state.parts;
    return state.parts.filter((p) => [p.id, p.notes, p.info?.name, p.info?.package, p.info?.mpn, p.info?.manufacturer]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }

  const STATUS_LABEL = { new: 'not exported', busy: 'exporting', ok: 'exported', warning: 'warnings', error: 'error', lookup: 'looking up' };

  function renderLedger() {
    const body = $('#ledgerBody');
    const parts = filteredParts();
    $('#ledgerEmpty').classList.toggle('hidden', state.parts.length > 0);
    $('#ledgerCount').textContent = `${state.parts.length} part${state.parts.length === 1 ? '' : 's'}${state.selected.size ? ` · ${state.selected.size} selected` : ''}`;
    const rows = [];
    for (const p of parts) {
      const full = p.symbol && p.footprint && p.model3d;
      const sel = state.selected.has(p.id);
      const info = p.info || {};
      const st = p.busy ? 'busy' : (p.status || 'new');
      const meta = info.error
        ? `<div class="pmeta" style="color:var(--err)">${esc(info.error)}</div>`
        : info.name
          ? `<div class="pname">${esc(info.name)}</div><div class="pmeta ${info.has_3d === true ? 'has3d' : info.has_3d === false ? 'no3d' : ''}">${esc([info.manufacturer, info.package].filter(Boolean).join(' · '))}</div>`
          : '<span class="muted small">–</span>';
      rows.push(`<tr data-id="${esc(p.id)}" class="${sel ? 'selected' : ''}">
        <td class="c-sel"><input type="checkbox" data-act="sel" ${sel ? 'checked' : ''} aria-label="Select ${esc(p.id)}"></td>
        <td class="c-id"><a href="https://www.lcsc.com/product-detail/${esc(p.id)}.html" target="_blank" rel="noopener" title="Open on LCSC">${esc(p.id)}</a></td>
        <td class="c-part">${meta}</td>
        <td class="c-opt"><input type="checkbox" data-opt="full" ${full ? 'checked' : ''} title="--full"></td>
        <td class="c-opt"><input type="checkbox" data-opt="symbol" ${p.symbol ? 'checked' : ''} title="--symbol"></td>
        <td class="c-opt"><input type="checkbox" data-opt="footprint" ${p.footprint ? 'checked' : ''} title="--footprint"></td>
        <td class="c-opt"><input type="checkbox" data-opt="model3d" ${p.model3d ? 'checked' : ''} title="--3d"></td>
        <td class="c-opt"><input type="checkbox" data-opt="svg" ${p.svg ? 'checked' : ''} title="--svg"></td>
        <td class="c-notes"><input data-act="notes" value="${esc(p.notes)}" placeholder="notes…"></td>
        <td class="c-status"><span class="status st-${st === 'lookup' ? 'busy' : st}">${STATUS_LABEL[st] || st}</span></td>
        <td class="c-act">
          <button class="btn ghost" data-act="preview" title="Preview symbol &amp; footprint">&#128065;</button>
          <button class="btn ghost" data-act="remove" title="Remove">&times;</button>
        </td>
      </tr>`);
      if (p.result && (p.result.error || p.result.warnings?.length || p.result.outputs)) {
        const r = p.result; const o = r.outputs || {};
        const bits = [];
        if (r.error) bits.push(`<span style="color:var(--err)">${esc(r.error)}</span>`);
        if (o.symbol) bits.push(`sym <code>${esc(o.symbol)}</code>`);
        if (o.footprint) bits.push(`fp <code>${esc(o.footprint)}</code>`);
        if (o.model_ref) bits.push(`3D <code>${esc(o.model_ref)}</code>`);
        else if (o.model) bits.push(`3D <code>${esc(o.model)}</code>`);
        if (o.datasheet) bits.push(`datasheet <code>datasheets/${esc(o.datasheet.split(/[\\/]/).pop())}</code>`);
        (r.warnings || []).forEach((w) => bits.push(`<span style="color:var(--warn)">${esc(w)}</span>`));
        rows.push(`<tr class="row-detail"><td colspan="11">${bits.join(' &nbsp;·&nbsp; ')}</td></tr>`);
      }
    }
    body.innerHTML = rows.join('');
    // indeterminate "full" checkboxes
    for (const p of parts) {
      const cb = body.querySelector(`tr[data-id="${CSS.escape(p.id)}"] input[data-opt="full"]`);
      if (cb) { const n = [p.symbol, p.footprint, p.model3d].filter(Boolean).length; cb.indeterminate = n > 0 && n < 3; }
    }
    const visIds = parts.map((p) => p.id);
    const selAll = $('#selAll');
    const nSel = visIds.filter((id) => state.selected.has(id)).length;
    selAll.checked = visIds.length > 0 && nSel === visIds.length;
    selAll.indeterminate = nSel > 0 && nSel < visIds.length;
    updateCli();
  }

  $('#ledgerBody').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const p = findPart(tr.dataset.id); if (!p) return;
    const opt = e.target.dataset.opt;
    if (opt === 'full') { p.symbol = p.footprint = p.model3d = e.target.checked; }
    else if (opt) p[opt] = e.target.checked;
    else if (e.target.dataset.act === 'sel') {
      if (e.target.checked) state.selected.add(p.id); else state.selected.delete(p.id);
    }
    renderLedger(); saveLedger(); renderTree();
  });
  $('#ledgerBody').addEventListener('input', (e) => {
    if (e.target.dataset.act !== 'notes') return;
    const p = findPart(e.target.closest('tr').dataset.id);
    if (p) { p.notes = e.target.value; saveLedger(); }
  });
  $('#ledgerBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    if (btn.dataset.act === 'remove') {
      state.parts = state.parts.filter((p) => p.id !== id); state.selected.delete(id);
      renderLedger(); saveLedger(); renderTree();
    } else if (btn.dataset.act === 'preview') openPreview(id);
  });
  // header toggles: click a column header to toggle that option for all visible rows
  $$('.ledger th.c-opt').forEach((th) => th.addEventListener('click', () => {
    const col = th.dataset.col; const parts = filteredParts(); if (!parts.length) return;
    const allOn = parts.every((p) => (col === 'full' ? p.symbol && p.footprint && p.model3d : p[col]));
    for (const p of parts) {
      if (col === 'full') p.symbol = p.footprint = p.model3d = !allOn; else p[col] = !allOn;
    }
    renderLedger(); saveLedger(); renderTree();
  }));
  $('#selAll').addEventListener('change', (e) => {
    for (const p of filteredParts()) { if (e.target.checked) state.selected.add(p.id); else state.selected.delete(p.id); }
    renderLedger();
  });
  $('#filter').addEventListener('input', renderLedger);
  $('#btnRemove').addEventListener('click', () => {
    if (!state.selected.size) return toast('Select parts first');
    if (!confirm(`Remove ${state.selected.size} part(s) from the ledger? (Exported files are not deleted.)`)) return;
    state.parts = state.parts.filter((p) => !state.selected.has(p.id)); state.selected.clear();
    renderLedger(); saveLedger(); renderTree();
  });
  $$('[data-default]').forEach((cb) => cb.addEventListener('change', () => {
    state.settings.defaults[cb.dataset.default] = cb.checked; saveSettings();
  }));

  // ------------------------------------------------------------ lookup / preview
  async function lookup(ids, withSvg = true) {
    ids.forEach((id) => { const p = findPart(id); if (p && p.status === 'new') p.status = 'lookup'; });
    renderLedger();
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      try {
        const { results, logs } = await api('POST', '/api/info', { ids: chunk, svg: withSvg });
        logs.forEach((l) => l.level !== 'debug' && log(l.level || 'error', l.message || l.error, l.part));
        for (const r of results) {
          const p = findPart(r.id);
          if (r.symbol_svg || r.footprint_svg) state.svgs[r.id] = { symbol_svg: r.symbol_svg, footprint_svg: r.footprint_svg };
          if (!p) continue;
          const { symbol_svg, footprint_svg, event, ...info } = r;
          p.info = info;
          if (r.error) log('error', `Lookup failed: ${r.error}`, r.id);
        }
      } catch (e) { log('error', `Lookup failed: ${e.message}`); }
      chunk.forEach((id) => { const p = findPart(id); if (p && p.status === 'lookup') p.status = 'new'; });
      renderLedger();
    }
    saveLedger();
  }
  $('#btnLookup').addEventListener('click', () => {
    const ids = state.selected.size ? [...state.selected] : state.parts.filter((p) => !p.info).map((p) => p.id);
    if (!ids.length) return toast('Nothing to look up');
    log('head', `Looking up ${ids.length} part(s)…`);
    lookup(ids, true);
  });

  function svgImg(svg) {
    if (!svg) return '<span class="muted">No preview available</span>';
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    return `<img src="${url}" alt="" style="max-width:100%;max-height:100%">`;
  }
  async function openPreview(id) {
    const dlg = $('#preview');
    $('#previewTitle').textContent = id;
    $('#pvSymbol').innerHTML = $('#pvFootprint').innerHTML = '<span class="status st-busy">loading</span>';
    $('#previewMeta').innerHTML = '';
    dlg.showModal();
    if (!state.svgs[id]) await lookup([id], true);
    const p = findPart(id); const info = p?.info || {};
    const meta = [['Name', info.name], ['Manufacturer', info.manufacturer], ['MPN', info.mpn], ['Package', info.package],
      ['Footprint', info.footprint], ['3D model', info.has_3d ? info.model_name : info.has_3d === false ? 'not available' : ''],
      ['Description', info.description]].filter(([, v]) => v);
    $('#previewMeta').innerHTML = meta.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')
      + (info.datasheet ? `<dt>Datasheet</dt><dd><a href="${esc(info.datasheet)}" target="_blank" rel="noopener">open</a></dd>` : '');
    const s = state.svgs[id] || {};
    $('#pvSymbol').innerHTML = svgImg(s.symbol_svg);
    $('#pvFootprint').innerHTML = svgImg(s.footprint_svg);
  }

  // ------------------------------------------------------------ CSV import / export
  function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  $('#csvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (!rows.length) return toast('Empty file');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const isId = (v) => /^C\d{2,}$/i.test(String(v).trim());
    let col = header.findIndex((h, i) => /lcsc|jlc|supplier part|part ?#|part number/.test(h) && rows.slice(1).some((r) => isId(r[i])));
    let start = 1;
    if (col < 0) {
      // no recognisable header: pick the column with the most LCSC-looking values
      const counts = header.map((_, i) => rows.filter((r) => isId(r[i])).length);
      col = counts.indexOf(Math.max(...counts));
      start = isId(rows[0][col]) ? 0 : 1;
      if (!counts[col]) return toast('No LCSC part numbers (C1234…) found in that file');
    }
    const noteCols = ['comment', 'value', 'designator', 'notes', 'note'].map((n) => header.indexOf(n)).filter((i) => i >= 0 && i !== col);
    const ids = []; const notes = {};
    for (const r of rows.slice(start)) {
      for (const raw of String(r[col] || '').split(/[\s,;/]+/)) {
        const id = normId(raw); if (!id) continue;
        ids.push(id);
        notes[id] = notes[id] || noteCols.map((i) => (r[i] || '').trim()).filter(Boolean).join(' — ');
      }
    }
    log('head', `Importing ${ids.length} part number(s) from ${file.name}`);
    addIds(ids, notes);
  });

  $('#btnExportCsv').addEventListener('click', () => {
    const cols = ['id', 'symbol', 'footprint', 'model3d', 'svg', 'notes', 'name', 'manufacturer', 'mpn', 'package', 'status'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')].concat(state.parts.map((p) => [p.id, p.symbol, p.footprint, p.model3d, p.svg, p.notes,
      p.info?.name, p.info?.manufacturer, p.info?.mpn, p.info?.package, p.status].map(q).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    a.download = 'easyeda2kicad-ledger.csv';
    a.click();
  });

  // ------------------------------------------------------------ export settings controls
  const nameInputs = { symbol: '#nameSymbol', footprint: '#nameFootprint', model: '#nameModel', svg: '#nameSvg' };
  const validName = (n) => n && !/[<>:"/\\|?*]/.test(n) && n !== '.' && n !== '..';

  function bindSettings() {
    const s = state.settings;
    $('#outputDir').value = s.outputDir || '';
    $('#projectDir').value = s.projectDir || '';
    $('#libName').value = s.libName || '';
    $('#linkNames').checked = !!s.linkNames;
    for (const [k, sel] of Object.entries(nameInputs)) $(sel).value = s.names[k] || '';
    $(`input[name="modelPathMode"][value="${s.modelPathMode}"]`).checked = true;
    $(`input[name="modelExt"][value="${s.modelExt}"]`).checked = true;
    $('#customModelPrefix').value = s.customModelPrefix || '';
    $('#overwrite').checked = !!s.overwrite;
    $('#useCache').checked = !!s.useCache;
    $('#updateLibTables').checked = !!s.updateLibTables;
    $('#downloadDatasheets').checked = s.downloadDatasheets !== false;
    $('#customFields').value = (s.customFields || []).join('\n');
    $('#pythonPath').value = s.pythonPath || '';
    $$('[data-default]').forEach((cb) => { cb.checked = !!s.defaults[cb.dataset.default]; });
    $('.names').classList.toggle('linked', !!s.linkNames);
  }

  const onSettingsChanged = () => { saveSettings(); renderTree(); updateCli(); };
  const refreshListings = debounce(async () => {
    const s = state.settings;
    state.outListing = s.outputDir ? await api('GET', `/api/fs/list?path=${encodeURIComponent(s.outputDir)}`).catch(() => null) : null;
    state.projListing = s.projectDir ? await api('GET', `/api/fs/list?path=${encodeURIComponent(s.projectDir)}`).catch(() => null) : null;
    renderTree();
  }, 350);

  $('#outputDir').addEventListener('input', (e) => { state.settings.outputDir = e.target.value.trim(); onSettingsChanged(); refreshListings(); });
  $('#projectDir').addEventListener('input', (e) => { state.settings.projectDir = e.target.value.trim(); onSettingsChanged(); refreshListings(); });
  $('#libName').addEventListener('input', (e) => {
    const s = state.settings; s.libName = e.target.value.trim();
    if (s.linkNames) { for (const k of Object.keys(nameInputs)) { s.names[k] = s.libName; $(nameInputs[k]).value = s.libName; } }
    onSettingsChanged();
  });
  $('#linkNames').addEventListener('change', (e) => {
    const s = state.settings; s.linkNames = e.target.checked;
    if (s.linkNames) { for (const k of Object.keys(nameInputs)) { s.names[k] = s.libName; $(nameInputs[k]).value = s.libName; } }
    $('.names').classList.toggle('linked', s.linkNames);
    onSettingsChanged();
  });
  for (const [k, sel] of Object.entries(nameInputs)) {
    $(sel).addEventListener('input', (e) => {
      const s = state.settings; s.names[k] = e.target.value.trim();
      if (s.linkNames && s.names[k] !== s.libName) { s.linkNames = false; $('#linkNames').checked = false; $('.names').classList.remove('linked'); }
      onSettingsChanged();
    });
  }
  $$('input[name="modelPathMode"]').forEach((r) => r.addEventListener('change', () => { state.settings.modelPathMode = r.value; onSettingsChanged(); }));
  $$('input[name="modelExt"]').forEach((r) => r.addEventListener('change', () => { state.settings.modelExt = r.value; onSettingsChanged(); }));
  $('#customModelPrefix').addEventListener('input', (e) => {
    state.settings.customModelPrefix = e.target.value.trim();
    $('input[name="modelPathMode"][value="custom"]').checked = true; state.settings.modelPathMode = 'custom';
    onSettingsChanged();
  });
  for (const id of ['overwrite', 'useCache', 'updateLibTables', 'downloadDatasheets']) {
    $(`#${id}`).addEventListener('change', (e) => { state.settings[id] = e.target.checked; onSettingsChanged(); });
  }
  $('#customFields').addEventListener('input', (e) => {
    state.settings.customFields = e.target.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); onSettingsChanged();
  });
  $('#pythonPath').addEventListener('change', async (e) => {
    state.settings.pythonPath = e.target.value.trim();
    await api('PUT', '/api/settings', state.settings).catch(() => {});
    checkStatus(true);
  });

  // ------------------------------------------------------------ model path & tree preview
  function computeModelRef() {
    const s = state.settings;
    const modelDir = s.outputDir ? joinPath(s.outputDir, `${s.names.model}.3dshapes`) : '';
    if (s.modelPathMode === 'custom') {
      return s.customModelPrefix ? { ref: s.customModelPrefix.replace(/\/+$/, '') } : { ref: modelDir.replace(/\\/g, '/'), warn: 'Custom prefix is empty: an absolute path will be used.' };
    }
    if (s.modelPathMode === 'project') {
      if (!s.projectDir) return { ref: modelDir.replace(/\\/g, '/'), warn: 'Pick a KiCad project folder to make 3D paths project-relative (absolute path used otherwise).' };
      const rel = relPath(modelDir, s.projectDir);
      if (rel === null) return { ref: modelDir.replace(/\\/g, '/'), warn: 'Output and project are on different drives: an absolute path will be used.' };
      const res = { ref: rel === '.' ? '${KIPRJMOD}' : `\${KIPRJMOD}/${rel}` };
      if (rel.startsWith('..')) res.warn = 'The library is outside the project folder. ${KIPRJMOD}/../ paths work, but the project won\'t be self-contained if you move or share it.';
      return res;
    }
    return { ref: modelDir.replace(/\\/g, '/') };
  }

  function renderTree() {
    const s = state.settings; if (!s) return;
    const tree = $('#tree');
    const names = s.names;
    const sel = activeParts();
    const want = {
      symbol: sel.some((p) => p.symbol), footprint: sel.some((p) => p.footprint),
      model: sel.some((p) => p.model3d), svg: sel.some((p) => p.svg),
    };
    const anyWant = Object.values(want).some(Boolean);
    const ol = state.outListing?.kicad;
    const exists = {
      symbol: ol?.symbolLibs.includes(names.symbol), footprint: ol?.footprintLibs.includes(names.footprint),
      model: ol?.modelDirs.includes(names.model), svg: false,
    };
    const tag = (k) => (exists[k] ? '<span class="t-ex">  (exists, parts will be added)</span>' : '<span class="t-new">  (new)</span>');
    const dim = (k, html) => (anyWant && !want[k] ? `<span class="t-ex">${html}</span>` : html);
    const items = [
      dim('symbol', `${esc(names.symbol)}.kicad_sym${tag('symbol')}`),
      dim('footprint', `<span class="t-dir">${esc(names.footprint)}.pretty/</span>${tag('footprint')}`),
      dim('model', `<span class="t-dir">${esc(names.model)}.3dshapes/</span><span class="t-note">  .wrl + .step</span>`),
    ];
    if (want.svg) items.push(`<span class="t-dir">${esc(names.svg)}.svgs/</span>`);
    if (s.downloadDatasheets !== false) items.push(`<span class="t-dir">datasheets/</span><span class="t-note">  &lt;LCSC&gt;_&lt;part&gt;.pdf</span>`);

    const lines = [];
    const branch = (arr, indent) => arr.forEach((it, i) => lines.push(`${indent}${i === arr.length - 1 ? '└─ ' : '├─ '}${it}`));
    if (!s.outputDir) {
      tree.innerHTML = '<span class="t-note">Choose a library output folder…</span>';
    } else {
      const rel = s.projectDir ? relPath(s.outputDir, s.projectDir) : null;
      const proj = state.projListing?.kicad?.projects?.[0];
      if (rel !== null && !rel.startsWith('..')) {
        lines.push(`<span class="t-dir">${esc(basename(s.projectDir))}/</span>${proj ? `  <span class="t-proj">◆ ${esc(proj)}</span>` : ''}`);
        const top = [];
        if (s.updateLibTables) {
          top.push(`sym-lib-table<span class="t-note">  + "${esc(names.symbol)}"</span>`);
          top.push(`fp-lib-table<span class="t-note">   + "${esc(names.footprint)}"</span>`);
        }
        if (rel === '.') {
          branch([...top, ...items], '');
        } else {
          top.push(`<span class="t-dir">${esc(rel)}/</span>`);
          branch(top, '');
          branch(items, '   ');
        }
      } else {
        lines.push(`<span class="t-dir">${esc(s.outputDir)}</span>`);
        branch(items, '');
      }
      tree.innerHTML = lines.join('\n');
    }

    const { ref, warn } = computeModelRef();
    $('#modelRef').textContent = `${ref}/<model>.${s.modelExt}`;
    $('#refWarning').textContent = warn || '';
    $('#refWarning').classList.toggle('hidden', !warn);
    $('#relinkName').textContent = `${names.footprint}.pretty`;

    // project hint
    const hint = $('#projectHint');
    if (!s.projectDir) { hint.className = 'hint'; hint.textContent = 'Optional, but needed for ${KIPRJMOD} paths and lib-table updates.'; }
    else if (!state.projListing) { hint.className = 'hint warn'; hint.textContent = 'Folder not found.'; }
    else if (state.projListing.kicad.projects.length) { hint.className = 'hint ok'; hint.textContent = `✓ KiCad project: ${state.projListing.kicad.projects.join(', ')}`; }
    else { hint.className = 'hint warn'; hint.textContent = 'No .kicad_pro file in this folder. Is this the project root?'; }

    $('#stepNote').style.color = s.modelExt === 'step' ? 'var(--warn)' : '';
    $('#stepNote').textContent = s.modelExt === 'step'
      ? '(STEP files are not offset-corrected by easyeda2kicad and may appear shifted)'
      : '(both are always downloaded; .wrl has the offset baked in)';
  }

  function updateCli() {
    const s = state.settings; if (!s) return;
    const parts = activeParts();
    if (!parts.length) { $('#cliPreview').textContent = '# add parts to the ledger'; return; }
    const groups = new Map();
    for (const p of parts) {
      const flags = [];
      if (p.symbol && p.footprint && p.model3d) flags.push('--full');
      else { if (p.symbol) flags.push('--symbol'); if (p.footprint) flags.push('--footprint'); if (p.model3d) flags.push('--3d'); }
      if (p.svg) flags.push('--svg');
      if (!flags.length) continue;
      const k = flags.join(' ');
      groups.set(k, [...(groups.get(k) || []), p.id]);
    }
    const q = (v) => (/\s/.test(v) ? `"${v}"` : v);
    const common = [];
    if (s.outputDir) common.push('--output', q(joinPath(s.outputDir, s.names.symbol)));
    if (s.overwrite) common.push('--overwrite');
    if (s.modelPathMode === 'project') common.push('--project-relative');
    if (s.useCache) common.push('--use-cache');
    if (s.customFields?.length) common.push('--custom-field', ...s.customFields.map((f) => `'${f}'`));
    const lines = [...groups].map(([flags, ids]) => `easyeda2kicad ${flags} --lcsc_id ${ids.join(' ')} ${common.join(' ')}`);
    const n = s.names;
    if (new Set([n.symbol, n.footprint, n.model]).size > 1) lines.push('# note: the CLI cannot give the .pretty / .3dshapes different names. The GUI can.');
    $('#cliPreview').textContent = lines.join('\n');
  }

  // ------------------------------------------------------------ folder browser
  const browser = { target: null, path: '' };
  async function loadRoots() {
    const r = await api('GET', '/api/fs/roots');
    const sec = (title, list) => (list.length ? `<h4>${title}</h4>${list.map((x) => `<button type="button" data-path="${esc(x.path)}" title="${esc(x.path)}">${esc(x.name || basename(x.path))}</button>`).join('')}` : '');
    $('#places').innerHTML = sec('Recent', r.recent.map((p) => ({ path: p, name: basename(p) }))) + sec('Places', r.quick) + sec('Drives', r.roots);
  }
  async function browseTo(p) {
    try {
      const d = await api('GET', `/api/fs/list?path=${encodeURIComponent(p)}`);
      browser.path = d.path; browser.parent = d.parent;
      $('#browserPath').value = d.path;
      $('#browserSel').textContent = d.path;
      // breadcrumbs
      const segs = normParts(d.path).parts.filter(Boolean);
      const win = isWinPath(d.path);
      let acc = win ? '' : '/';
      $('#crumbs').innerHTML = segs.map((seg, i) => {
        acc = win ? (i === 0 ? `${seg}\\` : joinPath(acc, seg)) : (acc === '/' ? `/${seg}` : `${acc}/${seg}`);
        return `${i ? '<span>›</span>' : ''}<button type="button" data-path="${esc(acc)}">${esc(seg)}</button>`;
      }).join('');
      // KiCad markers
      const k = d.kicad; const m = [];
      k.projects.forEach((pr) => m.push(`<button type="button" class="marker proj" data-use-project="1" title="Use this folder as the KiCad project folder">◆ ${esc(pr)} (use as project)</button>`));
      k.symbolLibs.forEach((n) => m.push(`<button type="button" class="marker" data-name="symbol" data-value="${esc(n)}" title="Use this symbol library name">${esc(n)}.kicad_sym</button>`));
      k.footprintLibs.forEach((n) => m.push(`<button type="button" class="marker" data-name="footprint" data-value="${esc(n)}" title="Use this footprint library name">${esc(n)}.pretty</button>`));
      k.modelDirs.forEach((n) => m.push(`<button type="button" class="marker" data-name="model" data-value="${esc(n)}" title="Use this 3D folder name">${esc(n)}.3dshapes</button>`));
      $('#browserMarkers').innerHTML = m.join('');
      const kd = (n) => /\.(pretty|3dshapes|svgs)$/.test(n);
      $('#dirList').innerHTML = d.dirs.length
        ? d.dirs.map((n) => `<li data-path="${esc(joinPath(d.path, n))}" class="${kd(n) ? 'kd' : ''}"><span class="ico">${kd(n) ? '▣' : '📁'}</span>${esc(n)}</li>`).join('')
        : '<li class="empty-li">No sub-folders</li>';
    } catch (e) { toast(e.message); }
  }
  async function openBrowser(target) {
    browser.target = target;
    $('#browserTitle').textContent = target === 'projectDir' ? 'Choose KiCad project folder' : 'Choose library output folder';
    const dlg = $('#browser');
    dlg.returnValue = '';
    dlg.showModal();
    await loadRoots();
    const start = state.settings[target] || state.settings.outputDir || state.settings.projectDir || '';
    await browseTo(start || '~');
  }
  $$('[data-browse]').forEach((b) => b.addEventListener('click', () => openBrowser(b.dataset.browse)));
  $('#places').addEventListener('click', (e) => { const b = e.target.closest('[data-path]'); if (b) browseTo(b.dataset.path); });
  $('#crumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-path]'); if (b) browseTo(b.dataset.path); });
  $('#dirList').addEventListener('click', (e) => { const li = e.target.closest('li[data-path]'); if (li) browseTo(li.dataset.path); });
  $('#browserGo').addEventListener('click', () => browseTo($('#browserPath').value));
  $('#browserPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); browseTo(e.target.value); } });
  $('#browserUp').addEventListener('click', () => browser.parent && browseTo(browser.parent));
  $('#browserNew').addEventListener('click', async () => {
    const name = prompt('New folder name', browser.target === 'outputDir' ? 'libs' : 'New folder');
    if (!name) return;
    try { const r = await api('POST', '/api/fs/mkdir', { parent: browser.path, name }); browseTo(r.path); } catch (e) { toast(e.message); }
  });
  $('#browserMarkers').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.useProject) {
      state.settings.projectDir = browser.path; $('#projectDir').value = browser.path;
      toast('Project folder set'); onSettingsChanged(); refreshListings();
    } else if (b.dataset.name) {
      const s = state.settings; s.names[b.dataset.name] = b.dataset.value; $(nameInputs[b.dataset.name]).value = b.dataset.value;
      if (s.linkNames && b.dataset.value !== s.libName) { s.linkNames = false; $('#linkNames').checked = false; $('.names').classList.remove('linked'); }
      toast(`Using existing name "${b.dataset.value}"`); onSettingsChanged();
    }
  });
  $('#browser').addEventListener('close', () => {
    if ($('#browser').returnValue !== 'ok' || !browser.path) return;
    const t = browser.target;
    state.settings[t] = browser.path; $(`#${t}`).value = browser.path;
    // Selecting a project folder with an empty output: suggest <project>/libs
    if (t === 'projectDir' && !state.settings.outputDir) {
      state.settings.outputDir = joinPath(browser.path, 'libs'); $('#outputDir').value = state.settings.outputDir;
    }
    onSettingsChanged(); refreshListings();
  });

  $$('[data-native]').forEach((b) => b.addEventListener('click', async () => {
    const t = b.dataset.native;
    try {
      const r = await api('POST', '/api/fs/native-pick', { start: state.settings[t] || '', title: t === 'projectDir' ? 'Select KiCad project folder' : 'Select library output folder' });
      if (r.path) { state.settings[t] = r.path; $(`#${t}`).value = r.path; onSettingsChanged(); refreshListings(); }
    } catch (e) { toast(e.message); }
  }));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
    const p = state.settings[b.dataset.open]; if (!p) return toast('No folder set');
    api('POST', '/api/fs/open', { path: p }).catch((e) => toast(e.message));
  }));

  // ------------------------------------------------------------ export
  function activeParts(all = false) {
    if (!all && state.selected.size) return state.parts.filter((p) => state.selected.has(p.id));
    return state.parts;
  }
  function buildJob(parts) {
    const s = state.settings;
    const custom = {};
    for (const line of s.customFields || []) {
      const i = line.indexOf(':'); if (i > 0) custom[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return {
      output_dir: s.outputDir,
      project_dir: s.projectDir || null,
      names: { ...s.names },
      model_path_mode: s.modelPathMode,
      custom_model_prefix: s.customModelPrefix,
      model_ext: s.modelExt,
      overwrite: s.overwrite,
      use_cache: s.useCache,
      update_lib_tables: s.updateLibTables,
      download_datasheets: s.downloadDatasheets !== false,
      custom_fields: custom,
      parts: parts.map((p) => ({ id: p.id, symbol: p.symbol, footprint: p.footprint, model3d: p.model3d, svg: p.svg })),
    };
  }

  async function runExport(all) {
    if (state.running) return;
    const s = state.settings;
    if (!s.outputDir) return toast('Choose a library output folder first');
    for (const [k, v] of Object.entries(s.names)) if (!validName(v)) return toast(`Invalid ${k} name`);
    let parts = all ? state.parts : (state.selected.size ? activeParts() : []);
    if (!all && !parts.length) return toast('Select parts in the ledger, or use "Export all"');
    const skipped = parts.filter((p) => !(p.symbol || p.footprint || p.model3d || p.svg));
    parts = parts.filter((p) => !skipped.includes(p));
    skipped.forEach((p) => log('warning', 'Skipped: no output selected (Sym / FP / 3D / SVG)', p.id));
    if (!parts.length) return toast('Nothing to export');

    state.running = true;
    $('#btnExport').disabled = $('#btnExportAll').disabled = true;
    $('#btnCancel').classList.remove('hidden');
    $('#progress').classList.remove('hidden'); $('#progressBar').style.width = '0%';
    let done = 0;
    log('head', `Exporting ${parts.length} part(s) → ${s.outputDir}`);

    try {
      const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildJob(parts)) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          switch (ev.event) {
            case 'log': if (ev.level !== 'debug') log(ev.level, ev.message, ev.part); break;
            case 'paths': log('info', `3D model path in footprints: ${ev.model_ref}/<model>.${ev.model_ext}`); break;
            case 'part_start': { const p = findPart(ev.id); if (p) { p.busy = true; renderLedger(); } break; }
            case 'part_done': {
              const p = findPart(ev.id);
              if (p) { p.busy = false; p.status = ev.status; p.result = { outputs: ev.outputs, warnings: ev.warnings, error: ev.error }; p.exportedAt = new Date().toISOString(); }
              if (ev.status === 'error') log('error', ev.error, ev.id);
              else (ev.warnings || []).forEach((w) => log('warning', w, ev.id));
              done++; $('#progressBar').style.width = `${Math.round((done / parts.length) * 100)}%`;
              renderLedger(); saveLedger();
              break;
            }
            case 'summary':
              log(ev.failed ? 'warning' : 'ok', `Done: ${ev.ok} succeeded, ${ev.failed} failed.`);
              (ev.tables || []).forEach((t) => log('ok', `${t.table}: ${t.action} "${t.name}" → ${t.uri}`));
              toast(`Export finished: ${ev.ok} ok, ${ev.failed} failed`);
              break;
            case 'fatal': log('fatal', ev.error); toast(ev.error, 5000); break;
            default: break;
          }
        }
      }
    } catch (e) {
      log('error', e.message); toast(e.message, 5000);
    } finally {
      state.parts.forEach((p) => { if (p.busy) { p.busy = false; } });
      state.running = false;
      $('#btnExport').disabled = $('#btnExportAll').disabled = false;
      $('#btnCancel').classList.add('hidden');
      setTimeout(() => $('#progress').classList.add('hidden'), 1200);
      renderLedger(); saveLedger(); refreshListings();
    }
  }
  $('#btnExport').addEventListener('click', () => runExport(false));
  $('#btnExportAll').addEventListener('click', () => runExport(true));
  $('#btnCancel').addEventListener('click', () => api('POST', '/api/export/cancel').then(() => log('warning', 'Export cancelled')));

  $('#btnRelink').addEventListener('click', async () => {
    const s = state.settings;
    if (!s.outputDir) return toast('Choose a library output folder first');
    const fpDir = joinPath(s.outputDir, `${s.names.footprint}.pretty`);
    if (!confirm(`Rewrite the 3D model path of every footprint in\n${fpDir}\nto\n${computeModelRef().ref}/<model>.${s.modelExt} ?`)) return;
    try {
      const r = await api('POST', '/api/relink', {
        footprint_dir: fpDir, model_dir: joinPath(s.outputDir, `${s.names.model}.3dshapes`), project_dir: s.projectDir || null,
        model_path_mode: s.modelPathMode, custom_model_prefix: s.customModelPrefix, model_ext: s.modelExt,
      });
      for (const ev of r.events) {
        if (ev.event === 'log') log(ev.level, ev.message);
        else if (ev.event === 'relink_done') { log('ok', `Relinked ${ev.changed} of ${ev.total} footprints → ${ev.model_ref}`); toast(`Relinked ${ev.changed}/${ev.total} footprints`); }
        else if (ev.event === 'fatal') log('error', ev.error);
      }
    } catch (e) { toast(e.message); }
  });

  // ------------------------------------------------------------ boot
  (async function init() {
    try {
      state.settings = await api('GET', '/api/settings');
      const ledger = await api('GET', '/api/ledger');
      state.parts = (ledger.parts || []).map((p) => ({ ...p, busy: false, status: p.status === 'lookup' ? 'new' : p.status }));
    } catch (e) {
      toast(`Could not load data: ${e.message}`, 6000);
      return;
    }
    bindSettings();
    renderLedger();
    renderTree();
    refreshListings();
    checkStatus();
  })();
})();
