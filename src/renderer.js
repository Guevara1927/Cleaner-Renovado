const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const SVGNS = 'http://www.w3.org/2000/svg';

function fmt(b) {
  if (b == null) return '...';
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 100 ? 0 : 1) + ' ' + u[i];
}
const fmtTime = (ms) => (ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s');
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v); // dataset es de solo lectura: no se puede asignar
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function toast(msg, kind = '') {
  const t = el('div', { class: kind }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), 5000);
}
async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast((e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
  finally { if (btn) btn.disabled = false; }
}
function modal(title, bodyNode, actions) {
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(bodyNode);
  $('#modalActions').replaceChildren(...actions);
  $('#modal').classList.remove('hidden');
}
const closeModal = () => $('#modal').classList.add('hidden');

// Loader a pantalla completa para operaciones largas (borrar, desinstalar).
// done() muestra el resultado y se cierra solo (o con un clic); close() lo oculta sin mas.
let loaderTok = 0;
function loader(text, sub = '') {
  const tok = ++loaderTok;
  const box = $('#loader');
  box.className = '';
  $('#loaderText').textContent = text;
  $('#loaderSub').textContent = sub;
  let finished = false;
  const hide = () => { if (tok === loaderTok) box.classList.add('hidden'); };
  return {
    update(t, s = '') {
      if (finished || tok !== loaderTok) return;
      $('#loaderText').textContent = t; $('#loaderSub').textContent = s;
    },
    close() { if (!finished) { finished = true; hide(); } },
    done(t, s = '', ok = true) {
      if (finished || tok !== loaderTok) return Promise.resolve();
      finished = true;
      box.classList.add(ok ? 'done' : 'fail');
      $('#loaderText').textContent = t; $('#loaderSub').textContent = s;
      return new Promise((resolve) => {
        const end = () => { clearTimeout(timer); box.removeEventListener('click', end); hide(); resolve(); };
        const timer = setTimeout(end, ok ? 2200 : 4000);
        box.addEventListener('click', end);
      });
    },
  };
}

let isAdmin = false;

// ---------- navegacion ----------
$$('nav button').forEach((b) => b.addEventListener('click', () => {
  $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  const loaders = { proc: loadProcs, disk: loadDisks, apps: loadApps };
  const l = loaders[b.dataset.tab];
  if (l && !b.dataset.loaded) { b.dataset.loaded = '1'; l(); }
}));

// ---------- admin ----------
async function initAdmin() {
  isAdmin = await window.api.isAdmin();
  const badge = $('#adminBadge');
  badge.textContent = isAdmin ? '🛡 Administrador' : 'Sin privilegios de administrador';
  badge.className = 'badge ' + (isAdmin ? 'on' : 'off');
  $('#btnAdmin').classList.toggle('hidden', isAdmin);
}
$('#btnAdmin').addEventListener('click', () => guard(() => window.api.relaunchAdmin()));

// ---------- limpieza ----------
let cleanData = [];
function updateCleanBtn() {
  $('#cleanRun').disabled = !$$('#cleanBody input:checked').length;
}
$('#cleanScan').addEventListener('click', (ev) => guard(async () => {
  $('#cleanSummary').textContent = 'Analizando...';
  $('#cleanBody').replaceChildren();
  cleanData = await window.api.cleanScan();
  const total = cleanData.reduce((a, c) => a + c.size, 0);
  $('#cleanSummary').textContent = `Se pueden liberar aproximadamente ${fmt(total)}.`;
  $('#cleanBody').replaceChildren(...cleanData.map((c) => el('tr', {},
    el('td', {}, el('input', { type: 'checkbox', checked: c.size > 0 && !c.needsAdminWarn, dataset: { id: c.id }, onchange: updateCleanBtn })),
    el('td', {}, c.name, c.needsAdminWarn ? el('span', { class: 'tag' }, 'requiere admin') : null),
    el('td', { class: 'muted', title: c.desc }, c.desc),
    el('td', { class: 'r' }, fmt(c.size)))));
  updateCleanBtn();
}, ev.target));
$('#cleanAll').addEventListener('change', (e) => { $$('#cleanBody input').forEach((c) => (c.checked = e.target.checked)); updateCleanBtn(); });
$('#cleanRun').addEventListener('click', (ev) => guard(async () => {
  const ids = $$('#cleanBody input:checked').map((c) => c.dataset.id);
  if (!confirm(`Se eliminaran los archivos de ${ids.length} categoria(s). Continuar?`)) return;
  const ld = loader(`Limpiando ${ids.length} categoria(s)...`, 'Eliminando caches y archivos temporales');
  let rep;
  try { rep = await window.api.cleanRun(ids); } catch (e) { ld.close(); throw e; }
  const freed = rep.reduce((a, r) => a + r.freed, 0);
  const failed = rep.reduce((a, r) => a + r.failed, 0);
  ld.done('Limpieza completada', `Liberado ${fmt(freed)}` + (failed ? ` - ${failed} elementos en uso omitidos` : ''));
  toast(`Liberado ${fmt(freed)}` + (failed ? ` (${failed} elementos en uso omitidos)` : ''), 'ok');
  $('#cleanScan').click();
}, ev.target));

// ---------- RAM ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ramBusy = false, ramData = null, ramHover = null;

function ramItems(d) {
  const pal = ['#4f8cff', '#3fb950', '#e3a008', '#e5484d', '#a371f7', '#2dd4bf', '#f778ba'];
  const out = d.groups.slice(0, 6).map((g, i) => ({ id: 'g' + i, name: g.name, size: g.mem, color: pal[i], sub: `${g.count} proceso${g.count > 1 ? 's' : ''}` }));
  const rest = d.groups.slice(6).reduce((a, g) => a + g.mem, 0);
  if (rest > 0) out.push({ id: 'rest', name: 'Otros programas', size: rest, color: pal[6], sub: `${d.groups.length - 6} programas` });
  if (d.sys > 0) out.push({ id: 'sys', name: 'Sistema y controladores', size: d.sys, color: '#6b7280', sub: 'kernel, drivers, paginas modificadas' });
  if (d.standby > 0) out.push({ id: 'standby', name: 'Cache en espera', size: d.standby, color: '#2dd4bf', sub: 'reutilizable, se libera sola' });
  if (d.free > 0) out.push({ id: 'free', name: 'Libre', size: d.free, color: '#3b4252', sub: 'sin usar' });
  return out;
}

function drawRam() {
  const d = ramData;
  if (!d) return;
  const items = ramItems(d);
  const total = d.total;
  const s = svg('svg', { viewBox: '0 0 260 260' });
  let a = -Math.PI / 2;
  for (const it of items) {
    const sweep = (it.size / total) * Math.PI * 2;
    if (sweep < 0.002) continue;
    const p = svg('path', { d: slicePath(130, 130, 110, 62, a, a + Math.min(sweep, Math.PI * 2 - 0.0001)), fill: it.color, class: 'rslice', 'data-id': it.id });
    p.addEventListener('mouseenter', () => { ramHover = it.id; applyRamFocus(); });
    p.addEventListener('mouseleave', () => { ramHover = null; applyRamFocus(); });
    s.append(p);
    a += sweep;
  }
  for (const [id, y, cls] of [['rc-name', 116, 'ctr-name'], ['rc-size', 137, 'ctr-size'], ['rc-sub', 153, 'ctr-sub']]) s.append(svg('text', { x: 130, y, class: cls, id }));
  $('#ramPie').replaceChildren(s);

  $('#ramLegend').replaceChildren(...items.map((it) => el('li', { dataset: { id: it.id }, title: it.sub,
    onmouseenter: () => { ramHover = it.id; applyRamFocus(); }, onmouseleave: () => { ramHover = null; applyRamFocus(); } },
    el('span', { class: 'dot', style: `background:${it.color}` }), el('span', { class: 'nm' }, it.name), el('span', {}, fmt(it.size)),
    el('span', { class: 'pc' }, ((it.size / total) * 100).toFixed(1) + '%'))));

  const stat = (label, val) => el('div', { class: 'stat' }, el('small', {}, label), el('b', {}, val));
  $('#ramStats').replaceChildren(
    stat('Total', fmt(total)), stat('En uso', `${fmt(d.used)} (${((d.used / total) * 100).toFixed(0)}%)`),
    stat('Disponible', fmt(d.avail)), stat('Cache en espera', fmt(d.standby)));
  applyRamFocus();
}

function applyRamFocus() {
  const d = ramData;
  if (!d || !$('#rc-name')) return;
  const items = ramItems(d);
  const it = ramHover ? items.find((x) => x.id === ramHover) : null;
  const svgEl = $('#ramPie svg');
  svgEl.classList.toggle('ram-active', !!it);
  $$('#ramPie .rslice').forEach((n) => n.classList.toggle('active', !!it && n.dataset.id === it.id));
  $$('#ramLegend li').forEach((n) => n.classList.toggle('hl', !!it && n.dataset.id === it.id));
  const name = it ? it.name : 'RAM en uso', size = it ? it.size : d.used;
  $('#rc-name').textContent = name.length > 20 ? name.slice(0, 19) + '…' : name;
  $('#rc-size').textContent = fmt(size);
  $('#rc-sub').textContent = `${((size / d.total) * 100).toFixed(1)}% de ${fmt(d.total)}`;
}

async function ramTick() {
  if (ramBusy || document.hidden || !$('#tab-clean').classList.contains('active')) return;
  ramBusy = true;
  try { ramData = await window.api.ramInfo(); drawRam(); } catch { /* reintenta en el siguiente ciclo */ } finally { ramBusy = false; }
}

$('#ramClean').addEventListener('click', (ev) => guard(async () => {
  const btn = $('#ramClean');
  btn.replaceChildren(el('span', { class: 'spinner' }), 'Limpiando memoria...');
  ramBusy = true; // pausa la actualizacion en vivo mientras se limpia
  let r;
  try { r = await window.api.ramClean(); }
  finally { btn.textContent = '🚀 Limpieza de RAM'; ramBusy = false; }
  const freed = r.after.avail - r.before.avail;
  const cache = Math.max(0, r.before.standby - r.after.standby);
  const box = $('#ramResult');
  box.className = 'result';
  box.innerHTML = `✔ Limpieza completada<br><span class="delta-big">${freed > 1048576 ? '+' + fmt(freed) + ' liberados' : 'Sin cambio relevante'}</span>`
    + `<br>Memoria disponible: <b>${fmt(r.before.avail)}</b> → <b>${fmt(r.after.avail)}</b>`
    + `<br>${r.trimmed} procesos optimizados` + (r.failed ? ` (${r.failed} protegidos omitidos)` : '')
    + (r.deep ? `<br>Cache de espera del sistema liberada: <b>${fmt(cache)}</b>` : `<br>Para vaciar tambien la cache de espera del sistema, reinicia como administrador.`)
    + `<br><span class="muted small">Los programas recuperan lo que necesiten al usarse, asi que parte de la memoria volvera a ocuparse.</span>`;
  ramTick();
}, ev.target));

setInterval(ramTick, 3000);
ramTick();

// ---------- procesos inactivos ----------
let idleList = [];
const idleSel = new Set();
const IDLE_PROTECT = new Set(['explorer', 'node', 'electron', 'cleanerdev', 'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'code', 'taskmgr']);

function renderIdle() {
  $('#idleBody').replaceChildren(...idleList.map((p) => el('tr', {},
    el('td', {}, el('input', { type: 'checkbox', checked: idleSel.has(p.pid), onchange: (e) => { e.target.checked ? idleSel.add(p.pid) : idleSel.delete(p.pid); $('#idleKill').disabled = !idleSel.size; } })),
    el('td', { title: p.path }, procIcon(p), p.name),
    el('td', {}, el('span', { class: 'sw' }, p.software), p.company && p.company !== p.software ? el('small', {}, p.company) : null),
    el('td', { class: 'muted', title: p.desc }, p.desc),
    el('td', { class: 'r' }, fmt(p.mem)))));
  $('#idleKill').disabled = !idleSel.size;
}

$('#idleScan').addEventListener('click', (ev) => guard(async () => {
  idleList = []; idleSel.clear(); renderIdle();
  const sum = $('#idleSummary');
  sum.replaceChildren(el('span', { class: 'spinner' }), 'Midiendo actividad de los procesos (unos 5 segundos)...');
  const a = await window.api.procList();
  await sleep(3500);
  const b = await window.api.procList();
  const cpu0 = new Map(a.map((p) => [p.pid, p.cpu]));
  const inUse = new Set(b.filter((p) => p.title).map(groupKey)); // programas con alguna ventana abierta
  idleList = b.filter((p) => !p.critical && p.path && p.mem >= 10 * 1048576
    && !/^[a-z]:\\windows\\/i.test(p.path) && !p.title
    && !inUse.has(groupKey(p)) && !IDLE_PROTECT.has(p.name.toLowerCase())
    && !/microsoft|nvidia|realtek|intel|advanced micro|amd\b/i.test(p.company + ' ' + p.software)
    && (cpu0.has(p.pid) && p.cpu - cpu0.get(p.pid) < 0.05))
    .sort((x, y) => y.mem - x.mem);
  Object.assign(iconCache, await window.api.procIcons([...new Set(idleList.map((p) => p.path).filter((x) => x && !(x in iconCache)))]));
  const total = idleList.reduce((acc, p) => acc + p.mem, 0);
  sum.textContent = idleList.length
    ? `${idleList.length} proceso(s) sin ventana ni actividad, de programas que no tienes abiertos - ${fmt(total)} en memoria. Revisa y marca los que quieras cerrar (puede que alguno sea un servicio que necesites).`
    : '🎉 No se encontraron procesos inactivos que sea seguro cerrar.';
  renderIdle();
}, ev.target));

$('#idleKill').addEventListener('click', (ev) => guard(async () => {
  const items = idleList.filter((p) => idleSel.has(p.pid));
  const mem = items.reduce((a, p) => a + p.mem, 0);
  if (!confirm(`Cerrar ${items.length} proceso(s)? Se liberaran aprox. ${fmt(mem)}.`)) return;
  const res = await window.api.procKill(items.map((p) => ({ pid: p.pid, name: p.name })));
  const okPids = new Set(res.filter((r) => r.ok).map((r) => r.pid));
  const bad = res.filter((r) => !r.ok);
  toast(`${okPids.size} cerrado(s)` + (bad.length ? `, ${bad.length} fallaron: ${bad[0].error}` : ''), bad.length ? 'err' : 'ok');
  idleList = idleList.filter((p) => !okPids.has(p.pid)); idleSel.clear();
  renderIdle();
  ramTick();
}, ev.target));

// ---------- procesos ----------
let procs = [];
let procSort = { key: 'mem', dir: -1 };
const procSel = new Set();
const iconCache = {};

let procGrouped = false;
const collapsedGroups = new Set();

const procIcon = (p) => (p.path && iconCache[p.path]
  ? el('img', { class: 'pico', src: iconCache[p.path] })
  : el('span', { class: 'pico ph' }, p.critical ? '🛡' : '▪'));

// procesos sin software identificado se agrupan por su propio nombre
const groupKey = (p) => (p.software === 'Desconocido' ? p.name : p.software);

function procRow(p, child) {
  return el('tr', { class: child ? 'child' : '' },
    el('td', {}, el('input', { type: 'checkbox', checked: procSel.has(p.pid), disabled: p.critical,
      onchange: (e) => { e.target.checked ? procSel.add(p.pid) : procSel.delete(p.pid); updateKillBtn(); renderProcs(); } })),
    el('td', { title: (p.path || '') + (p.title ? '\nVentana: ' + p.title : '') }, procIcon(p), p.name, p.critical ? el('span', { class: 'tag crit' }, 'sistema') : null),
    el('td', { title: p.company }, el('span', { class: 'sw' }, p.software), p.company && p.company !== p.software ? el('small', {}, p.company) : null),
    el('td', { class: 'muted', title: p.desc }, p.desc),
    el('td', { class: 'r' }, p.pid), el('td', { class: 'r' }, fmt(p.mem)), el('td', { class: 'r' }, p.cpu));
}

function renderProcs() {
  const q = $('#procFilter').value.toLowerCase();
  const rows = procs.filter((p) => !q || [p.name, p.title, p.software, p.desc, p.company, String(p.pid)].some((s) => s.toLowerCase().includes(q)));
  const totalMem = procs.reduce((a, p) => a + p.mem, 0);
  let out;
  if (procGrouped) {
    // grupos por software, del mas pesado al mas liviano; dentro de cada grupo, por memoria
    const groups = new Map();
    for (const p of rows) {
      const k = groupKey(p);
      if (!groups.has(k)) groups.set(k, { name: k, items: [], mem: 0, cpu: 0 });
      const g = groups.get(k);
      g.items.push(p); g.mem += p.mem; g.cpu += p.cpu;
    }
    const list = [...groups.values()].sort((a, b) => b.mem - a.mem);
    $('#procSummary').textContent = `${rows.length} procesos en ${list.length} programas - ${fmt(totalMem)} en uso (ordenado de mayor a menor peso)`;
    out = list.flatMap((g, idx) => {
      g.items.sort((a, b) => b.mem - a.mem);
      const open = !collapsedGroups.has(g.name);
      const killable = g.items.filter((p) => !p.critical);
      const allSel = killable.length > 0 && killable.every((p) => procSel.has(p.pid));
      const someSel = killable.some((p) => procSel.has(p.pid));
      const head = el('tr', { class: 'ghead' },
        el('td', {}, el('input', { type: 'checkbox', checked: allSel, indeterminate: !allSel && someSel, disabled: !killable.length,
          title: 'Seleccionar todos los procesos de este programa',
          onchange: (e) => { killable.forEach((p) => (e.target.checked ? procSel.add(p.pid) : procSel.delete(p.pid))); renderProcs(); } })),
        el('td', { colSpan: 3, onclick: () => { open ? collapsedGroups.add(g.name) : collapsedGroups.delete(g.name); renderProcs(); } },
          el('span', { class: 'caret' }, open ? '▾' : '▸'), procIcon(g.items[0]),
          el('b', {}, `${idx + 1}. ${g.name}`), el('span', { class: 'muted' }, `  ${g.items.length} proceso${g.items.length > 1 ? 's' : ''}`)),
        el('td', {}), el('td', { class: 'r' }, el('b', {}, fmt(g.mem))), el('td', { class: 'r' }, Math.round(g.cpu * 10) / 10));
      return open ? [head, ...g.items.map((p) => procRow(p, true))] : [head];
    });
  } else {
    rows.sort((a, b) => {
      const x = a[procSort.key], y = b[procSort.key];
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * procSort.dir;
    });
    $('#procSummary').textContent = `${procs.length} procesos - ${fmt(totalMem)} en uso`;
    out = rows.map((p) => procRow(p, false));
  }
  $('#procBody').replaceChildren(...out);
  $('#procGroup').classList.toggle('primary', procGrouped);
  updateKillBtn();
}
$('#procGroup').addEventListener('click', () => { procGrouped = !procGrouped; renderProcs(); });
function updateKillBtn() { $('#procKill').disabled = !procSel.size; }
async function loadProcs() {
  await guard(async () => {
    procs = await window.api.procList();
    const alive = new Set(procs.map((p) => p.pid));
    for (const pid of [...procSel]) if (!alive.has(pid)) procSel.delete(pid);
    renderProcs();
    const missing = [...new Set(procs.map((p) => p.path).filter((p) => p && !(p in iconCache)))];
    if (missing.length) {
      Object.assign(iconCache, await window.api.procIcons(missing));
      renderProcs();
    }
  }, $('#procRefresh'));
}
$('#procRefresh').addEventListener('click', loadProcs);
$('#procFilter').addEventListener('input', renderProcs);
$$('#tab-proc th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  procGrouped = false; // ordenar por columna desactiva la agrupacion
  procSort = { key: k, dir: procSort.key === k ? -procSort.dir : (['name', 'software', 'desc'].includes(k) ? 1 : -1) };
  renderProcs();
}));
$('#procKill').addEventListener('click', (ev) => guard(async () => {
  const items = procs.filter((p) => procSel.has(p.pid)).map((p) => ({ pid: p.pid, name: p.name }));
  if (!confirm(`Finalizar ${items.length} proceso(s) y sus procesos hijos? Se puede perder trabajo sin guardar.`)) return;
  const res = await window.api.procKill(items);
  const bad = res.filter((r) => !r.ok);
  toast(`${res.length - bad.length} finalizado(s)` + (bad.length ? `, ${bad.length} fallaron: ${bad[0].error}` : ''), bad.length ? 'err' : 'ok');
  procSel.clear();
  loadProcs();
}, ev.target));

// ---------- almacenamiento ----------
const COLORS = ['#4f8cff', '#3fb950', '#e3a008', '#e5484d', '#a371f7', '#2dd4bf', '#f778ba', '#ff9f43'];
const OTHER_COLOR = '#6b7280';
const keyOf = (p) => p.toLowerCase().replace(/\\+$/, '');
const driveInfo = {};          // 'C:' -> {size, free}
const prevFree = {};           // 'C:' -> free en la carga anterior
const scanCache = new Map();   // key(path) -> resultado completo del escaneo
const sizeCache = new Map();   // key(path) -> tamano conocido (sirve como "esperado" para el %)
const view = { dir: null, entries: [], total: 0, scanning: false, scanId: 0, sort: { key: 'size', dir: -1 }, selected: new Set(), focus: null, hover: null, colors: new Map(), t0: 0, expected: null };

async function loadDisks() {
  await guard(async () => {
    const { logical, physical } = await window.api.diskList();
    $('#disks').replaceChildren(...logical.map((d) => {
      const used = d.size - d.free, pct = d.size ? Math.round((used / d.size) * 100) : 0;
      driveInfo[d.id] = { size: d.size, free: d.free };
      const before = prevFree[d.id];
      let delta = null;
      if (before != null && before !== d.free) {
        const diff = d.free - before;
        delta = el('div', { class: 'delta ' + (diff > 0 ? 'up' : 'down') }, (diff > 0 ? '▲ ' + fmt(diff) + ' liberados' : '▼ ' + fmt(-diff) + ' ocupados mas') + ' desde la ultima actualizacion');
      }
      prevFree[d.id] = d.free;
      return el('div', { class: 'card' },
        el('h4', {}, `${d.id} ${d.label}`.trim()),
        el('div', { class: 'meta' }, `${d.type}${d.fs ? ' - ' + d.fs : ''}`),
        el('div', { class: 'meter' + (pct > 90 ? ' hi' : '') }, el('div', { style: `width:${pct}%` })),
        el('div', {}, `${fmt(used)} usados de ${fmt(d.size)} (${pct}%)`),
        el('div', { class: 'muted' }, `${fmt(d.free)} libres`), delta,
        el('button', { onclick: () => openDir(d.id + '\\') }, 'Explorar'));
    }));
    $('#physical').textContent = `Discos fisicos (${physical.length}): ` + physical.map((p) => `${p.name} [${p.media}, ${fmt(p.size)}, ${p.health}]`).join(' | ');
  }, $('#diskRefresh'));
}
$('#diskRefresh').addEventListener('click', loadDisks);

const driveOf = (dir) => dir.slice(0, 2).toUpperCase();
const isRoot = (dir) => /^[A-Za-z]:\\?$/.test(dir);
const baseName = (dir) => (isRoot(dir) ? dir.slice(0, 2) : dir.replace(/\\+$/, '').split('\\').pop());

// --- evento de progreso desde main ---
window.api.onDiskEvent((ev) => {
  if (ev.id !== view.scanId) return;
  if (ev.type === 'list') {
    view.entries = ev.entries;
    renderDisk();
  } else if (ev.type === 'entry') {
    const e = view.entries.find((x) => x.path === ev.path);
    if (e) { e.size = ev.size; e.logical = ev.logical; sizeCache.set(keyOf(e.path), ev.size); }
    scheduleRender();
  } else if (ev.type === 'progress') {
    updateProgress(ev);
  }
});

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderDisk(); }, 350);
}

function updateProgress(ev) {
  const fill = $('#scanFill');
  const exp = view.expected;
  let text = `Analizando... ${ev.files.toLocaleString()} archivos - ${fmt(ev.bytes)} - ${fmtTime(ev.ms)}` + (ev.denied ? ` - ${ev.denied} carpetas sin acceso` : '');
  if (exp && exp > 0) {
    const pct = Math.min(99, (ev.bytes / exp) * 100);
    fill.classList.remove('indet');
    fill.style.width = pct.toFixed(1) + '%';
    text = `${pct.toFixed(0)}% - ` + text.replace('Analizando... ', '');
    if (pct > 3) text += ` - faltan ~${fmtTime((ev.ms / pct) * (100 - pct))}`;
  } else {
    fill.classList.add('indet');
  }
  $('#scanText').textContent = text;
  $('#scanCurrent').textContent = ev.current || '';
}

// historial de navegacion entre carpetas (Atras / Adelante)
const navHist = { back: [], fwd: [] };
function updateNavBtns() {
  $('#diskBack').disabled = !navHist.back.length;
  $('#diskFwd').disabled = !navHist.fwd.length;
}
function goBack() {
  if (!navHist.back.length || !view.dir) return;
  navHist.fwd.push(view.dir);
  openDir(navHist.back.pop(), { history: false });
}
function goFwd() {
  if (!navHist.fwd.length || !view.dir) return;
  navHist.back.push(view.dir);
  openDir(navHist.fwd.pop(), { history: false });
}

async function openDir(dir, opts = {}) {
  const { force = false, prev = null, history = true } = opts;
  if (view.scanning) window.api.diskCancel(view.scanId);
  const key = keyOf(dir);
  const sameDir = view.dir && keyOf(view.dir) === key;
  if (!sameDir) view.selected.clear();
  if (history && view.dir && !sameDir) { navHist.back.push(view.dir); navHist.fwd.length = 0; }
  updateNavBtns();
  view.dir = dir; view.focus = null; view.hover = null;
  $('#explorer').classList.remove('hidden');
  $('#diskPath').textContent = dir;

  const cached = scanCache.get(key);
  if (cached && !force) {
    view.scanId++; view.scanning = false;
    view.entries = cached.entries.map((e) => ({ ...e })); view.total = cached.total;
    showDone(cached, null, true);
    renderDisk();
    return;
  }

  const prevTotal = prev ?? (cached ? cached.total : null);
  const id = ++view.scanId;
  view.scanning = true; view.entries = []; view.total = 0;
  view.expected = isRoot(dir) ? (driveInfo[driveOf(dir)] ? driveInfo[driveOf(dir)].size - driveInfo[driveOf(dir)].free : null) : (sizeCache.get(key) || null);
  $('#scanPanel').classList.remove('hidden');
  $('#scanResult').classList.add('hidden');
  $('#scanFill').style.width = '0';
  $('#scanFill').classList.toggle('indet', !view.expected);
  $('#scanText').textContent = 'Iniciando analisis...';
  $('#scanCurrent').textContent = '';
  renderDisk();

  let res;
  try { res = await window.api.diskScan(dir, id); }
  catch (e) {
    if (id === view.scanId) { view.scanning = false; $('#scanPanel').classList.add('hidden'); }
    toast('No se pudo leer la carpeta: ' + (e.message || e).toString().replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
    return;
  }
  if (id !== view.scanId) return; // se inicio otro escaneo
  view.scanning = false;
  view.entries = res.entries; view.total = res.total;
  if (!res.cancelled) {
    scanCache.set(key, res);
    sizeCache.set(key, res.total);
  }
  showDone(res, prevTotal, false);
  renderDisk();
}

function showDone(res, prevTotal, fromCache) {
  $('#scanPanel').classList.add('hidden');
  const box = $('#scanResult');
  box.classList.remove('hidden');
  box.className = 'result';
  let html = res.cancelled
    ? `⚠ Analisis cancelado (resultados parciales: ${fmt(res.total)})`
    : `✔ Analisis completado${fromCache ? ' (guardado, pulsa Actualizar para recalcular)' : ' en ' + fmtTime(res.ms)} - <b>${res.files.toLocaleString()}</b> archivos - ocupan en disco <b>${fmt(res.total)}</b>` + (res.native ? ` (tamano de los datos: ${fmt(res.totalLogical)})` : '');
  if (!res.cancelled && res.denied) {
    html += `<br>⚠ <b>${res.denied}</b> carpeta(s) sin acceso no se pudieron contar` + (isAdmin ? '.' : ' - reinicia como administrador para incluirlas.');
  }
  const unacc = unaccounted(res.total, res.cancelled);
  if (unacc > 0) html += `<br>ℹ Espacio no contabilizado: <b>${fmt(unacc)}</b> (pagefile.sys, hiberfil.sys, tabla MFT, puntos de restauracion y archivos protegidos del sistema).`;
  if (prevTotal != null && !res.cancelled && !fromCache) {
    const diff = prevTotal - res.total;
    html += diff > 0 ? ` - 🎉 Se liberaron <b>${fmt(diff)}</b> en esta carpeta` : diff < 0 ? ` - Crecio <b>${fmt(-diff)}</b>` : ' - Sin cambios desde el analisis anterior';
  }
  box.innerHTML = html;
}

// espacio usado de la unidad que no se pudo atribuir a ninguna carpeta (solo en la raiz)
function unaccounted(total, cancelled) {
  if (cancelled || !view.dir || !isRoot(view.dir)) return 0;
  const drv = driveInfo[driveOf(view.dir)];
  if (!drv) return 0;
  const used = drv.size - drv.free;
  return used - total > used * 0.005 ? used - total : 0;
}
// base para calcular porcentajes: en la raiz, el espacio usado de la unidad
function folderBase() {
  if (view.dir && isRoot(view.dir) && !view.scanning) {
    const drv = driveInfo[driveOf(view.dir)];
    if (drv) return Math.max(drv.size - drv.free, view.total);
  }
  return view.total;
}

// --- tabla + grafico ---
function sortedEntries() {
  const { key, dir } = view.sort;
  const f = key === 'logical' ? 'logical' : 'size';
  return [...view.entries].sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name) * dir;
    const x = a[f] == null ? -1 : a[f], y = b[f] == null ? -1 : b[f];
    return (x - y) * dir || a.name.localeCompare(b.name);
  });
}

function renderDisk() {
  const total = view.entries.reduce((a, e) => a + (e.size || 0), 0);
  view.total = total;
  const rows = sortedEntries();
  // asignar colores a las 8 mayores
  view.colors = new Map();
  [...view.entries].filter((e) => e.size > 0).sort((a, b) => b.size - a.size).slice(0, COLORS.length).forEach((e, i) => view.colors.set(e.path, COLORS[i]));
  const max = Math.max(1, ...view.entries.map((e) => e.size || 0));
  const base = folderBase();
  $('#diskBody').replaceChildren(...rows.map((e) => {
    const pct = base ? ((e.size || 0) / base) * 100 : 0;
    const tr = el('tr', { dataset: { path: e.path }, onmouseenter: () => setHover(e.path), onmouseleave: () => setHover(null), onclick: (ev) => { if (ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'A') setFocus(e.path); } },
      el('td', {}, el('input', { type: 'checkbox', checked: view.selected.has(e.path), disabled: e.protected, title: e.protected ? 'Ruta protegida' : '',
        onchange: (ev) => { ev.target.checked ? view.selected.add(e.path) : view.selected.delete(e.path); if (ev.target.checked) setFocus(e.path); updateDelBtn(); } })),
      el('td', { title: e.path }, el('span', { class: 'dot', style: `background:${view.colors.get(e.path) || 'transparent'}` }),
        e.dir ? el('a', { class: 'link', onclick: () => openDir(e.path) }, '📁 ' + e.name) : '📄 ' + e.name,
        e.protected ? el('span', { class: 'tag crit' }, 'protegido') : null),
      el('td', { class: 'r', title: e.size == null ? '' : e.size.toLocaleString() + ' bytes en disco' }, e.size == null ? el('span', { class: 'spin' }, 'calculando...') : fmt(e.size)),
      el('td', { class: 'r muted', title: e.logical == null ? '' : e.logical.toLocaleString() + ' bytes' }, e.logical == null ? '' : fmt(e.logical)),
      el('td', { class: 'grow' }, e.size == null ? '' : el('div', { class: 'pctcell' }, el('div', { class: 'sizebar', style: `width:${Math.max(1, (e.size / max) * 100) * 0.6}%` }), el('span', {}, pct.toFixed(1) + '%'))));
    return tr;
  }));
  updateDelBtn();
  drawPie();
  applyFocus();
}

function updateDelBtn() {
  const live = new Set(view.entries.map((e) => e.path));
  for (const p of [...view.selected]) if (!live.has(p)) view.selected.delete(p);
  $('#diskDelete').disabled = !view.selected.size;
}

$$('th[data-dsort]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.dsort;
  view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : (k === 'name' ? 1 : -1) };
  renderDisk();
}));

function polar(cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function slicePath(cx, cy, R, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, R, a0), [x1, y1] = polar(cx, cy, R, a1);
  const [x2, y2] = polar(cx, cy, r, a1), [x3, y3] = polar(cx, cy, r, a0);
  return `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${large} 0 ${x3} ${y3} Z`;
}

function pieItems() {
  const items = view.entries.filter((e) => e.size > 0).sort((a, b) => b.size - a.size);
  const top = items.slice(0, COLORS.length);
  const rest = items.slice(COLORS.length).reduce((a, e) => a + e.size, 0);
  const out = top.map((e, i) => ({ path: e.path, name: e.name, size: e.size, color: COLORS[i], dir: e.dir }));
  if (rest > 0) out.push({ path: '__other__', name: 'Otros', size: rest, color: OTHER_COLOR, dir: false });
  const unacc = view.scanning ? 0 : unaccounted(view.total, false);
  if (unacc > 0) out.push({ path: '__unacc__', name: 'No contabilizado', size: unacc, color: '#374151', dir: false });
  return out;
}

function drawPie() {
  const items = pieItems();
  const total = items.reduce((a, i) => a + i.size, 0);
  const s = svg('svg', { viewBox: '0 0 260 260' });
  s.id = 'pieSvg';
  if (!total) {
    s.append(svg('circle', { cx: 130, cy: 130, r: 86, fill: 'none', stroke: '#2a2e39', 'stroke-width': 48 }));
  } else {
    let a = -Math.PI / 2;
    for (const it of items) {
      const sweep = (it.size / total) * Math.PI * 2;
      let d;
      if (sweep >= Math.PI * 2 - 1e-6) d = slicePath(130, 130, 110, 62, a, a + Math.PI * 2 - 0.0001);
      else d = slicePath(130, 130, 110, 62, a, a + sweep);
      const p = svg('path', { d, fill: it.color, class: 'slice', 'data-path': it.path });
      p.addEventListener('mouseenter', () => setHover(it.path));
      p.addEventListener('mouseleave', () => setHover(null));
      p.addEventListener('click', () => { if (it.dir) openDir(it.path); else if (!it.path.startsWith('__')) setFocus(it.path); });
      s.append(p);
      a += sweep;
    }
  }
  for (const cls of ['ctr-name', 'ctr-size', 'ctr-sub', 'ctr-sub2']) {
    const t = svg('text', { x: 130, y: { 'ctr-name': 118, 'ctr-size': 138, 'ctr-sub': 153, 'ctr-sub2': 165 }[cls], class: cls === 'ctr-sub2' ? 'ctr-sub' : cls, id: cls });
    s.append(t);
  }
  $('#pie').replaceChildren(s);

  $('#legend').replaceChildren(...items.map((it) => el('li', { dataset: { path: it.path }, onmouseenter: () => setHover(it.path), onmouseleave: () => setHover(null), onclick: () => { if (it.dir) openDir(it.path); else if (it.path !== '__other__') setFocus(it.path); } },
    el('span', { class: 'dot', style: `background:${it.color}` }), el('span', { class: 'nm', title: it.name }, it.name),
    el('span', {}, fmt(it.size)), el('span', { class: 'pc' }, ((it.size / total) * 100).toFixed(1) + '%'))));
}

function setHover(p) { view.hover = p; applyFocus(); }
function setFocus(p) { view.focus = p; applyFocus(); }

function applyFocus() {
  const active = view.hover || view.focus;
  const svgEl = $('#pieSvg');
  if (!svgEl) return;
  svgEl.classList.toggle('pie-active', !!active);
  const match = (p) => p && active && (p === active || (!['__other__', '__unacc__'].includes(active) && !view.colors.has(active) && p === '__other__'));
  $$('#pieSvg .slice').forEach((n) => n.classList.toggle('active', match(n.dataset.path)));
  $$('#legend li').forEach((n) => n.classList.toggle('hl', match(n.dataset.path)));
  $$('#diskBody tr').forEach((n) => n.classList.toggle('hl', !!active && n.dataset.path === active));

  // centro del grafico: el elemento relacionado (o la carpeta actual)
  const drive = view.dir ? driveInfo[driveOf(view.dir)] : null;
  let name, size, pctFolder = null;
  const base = folderBase();
  const special = active === '__other__' || active === '__unacc__';
  const ent = active && !special ? view.entries.find((e) => e.path === active) : null;
  if (ent) { name = ent.name; size = ent.size || 0; pctFolder = base ? (size / base) * 100 : 0; }
  else if (special) { const it = pieItems().find((i) => i.path === active); name = it ? it.name : ''; size = it ? it.size : 0; pctFolder = base ? (size / base) * 100 : 0; }
  else { name = view.dir ? baseName(view.dir) : ''; size = view.total; }
  const set = (id, txt) => { const n = $('#' + id); if (n) n.textContent = txt; };
  set('ctr-name', name.length > 18 ? name.slice(0, 17) + '…' : name);
  set('ctr-size', view.entries.length ? fmt(size) : '');
  set('ctr-sub', pctFolder != null ? `${pctFolder.toFixed(1)}% de la carpeta` : (view.scanning ? 'analizando...' : 'carpeta actual'));
  set('ctr-sub2', drive && drive.size ? `${((size / drive.size) * 100).toFixed(2)}% del disco ${driveOf(view.dir)}` : '');
}

$('#diskUp').addEventListener('click', () => {
  if (!view.dir) return;
  const t = view.dir.replace(/\\+$/, '');
  if (/^[A-Za-z]:$/.test(t)) {
    if (view.scanning) window.api.diskCancel(view.scanId);
    view.scanning = false; view.scanId++; view.dir = null;
    navHist.back.length = 0; navHist.fwd.length = 0; updateNavBtns();
    $('#explorer').classList.add('hidden');
    return;
  }
  const par = t.slice(0, t.lastIndexOf('\\'));
  openDir(/^[A-Za-z]:$/.test(par) ? par + '\\' : par);
});
$('#diskBack').addEventListener('click', goBack);
$('#diskFwd').addEventListener('click', goFwd);
// Alt+flechas y botones laterales del raton, solo con el explorador visible
const explorerVisible = () => $('#tab-disk').classList.contains('active') && !$('#explorer').classList.contains('hidden') && $('#modal').classList.contains('hidden');
document.addEventListener('keydown', (e) => {
  if (!e.altKey || !explorerVisible()) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goFwd(); }
});
document.addEventListener('mouseup', (e) => {
  if (!explorerVisible()) return;
  if (e.button === 3) { e.preventDefault(); goBack(); }
  else if (e.button === 4) { e.preventDefault(); goFwd(); }
});
$('#diskReload').addEventListener('click', async () => {
  if (!view.dir) return;
  const dir = view.dir;
  const prev = scanCache.get(keyOf(dir))?.total ?? null;
  await openDir(dir, { force: true, prev });
  loadDisks(); // refresca tambien el espacio libre de las unidades
});
$('#scanCancel').addEventListener('click', () => { window.api.diskCancel(view.scanId); $('#scanText').textContent = 'Cancelando...'; });

function invalidate(paths) {
  const ks = paths.map(keyOf);
  for (const k of [...scanCache.keys()]) if (ks.some((d) => k === d || k.startsWith(d + '\\') || d.startsWith(k + '\\'))) scanCache.delete(k);
  for (const k of [...sizeCache.keys()]) if (ks.some((d) => k === d || k.startsWith(d + '\\') || d.startsWith(k + '\\'))) sizeCache.delete(k);
}

$('#diskDelete').addEventListener('click', (ev) => guard(async () => {
  const paths = [...view.selected];
  const force = $('#diskForce').checked;
  if (force && !isAdmin) { toast('El borrado forzoso requiere reiniciar como administrador', 'err'); return; }
  const list = el('ul', {}, ...paths.map((p) => el('li', {}, p)));
  await new Promise((resolve) => modal(force ? 'Eliminar FORZOSAMENTE' : 'Eliminar', el('div', {},
    el('p', {}, 'Esta accion es permanente (no pasa por la papelera):'), list,
    force ? el('p', { class: 'muted' }, 'Se cerraran procesos que usen estos archivos y se tomara propiedad de los mismos.') : null), [
    el('button', { onclick: () => { closeModal(); resolve(); } }, 'Cancelar'),
    el('button', { class: 'danger', onclick: async (e) => {
      e.target.disabled = true;
      closeModal();
      await guard(async () => {
        const dir = view.dir;
        const prev = scanCache.get(keyOf(dir))?.total ?? view.total;
        const ld = loader(`Eliminando ${paths.length} elemento(s)...`, paths.length === 1 ? paths[0] : (force ? 'Borrado forzoso en curso' : 'Esto puede tardar si hay muchos archivos'));
        let res;
        try { res = await window.api.diskDelete(paths, force); } catch (err) { ld.close(); throw err; }
        const bad = res.filter((r) => !r.ok);
        const okN = res.length - bad.length;
        ld.done(bad.length ? (okN ? 'Eliminacion completada con errores' : 'No se pudo eliminar') : 'Eliminacion completada',
          `${okN} eliminado(s)` + (bad.length ? ` - ${bad.length} fallaron: ${bad[0].error}` : ''), !bad.length);
        toast(`${okN} eliminado(s)` + (bad.length ? `, ${bad.length} fallaron: ${bad[0].error}` : ''), bad.length ? 'err' : 'ok');
        view.selected.clear();
        invalidate([dir, ...paths]);
        await openDir(dir, { force: true, prev, history: false });
        loadDisks();
      });
      resolve();
    } }, 'Eliminar'),
  ]));
}, ev.target));

// ---------- aplicaciones ----------
let apps = [];
function renderApps() {
  const q = $('#appsFilter').value.toLowerCase();
  const rows = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q));
  $('#appsSummary').textContent = `${rows.length} de ${apps.length} aplicaciones`;
  $('#appsBody').replaceChildren(...rows.map((a) => el('tr', {},
    el('td', { title: a.location }, a.name), el('td', { class: 'muted' }, a.publisher), el('td', { class: 'muted' }, a.version),
    el('td', { class: 'r' }, a.sizeKB ? fmt(a.sizeKB * 1024) : '-'),
    el('td', {}, el('button', { class: 'danger', onclick: () => uninstall(a) }, 'Desinstalar')))));
}
async function loadApps() { await guard(async () => { $('#appsSummary').textContent = 'Cargando...'; apps = await window.api.appsList(); renderApps(); }, $('#appsRefresh')); }
$('#appsRefresh').addEventListener('click', loadApps);
$('#appsFilter').addEventListener('input', renderApps);

async function uninstall(a) {
  if (!confirm(`Desinstalar "${a.name}"?`)) return;
  const silent = $('#appsSilent').checked;
  const ld = loader(`Desinstalando ${a.name}...`, silent ? 'Desinstalacion silenciosa en curso' : 'Completa el asistente del desinstalador si aparece.');
  const r = await guard(() => window.api.appsUninstall(a, silent));
  if (!r) { ld.close(); return; }
  if (!r.ok) toast(`El desinstalador termino con codigo ${r.code ?? ''} ${r.error || ''}`, 'err');
  ld.update('Buscando carpetas sobrantes...', a.name);
  const left = await guard(() => window.api.appsLeftovers(a)) || [];
  loadApps();
  await ld.done(r.ok ? `${a.name} desinstalado` : 'El desinstalador termino con errores',
    (r.ok ? '' : `Codigo ${r.code ?? ''} ${r.error || ''} - `) + (left.length ? `${left.length} carpeta(s) sobrante(s) encontradas` : 'No quedaron carpetas sobrantes'), r.ok);
  if (!left.length) { toast('No se encontraron carpetas sobrantes.', 'ok'); return; }
  const checks = left.map((l) => el('input', { type: 'checkbox', checked: true, dataset: { path: l.path } }));
  const list = el('ul', {}, ...left.map((l, i) => el('li', {}, el('label', {}, checks[i], ` ${l.path} (${fmt(l.size)})`))));
  modal(`Restos de ${a.name}`, el('div', {}, el('p', {}, 'Carpetas que quedaron tras la desinstalacion:'), list), [
    el('button', { onclick: closeModal }, 'Conservar'),
    el('button', { class: 'danger', onclick: async () => {
      const paths = checks.filter((c) => c.checked).map((c) => c.dataset.path);
      closeModal();
      if (!paths.length) return;
      const ld = loader(`Eliminando restos de ${a.name}...`, `${paths.length} carpeta(s)`);
      const res = await guard(() => window.api.diskDelete(paths, isAdmin));
      if (!res) { ld.close(); return; }
      const bad = res.filter((x) => !x.ok);
      const msg = `${res.length - bad.length} carpeta(s) eliminada(s)` + (bad.length ? `, ${bad.length} fallaron` : '');
      ld.done(bad.length ? 'Restos eliminados con errores' : 'Restos eliminados', msg, !bad.length);
      toast(msg, bad.length ? 'err' : 'ok');
    } }, 'Eliminar restos'),
  ]);
}

initAdmin();
