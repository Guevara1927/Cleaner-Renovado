process.env.UV_THREADPOOL_SIZE = '64'; // mas hilos de E/S = escaneo de disco mucho mas rapido
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// ---------- utilidades ----------
const ENV = process.env;
const SYSDRIVE = (ENV.SystemDrive || 'C:').toUpperCase();
const WINDIR = ENV.SystemRoot || 'C:\\Windows';
const LOCAL = ENV.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = ENV.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const PROGRAMDATA = ENV.ProgramData || 'C:\\ProgramData';

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function ps(script) {
  const r = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; ' + script,
  ]);
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.trim() || 'PowerShell fallo');
  return r.stdout;
}

async function psJson(script) {
  const out = (await ps(script)).trim();
  if (!out) return [];
  const j = JSON.parse(out);
  return Array.isArray(j) ? j : [j];
}

const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// limitador de E/S para recorridos grandes
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}
const io = limiter(256);

// Motor rapido: robocopy /L lista archivos con su tamano sin escribir nada (usa FindFirstFile,
// sin un lstat por archivo). ~3x mas rapido que recorrer con fs. Devuelve -1 si falla.
const rbLimit = limiter(8);
const RB_DEST = path.join(os.tmpdir(), '__cleanerdev_nx_dest');
function robocopySize(dir, ctx = {}) {
  return rbLimit(() => new Promise((resolve) => {
    if (ctx.cancel) return resolve(0);
    let total = 0, buf = '';
    const p = spawn('robocopy.exe', [dir, RB_DEST, '/L', '/S', '/XJ', '/BYTES', '/NJH', '/NJS', '/NDL', '/NC', '/NP', '/R:0', '/W:0', '/FP'], { windowsHide: true });
    if (ctx.procs) ctx.procs.add(p);
    p.stdout.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^\s*(\d+)\t(.*)$/.exec(line);
        if (!m) continue;
        const s = Number(m[1]);
        total += s;
        if (ctx.bytes !== undefined) { ctx.files++; ctx.bytes += s; ctx.current = m[2].trim(); }
      }
    });
    p.on('error', () => resolve(-1));
    p.on('close', (code) => { if (ctx.procs) ctx.procs.delete(p); resolve(code >= 8 && total === 0 ? -1 : total); });
  }));
}

async function dirScan(dir, ctx) {
  const r = await robocopySize(dir, ctx);
  return r >= 0 ? r : walkSize(dir, ctx);
}

// Escaner nativo (C#, NtQueryDirectoryFile): tamano logico + espacio REAL ocupado en disco.
// Se compila una sola vez con el csc.exe que trae Windows y se guarda en userData.
const nativeCache = new Map();
function ensureNative(file) {
  if (!nativeCache.has(file)) {
    nativeCache.set(file, (async () => {
      try {
        const src = await fsp.readFile(path.join(__dirname, 'native', file), 'utf8');
        const hash = require('crypto').createHash('sha1').update(src).digest('hex').slice(0, 8);
        const base = path.basename(file, '.cs').toLowerCase();
        const dir = app.getPath('userData');
        await fsp.mkdir(dir, { recursive: true });
        const exe = path.join(dir, `${base}-${hash}.exe`);
        if (await exists(exe)) return exe;
        const cs = path.join(dir, `${base}-${hash}.cs`);
        await fsp.writeFile(cs, src);
        for (const c of [path.join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]) {
          if (!(await exists(c))) continue;
          await run(c, ['-nologo', '-optimize', '-target:exe', '-out:' + exe, cs]);
          if (await exists(exe)) return exe;
        }
      } catch { /* sin escaner nativo: se usa el respaldo */ }
      return null;
    })());
  }
  return nativeCache.get(file);
}
const ensureHelper = () => ensureNative('DiskScan.cs');

function runHelper(exe, dir, ctx, onFields) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['scan', dir], { windowsHide: true });
    if (ctx.procs) ctx.procs.add(p);
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line) onFields(line.split('\t'));
      }
    });
    p.on('error', () => resolve(false));
    p.on('close', () => { if (ctx.procs) ctx.procs.delete(p); resolve(true); });
  });
}

// tamano en disco (espacio realmente ocupado)
async function dirSize(p) {
  let st;
  try { st = await io(() => fsp.lstat(p)); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  const exe = await ensureHelper();
  if (exe) {
    let d = null;
    await runHelper(exe, p, {}, (f) => { if (f[0] === 'D') d = Number(f[3]); });
    if (d != null) return d;
  }
  return dirScan(p, { cancel: false });
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

function isAdminSync() {
  return new Promise((resolve) => {
    execFile('net.exe', ['session'], { windowsHide: true }, (err) => resolve(!err));
  });
}

// ---------- rutas protegidas ----------
function isProtected(p) {
  const n = path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const sys = SYSDRIVE.toLowerCase();
  const exact = [
    sys, '', // raiz
    path.join(sys + '\\', 'users'),
    path.join(sys + '\\', 'program files'),
    path.join(sys + '\\', 'program files (x86)'),
    PROGRAMDATA, os.homedir(), path.join(os.homedir(), 'AppData'), LOCAL, ROAMING,
    path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents'),
  ].map((x) => path.resolve(x || '\\').replace(/[\\/]+$/, '').toLowerCase());
  if (/^[a-z]:$/.test(n)) return true; // cualquier raiz de unidad
  if (exact.includes(n)) return true;
  const win = path.resolve(WINDIR).toLowerCase();
  if (n === win || n.startsWith(win + '\\')) return true;
  if (n.startsWith(sys + '\\system volume information') || n.startsWith(sys + '\\$recycle.bin') && n.split('\\').length <= 2) return true;
  if (n.startsWith(sys + '\\boot') || n === sys + '\\pagefile.sys' || n === sys + '\\hiberfil.sys' || n === sys + '\\swapfile.sys') return true;
  return false;
}

// ---------- eliminacion ----------
async function forceUnlock(p) {
  const target = psq(p);
  // cerrar procesos que ejecutan archivos dentro de la ruta
  await ps(`$t=${target}; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like ($t + '\\*') -or $_.Path -eq $t) -and $_.Id -ne ${process.pid} } | Stop-Process -Force -ErrorAction SilentlyContinue`).catch(() => {});
  // tomar propiedad y dar control total a Administradores (S-1-5-32-544)
  for (const ans of ['Y', 'S']) {
    const r = await run('takeown.exe', ['/F', p, '/R', '/D', ans]);
    if (r.code === 0) break;
  }
  await run('icacls.exe', [p, '/grant', '*S-1-5-32-544:(OI)(CI)F', '/T', '/C', '/Q']);
  await run('attrib.exe', ['-R', '-S', '-H', p, '/S', '/D']);
}

async function removePath(p, force) {
  if (isProtected(p)) return { path: p, ok: false, error: 'Ruta protegida del sistema' };
  if (!(await exists(p))) return { path: p, ok: true };
  try { await fsp.rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* seguir */ }
  if (!(await exists(p))) return { path: p, ok: true };
  if (!force) return { path: p, ok: false, error: 'En uso o sin permisos (prueba "Forzar")' };

  await forceUnlock(p);
  try { await fsp.rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* seguir */ }
  if (await exists(p)) {
    const st = await fsp.lstat(p).catch(() => null);
    if (st && st.isDirectory()) await run('cmd.exe', ['/d', '/c', 'rd', '/s', '/q', p]);
    else await run('cmd.exe', ['/d', '/c', 'del', '/f', '/q', '/a', p]);
  }
  if (!(await exists(p))) return { path: p, ok: true };
  return { path: p, ok: false, error: 'No se pudo eliminar (bloqueado por el sistema; reinicia e intenta de nuevo)' };
}

// elimina el CONTENIDO de un directorio (no el directorio)
async function emptyDir(dir, force) {
  let ents;
  try { ents = await fsp.readdir(dir); } catch { return { removed: 0, failed: 0 }; }
  let removed = 0, failed = 0;
  for (const name of ents) {
    const r = await removePath(path.join(dir, name), force);
    r.ok ? removed++ : failed++;
  }
  return { removed, failed };
}

// ---------- categorias de limpieza ----------
async function globDirs(base, test) {
  try {
    const ents = await fsp.readdir(base, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && test(e.name)).map((e) => path.join(base, e.name));
  } catch { return []; }
}

async function chromiumCaches(userDataDir) {
  const out = [];
  const profiles = await globDirs(userDataDir, (n) => n === 'Default' || /^Profile \d+$/.test(n));
  for (const p of profiles) {
    for (const sub of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) out.push(path.join(p, sub));
  }
  return out;
}

async function buildCategories() {
  const firefox = await globDirs(path.join(LOCAL, 'Mozilla', 'Firefox', 'Profiles'), () => true);
  const cats = [
    { id: 'user-temp', name: 'Temporales del usuario', desc: ENV.TEMP || os.tmpdir(), paths: [ENV.TEMP || os.tmpdir()], admin: false },
    { id: 'win-temp', name: 'Temporales de Windows', desc: path.join(WINDIR, 'Temp'), paths: [path.join(WINDIR, 'Temp')], admin: true },
    { id: 'prefetch', name: 'Prefetch', desc: path.join(WINDIR, 'Prefetch'), paths: [path.join(WINDIR, 'Prefetch')], admin: true },
    { id: 'wu', name: 'Descargas de Windows Update', desc: path.join(WINDIR, 'SoftwareDistribution', 'Download'), paths: [path.join(WINDIR, 'SoftwareDistribution', 'Download')], admin: true },
    { id: 'inetcache', name: 'Cache de internet (INetCache)', desc: path.join(LOCAL, 'Microsoft', 'Windows', 'INetCache'), paths: [path.join(LOCAL, 'Microsoft', 'Windows', 'INetCache')], admin: false },
    { id: 'wer', name: 'Informes de errores y volcados', desc: 'CrashDumps, WER, Minidump', paths: [path.join(LOCAL, 'CrashDumps'), path.join(LOCAL, 'Microsoft', 'Windows', 'WER'), path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER'), path.join(WINDIR, 'Minidump')], admin: false },
    { id: 'chrome', name: 'Cache de Google Chrome', desc: 'Chrome\\User Data', paths: await chromiumCaches(path.join(LOCAL, 'Google', 'Chrome', 'User Data')), admin: false },
    { id: 'edge', name: 'Cache de Microsoft Edge', desc: 'Edge\\User Data', paths: await chromiumCaches(path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')), admin: false },
    { id: 'brave', name: 'Cache de Brave', desc: 'BraveSoftware', paths: await chromiumCaches(path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')), admin: false },
    { id: 'firefox', name: 'Cache de Firefox', desc: 'Mozilla\\Firefox\\Profiles', paths: firefox.map((f) => path.join(f, 'cache2')), admin: false },
    { id: 'dev', name: 'Caches de desarrollo (npm, pip, yarn, NuGet http)', desc: 'npm-cache, pip\\Cache, Yarn\\Cache', paths: [path.join(LOCAL, 'npm-cache'), path.join(LOCAL, 'pip', 'Cache'), path.join(LOCAL, 'Yarn', 'Cache'), path.join(LOCAL, 'NuGet', 'v3-cache')], admin: false },
    { id: 'electron-cache', name: 'Caches de apps Electron (Code, Slack, Discord, Teams)', desc: 'Roaming\\<app>\\Cache, Code Cache, GPUCache', paths: ['Code', 'Slack', 'discord', 'Microsoft\\Teams', 'Spotify'].flatMap((a) => ['Cache', 'Code Cache', 'GPUCache', 'CachedData'].map((s) => path.join(ROAMING, a, s))), admin: false },
    { id: 'thumbs', name: 'Miniaturas de Explorer', desc: path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer'), paths: [], files: true, admin: false },
    { id: 'recycle', name: 'Papelera de reciclaje', desc: 'Todas las unidades', paths: [], special: 'recycle', admin: false },
  ];
  return cats;
}

async function thumbFiles() {
  const dir = path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer');
  try {
    return (await fsp.readdir(dir)).filter((n) => /^(thumbcache|iconcache).*\.db$/i.test(n)).map((n) => path.join(dir, n));
  } catch { return []; }
}

async function recycleSize() {
  try {
    const out = await ps(`$s=(New-Object -ComObject Shell.Application).NameSpace(10); ($s.Items() | ForEach-Object { $_.Size } | Measure-Object -Sum).Sum`);
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

ipcMain.handle('clean:scan', async () => {
  const cats = await buildCategories();
  const isAdmin = await isAdminSync();
  const result = await Promise.all(cats.map(async (c) => {
    let size = 0;
    if (c.special === 'recycle') size = await recycleSize();
    else if (c.files) size = (await Promise.all((await thumbFiles()).map(dirSize))).reduce((a, b) => a + b, 0);
    else size = (await Promise.all(c.paths.map(dirSize))).reduce((a, b) => a + b, 0);
    return { id: c.id, name: c.name, desc: c.desc, admin: c.admin, needsAdminWarn: c.admin && !isAdmin, size };
  }));
  return result;
});

ipcMain.handle('clean:run', async (_e, ids) => {
  const cats = (await buildCategories()).filter((c) => ids.includes(c.id));
  const report = [];
  for (const c of cats) {
    const before = c.special === 'recycle' ? await recycleSize() : c.files ? (await Promise.all((await thumbFiles()).map(dirSize))).reduce((a, b) => a + b, 0) : (await Promise.all(c.paths.map(dirSize))).reduce((a, b) => a + b, 0);
    let failed = 0;
    if (c.special === 'recycle') {
      await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue').catch(() => {});
    } else if (c.files) {
      for (const f of await thumbFiles()) { const r = await removePath(f, false); if (!r.ok) failed++; }
    } else {
      for (const p of c.paths) failed += (await emptyDir(p, false)).failed;
    }
    const after = c.special === 'recycle' ? await recycleSize() : c.files ? (await Promise.all((await thumbFiles()).map(dirSize))).reduce((a, b) => a + b, 0) : (await Promise.all(c.paths.map(dirSize))).reduce((a, b) => a + b, 0);
    report.push({ id: c.id, name: c.name, freed: Math.max(0, before - after), failed });
  }
  return report;
});

// ---------- procesos ----------
const CRITICAL = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'dwm', 'fontdrvhost', 'memory compression', 'secure system']);

// nombre (minusculas) -> [funcion del proceso, software]
const KNOWN = {
  system: ['Nucleo de Windows: controladores y tareas del kernel', 'Windows'],
  idle: ['Tiempo de CPU libre (no es un programa real)', 'Windows'],
  registry: ['Mantiene el registro de Windows en memoria', 'Windows'],
  smss: ['Administrador de sesiones; inicia el sistema', 'Windows'],
  csrss: ['Subsistema de ejecucion cliente/servidor; ventanas y consola', 'Windows'],
  wininit: ['Inicializa servicios y el subsistema de seguridad al arrancar', 'Windows'],
  winlogon: ['Gestiona inicio y cierre de sesion', 'Windows'],
  services: ['Administrador de control de servicios de Windows', 'Windows'],
  lsass: ['Autoridad de seguridad local: autenticacion y politicas', 'Windows'],
  svchost: ['Host generico que ejecuta servicios de Windows (red, audio, actualizaciones...)', 'Windows'],
  dwm: ['Administrador de ventanas del escritorio: efectos y composicion grafica', 'Windows'],
  fontdrvhost: ['Host de controladores de fuentes', 'Windows'],
  explorer: ['Explorador de Windows: escritorio, barra de tareas y carpetas', 'Windows'],
  taskhostw: ['Host de tareas de Windows', 'Windows'],
  sihost: ['Host de la infraestructura de shell (menus y notificaciones)', 'Windows'],
  ctfmon: ['Metodos de entrada de texto e idioma del teclado', 'Windows'],
  runtimebroker: ['Gestiona permisos de apps de la Tienda', 'Windows'],
  searchhost: ['Busqueda de Windows / menu de inicio', 'Windows'],
  searchindexer: ['Indexa archivos para acelerar las busquedas', 'Windows'],
  startmenuexperiencehost: ['Menu Inicio de Windows', 'Windows'],
  shellexperiencehost: ['Elementos de la interfaz de Windows (calendario, reloj...)', 'Windows'],
  textinputhost: ['Teclado tactil y panel de emojis', 'Windows'],
  audiodg: ['Aislamiento de graficos de dispositivos de audio', 'Windows'],
  spoolsv: ['Cola de impresion', 'Windows'],
  conhost: ['Ventana de consola para aplicaciones de linea de comandos', 'Windows'],
  dllhost: ['Host COM; ejecuta componentes y miniaturas', 'Windows'],
  wmiprvse: ['Proveedor WMI: consultas de administracion del sistema', 'Windows'],
  taskmgr: ['Administrador de tareas', 'Windows'],
  msmpeng: ['Antivirus de Microsoft Defender (proteccion en tiempo real)', 'Microsoft Defender'],
  nissrv: ['Proteccion de red de Microsoft Defender', 'Microsoft Defender'],
  securityhealthservice: ['Servicio de Seguridad de Windows', 'Windows'],
  securityhealthsystray: ['Icono de Seguridad de Windows en la bandeja', 'Windows'],
  wudfhost: ['Host de controladores de dispositivos en modo usuario', 'Windows'],
  lsaiso: ['Aislamiento de credenciales (Credential Guard)', 'Windows'],
  msedge: ['Navegador Microsoft Edge', 'Microsoft Edge'],
  msedgewebview2: ['Componente web incrustado (WebView2) usado por otras apps', 'Microsoft Edge'],
  chrome: ['Navegador Google Chrome (un proceso por pestana/extension)', 'Google Chrome'],
  firefox: ['Navegador Mozilla Firefox', 'Mozilla Firefox'],
  brave: ['Navegador Brave', 'Brave'],
  code: ['Editor Visual Studio Code', 'Visual Studio Code'],
  node: ['Entorno de ejecucion de JavaScript (Node.js)', 'Node.js'],
  electron: ['Aplicacion basada en Electron', 'Electron'],
  powershell: ['Consola de comandos PowerShell', 'Windows PowerShell'],
  pwsh: ['Consola de comandos PowerShell 7', 'PowerShell'],
  cmd: ['Simbolo del sistema', 'Windows'],
  windowsterminal: ['Terminal de Windows', 'Windows Terminal'],
  onedrive: ['Sincroniza archivos con OneDrive', 'Microsoft OneDrive'],
  teams: ['Microsoft Teams: chat y videollamadas', 'Microsoft Teams'],
  discord: ['Chat de voz y texto Discord', 'Discord'],
  spotify: ['Reproductor de musica Spotify', 'Spotify'],
  steam: ['Cliente de la plataforma de juegos Steam', 'Steam'],
  steamwebhelper: ['Componente de interfaz web de Steam', 'Steam'],
  slack: ['Mensajeria de equipos Slack', 'Slack'],
  whatsapp: ['Mensajeria WhatsApp', 'WhatsApp'],
  docker: ['Contenedores Docker', 'Docker'],
  'docker desktop': ['Docker Desktop', 'Docker'],
  sqlservr: ['Motor de base de datos SQL Server', 'Microsoft SQL Server'],
  postgres: ['Servidor de base de datos PostgreSQL', 'PostgreSQL'],
  mysqld: ['Servidor de base de datos MySQL', 'MySQL'],
  winword: ['Microsoft Word', 'Microsoft Office'], excel: ['Microsoft Excel', 'Microsoft Office'],
  powerpnt: ['Microsoft PowerPoint', 'Microsoft Office'], outlook: ['Microsoft Outlook', 'Microsoft Office'],
};

ipcMain.handle('proc:list', async () => {
  const rows = await psJson(`$procs=@(Get-Process); $vi=@{}; foreach($p in ($procs | Where-Object {$_.Path} | Select-Object -ExpandProperty Path -Unique)){ try{ $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p); $vi[$p]=@{c=$v.CompanyName;d=$v.FileDescription;p=$v.ProductName} }catch{} }; $r=@($procs | ForEach-Object { $x=$null; if($_.Path){$x=$vi[$_.Path]}; [pscustomobject]@{Id=$_.Id;ProcessName=$_.ProcessName;Mem=[int64]$_.WorkingSet64;Cpu=[math]::Round([double]$_.CPU,1);MainWindowTitle=$_.MainWindowTitle;Path=$_.Path;Company=$x.c;Desc=$x.d;Product=$x.p} }); ConvertTo-Json -InputObject $r -Compress`);
  return rows.map((r) => {
    const key = String(r.ProcessName).toLowerCase();
    const k = KNOWN[key];
    const clean = (s) => (s || '').toString().trim();
    const desc = k ? k[0] : (clean(r.Desc) || 'Sin descripcion disponible');
    const software = k ? k[1] : (clean(r.Product) || clean(r.Company) || (r.Path ? 'Desconocido' : 'Windows (nucleo)'));
    return {
      pid: r.Id, name: r.ProcessName, mem: r.Mem || 0, cpu: r.Cpu || 0, title: r.MainWindowTitle || '', path: r.Path || '',
      critical: CRITICAL.has(key), desc, software, company: clean(r.Company),
    };
  });
});

const iconCache = new Map();
ipcMain.handle('proc:icons', async (_e, paths) => {
  const out = {};
  await Promise.all(paths.map(async (p) => {
    if (!iconCache.has(p)) {
      try { iconCache.set(p, (await app.getFileIcon(p, { size: 'small' })).toDataURL()); } catch { iconCache.set(p, ''); }
    }
    out[p] = iconCache.get(p);
  }));
  return out;
});

ipcMain.handle('proc:kill', async (_e, items) => {
  const out = [];
  for (const { pid, name } of items) {
    if (pid === process.pid) { out.push({ pid, ok: false, error: 'Es esta aplicacion' }); continue; }
    if (pid <= 4 || CRITICAL.has(String(name).toLowerCase())) { out.push({ pid, ok: false, error: 'Proceso critico del sistema' }); continue; }
    const r = await run('taskkill.exe', ['/PID', String(pid), '/F', '/T']);
    out.push({ pid, ok: r.code === 0, error: r.code === 0 ? '' : (r.stderr || r.stdout).trim().split('\n')[0] });
  }
  return out;
});

// ---------- almacenamiento ----------
ipcMain.handle('disk:list', async () => {
  const logical = await psJson(`$r=@(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,@{n='Size';e={[int64]$_.Size}},@{n='Free';e={[int64]$_.FreeSpace}},DriveType); ConvertTo-Json -InputObject $r -Compress`);
  let physical = [];
  try {
    physical = await psJson(`$r=@(Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus,@{n='Size';e={[int64]$_.Size}}); ConvertTo-Json -InputObject $r -Compress`);
  } catch { /* requiere modulo Storage */ }
  const types = { 2: 'Extraible', 3: 'Local', 4: 'Red', 5: 'CD/DVD', 6: 'RAM' };
  return {
    logical: logical.map((d) => ({ id: d.DeviceID, label: d.VolumeName || '', fs: d.FileSystem || '', size: d.Size || 0, free: d.Free || 0, type: types[d.DriveType] || 'Otro' })),
    physical: physical.map((d) => ({ name: d.FriendlyName, media: String(d.MediaType), health: String(d.HealthStatus), size: d.Size || 0 })),
  };
});

// Escaneo de una carpeta: una sola pasada, con progreso, resultados parciales y cancelacion.
const scans = new Map();

async function walkSize(d, ctx) {
  if (ctx.cancel) return 0;
  ctx.current = d;
  let ents;
  try { ents = await io(() => fsp.readdir(d, { withFileTypes: true })); } catch { return 0; }
  let total = 0;
  await Promise.all(ents.map(async (e) => {
    if (ctx.cancel || e.isSymbolicLink()) return;
    const f = path.join(d, e.name);
    if (e.isDirectory()) { const sub = await walkSize(f, ctx); total += sub; return; }
    try {
      const s = (await io(() => fsp.lstat(f))).size;
      total += s; ctx.files++; ctx.bytes += s;
    } catch { /* ignorar */ }
  }));
  return total;
}

ipcMain.handle('disk:scan', async (e, dir, id) => {
  const base = /^[A-Za-z]:$/.test(dir) ? dir + '\\' : dir;
  const ctx = { cancel: false, files: 0, bytes: 0, current: base, procs: new Set() };
  scans.set(id, ctx);
  const t0 = Date.now();
  const send = (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, payload); };
  let ents;
  try { ents = await fsp.readdir(base, { withFileTypes: true }); } catch (err) { scans.delete(id); throw err; }
  const entries = ents.map((en) => {
    const full = path.join(base, en.name);
    const link = en.isSymbolicLink();
    return { name: en.name, path: full, dir: en.isDirectory() && !link, link, size: null, protected: isProtected(full) };
  });
  send('disk:event', { type: 'list', id, entries });
  const timer = setInterval(() => send('disk:event', { type: 'progress', id, files: ctx.files, bytes: ctx.bytes, denied: ctx.denied || 0, current: ctx.current, ms: Date.now() - t0 }), 150);
  const exe = await ensureHelper();
  const byName = new Map(entries.map((x) => [x.name, x]));
  const deniedSample = [];
  try {
    if (exe) {
      await runHelper(exe, base, ctx, (f) => {
        const t = f[0];
        if (t === 'F' || t === 'C') {
          const en = byName.get(f[1]);
          if (!en) return;
          en.logical = Number(f[2]); en.size = Number(f[3]);
          send('disk:event', { type: 'entry', id, path: en.path, size: en.size, logical: en.logical });
        } else if (t === 'P' || t === 'D') {
          ctx.files = Number(f[1]); ctx.bytes = Number(f[3]); ctx.denied = Number(f[4]);
          if (t === 'P' && f[5]) ctx.current = f[5];
        } else if (t === 'X') deniedSample.push(f[1]);
      });
      for (const en of entries) if (en.size == null) { en.size = 0; en.logical = 0; }
    } else {
      // respaldo sin escaner nativo: tamano logico via robocopy
      await Promise.all(entries.map(async (en) => {
        if (ctx.cancel) return;
        if (en.link) en.size = 0;
        else if (en.dir) en.size = await dirScan(en.path, ctx);
        else {
          try { en.size = (await io(() => fsp.lstat(en.path))).size; } catch { en.size = 0; }
          ctx.files++; ctx.bytes += en.size;
        }
        en.logical = en.size;
        if (!ctx.cancel) send('disk:event', { type: 'entry', id, path: en.path, size: en.size, logical: en.logical });
      }));
    }
  } finally { clearInterval(timer); scans.delete(id); }
  const total = entries.reduce((a, x) => a + (x.size || 0), 0);
  const totalLogical = entries.reduce((a, x) => a + (x.logical || 0), 0);
  return { id, entries, total, totalLogical, files: ctx.files, bytes: ctx.bytes, denied: ctx.denied || 0, deniedSample, native: !!exe, ms: Date.now() - t0, cancelled: ctx.cancel };
});

ipcMain.handle('disk:cancel', (_e, id) => { const c = scans.get(id); if (c) { c.cancel = true; for (const p of c.procs) p.kill(); } return true; });

ipcMain.handle('disk:delete', async (_e, paths, force) => {
  if (force && !(await isAdminSync())) throw new Error('El borrado forzoso requiere ejecutar como administrador');
  const out = [];
  for (const p of paths) out.push(await removePath(p, !!force));
  return out;
});

// ---------- aplicaciones ----------
ipcMain.handle('apps:list', async () => {
  const rows = await psJson(String.raw`$p='HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; $r=@(Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and ($_.UninstallString -or $_.QuietUninstallString) } | Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation,UninstallString,QuietUninstallString,EstimatedSize,InstallDate); ConvertTo-Json -InputObject $r -Compress`);
  const seen = new Set();
  const apps = [];
  for (const r of rows) {
    const key = (r.DisplayName + '|' + (r.DisplayVersion || '')).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({
      name: r.DisplayName, version: r.DisplayVersion || '', publisher: r.Publisher || '',
      location: (r.InstallLocation || '').replace(/^"|"$/g, '').trim(),
      uninstall: r.UninstallString || '', quiet: r.QuietUninstallString || '',
      sizeKB: Number(r.EstimatedSize) || 0, date: r.InstallDate || '',
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
});

ipcMain.handle('apps:uninstall', async (_e, appInfo, silent) => {
  let cmd = (silent && appInfo.quiet) ? appInfo.quiet : appInfo.uninstall;
  if (!cmd) throw new Error('Esta aplicacion no tiene desinstalador');
  cmd = cmd.replace(/msiexec(\.exe)?\s+\/I\s*\{/i, (m) => m.replace(/\/I/i, '/X'));
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true, windowsHide: false });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0 || code === 3010, code }));
  });
});

// Busca restos: carpeta de instalacion y carpetas de datos con nombre exacto de la app/editor
ipcMain.handle('apps:leftovers', async (_e, appInfo) => {
  const cand = new Set();
  if (appInfo.location) cand.add(path.resolve(appInfo.location));
  const names = [appInfo.name].filter(Boolean);
  const bases = [ROAMING, LOCAL, PROGRAMDATA, path.join(ENV.ProgramFiles || 'C:\\Program Files'), path.join(ENV['ProgramFiles(x86)'] || 'C:\\Program Files (x86)')];
  for (const b of bases) {
    let ents = [];
    try { ents = await fsp.readdir(b, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (names.some((n) => n.toLowerCase() === e.name.toLowerCase())) cand.add(path.join(b, e.name));
    }
  }
  const out = [];
  for (const p of cand) {
    if (!(await exists(p)) || isProtected(p)) continue;
    out.push({ path: p, size: await dirSize(p) });
  }
  return out;
});

// ---------- memoria RAM ----------
async function memPerf() {
  try {
    const r = (await psJson(`$r=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object FreeAndZeroPageListBytes,StandbyCacheCoreBytes,StandbyCacheNormalPriorityBytes,StandbyCacheReserveBytes,ModifiedPageListBytes; ConvertTo-Json -InputObject @($r) -Compress`))[0] || {};
    return {
      standby: (Number(r.StandbyCacheCoreBytes) || 0) + (Number(r.StandbyCacheNormalPriorityBytes) || 0) + (Number(r.StandbyCacheReserveBytes) || 0),
      modified: Number(r.ModifiedPageListBytes) || 0,
    };
  } catch { return { standby: 0, modified: 0 }; }
}

ipcMain.handle('ram:info', async () => {
  const total = os.totalmem(), avail = os.freemem();
  const [tl, perf] = await Promise.all([run('tasklist.exe', ['/fo', 'csv', '/nh']), memPerf()]);
  const map = new Map();
  for (const line of tl.stdout.split('\n')) {
    const cols = line.trim().replace(/^"|"$/g, '').split('","');
    if (cols.length < 5) continue;
    const name = cols[0].replace(/\.exe$/i, '');
    const mem = (parseInt(cols[4].replace(/\D/g, ''), 10) || 0) * 1024;
    const known = KNOWN[name.toLowerCase()];
    const label = known ? known[1] : name;
    const k = label.toLowerCase();
    if (!map.has(k)) map.set(k, { name: label, mem: 0, count: 0 });
    const g = map.get(k);
    g.mem += mem; g.count++;
  }
  let groups = [...map.values()].sort((a, b) => b.mem - a.mem);
  const used = Math.max(0, total - avail);
  const procSum = groups.reduce((a, g) => a + g.mem, 0);
  let sys = Math.max(0, used - procSum);
  if (procSum > used && procSum > 0) { const f = used / procSum; groups = groups.map((g) => ({ ...g, mem: g.mem * f })); sys = 0; }
  const standby = Math.min(perf.standby, avail);
  return { total, avail, used, standby, free: Math.max(0, avail - standby), modified: perf.modified, sys, groups };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('ram:clean', async () => {
  const exe = await ensureNative('RamClean.cs');
  if (!exe) throw new Error('No se pudo preparar el limpiador de RAM (compilador de Windows no disponible)');
  const admin = await isAdminSync();
  const bPerf = await memPerf();
  const before = { avail: os.freemem(), standby: bPerf.standby, modified: bPerf.modified };
  const own = [process.pid, ...app.getAppMetrics().map((m) => m.pid)].map(String);
  const r = await run(exe, own);
  let trimmed = 0, failed = 0, deep = false;
  for (const line of r.stdout.split('\n')) {
    const f = line.trim().split('\t');
    if (f[0] === 'T') { trimmed = Number(f[1]); failed = Number(f[2]); }
    if (f[0] === 'S') deep = Number(f[2]) === 0;
  }
  await run('ipconfig.exe', ['/flushdns']); // cache DNS (si hay permisos)
  await sleep(1500);
  const aPerf = await memPerf();
  const after = { avail: os.freemem(), standby: aPerf.standby, modified: aPerf.modified };
  return { total: os.totalmem(), before, after, trimmed, failed, deep, admin };
});

// ---------- sistema / admin ----------
ipcMain.handle('sys:isAdmin', () => isAdminSync());

ipcMain.handle('sys:relaunchAdmin', async () => {
  const args = app.isPackaged ? '' : `-ArgumentList ${psq('"' + app.getAppPath() + '"')}`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath ${psq(process.execPath)} ${args} -Verb RunAs`]);
  if (r.code !== 0) throw new Error('Elevacion cancelada o fallida');
  setTimeout(() => app.quit(), 300);
  return true;
});

// ---------- ventana ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 900, minHeight: 600,
    backgroundColor: '#14161c', title: 'CleanerDev', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => { createWindow(); ensureHelper(); ensureNative('RamClean.cs'); });
app.on('window-all-closed', () => app.quit());
