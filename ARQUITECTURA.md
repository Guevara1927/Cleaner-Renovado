# CleanerDev – Arquitectura y flujo de trabajo

Aplicación de escritorio para Windows que limpia caches y temporales, finaliza procesos, administra el almacenamiento (con borrado forzoso) y desinstala aplicaciones.

## 1. Con qué está hecho

| Capa | Tecnología | Uso |
|---|---|---|
| Shell de escritorio | **Electron 33** | Ventana, IPC, empaquetado |
| Runtime | **Node.js** (`fs`, `path`, `os`, `child_process`) | Lógica del sistema de archivos y ejecución de comandos |
| Interfaz | **HTML + CSS + JavaScript vanilla** | Sin frameworks ni bundler |
| Acceso a Windows | **PowerShell 5.1** y utilidades nativas: `taskkill`, `takeown`, `icacls`, `attrib`, `net session`, `cmd rd/del` | Procesos, discos, registro, permisos |
| Empaquetado | **electron-builder** (target `portable`, `requireAdministrator`) | Genera el `.exe` con `npm run dist` |

No hay dependencias en runtime; solo `electron` y `electron-builder` como `devDependencies`.

## 2. Estructura de archivos

```
CleanerDev/
├─ package.json          Scripts (start, dist) y config de electron-builder
├─ ARQUITECTURA.md       Este documento
└─ src/
   ├─ main.js            Proceso principal: toda la lógica privilegiada + handlers IPC
   ├─ preload.js         Puente seguro (contextBridge) entre UI y main
   ├─ index.html         Estructura de la UI (4 pestañas + modal + toasts)
   ├─ renderer.js        Lógica de la UI, renderizado y llamadas a window.api
   └─ styles.css         Tema oscuro
```

## 3. Arquitectura

```
┌──────────────────────────── Proceso Renderer (sandbox) ────────────────────────────┐
│  index.html + styles.css + renderer.js                                              │
│  - Pinta tablas, tarjetas, modales                                                  │
│  - No tiene acceso a Node ni al sistema                                             │
│  - Solo conoce  window.api.*                                                        │
└──────────────────────────────────────┬──────────────────────────────────────────────┘
                                       │ window.api.xxx()
                         ┌─────────────▼─────────────┐
                         │ preload.js (contextBridge)│  Lista blanca de 13 funciones,
                         │ ipcRenderer.invoke(canal) │  cada una mapea a un canal IPC
                         └─────────────┬─────────────┘
                                       │ IPC (invoke/handle, async)
┌──────────────────────────────────────▼──────────────────────────────────────────────┐
│                           Proceso Main  (main.js, Node)                              │
│                                                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐                        │
│  │ clean:* │ │ proc:*  │ │ disk:*  │ │ apps:*  │ │  sys:*   │   ← handlers IPC       │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘                        │
│       └───────────┴───────────┼───────────┴───────────┘                              │
│                    Utilidades compartidas                                            │
│   run() / ps() / psJson()   dirSize() + limiter   isProtected()   removePath()       │
└───────────────┬──────────────────────────┬────────────────────────┬──────────────────┘
                │                          │                        │
        PowerShell / CIM            Sistema de archivos        Utilidades Windows
   (Get-Process, Win32_LogicalDisk,  (fs.promises: readdir,     (taskkill, takeown,
    registro Uninstall, papelera)     lstat, rm)                 icacls, attrib, cmd)
```

### Decisiones de seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`: el renderer no puede ejecutar código de sistema.
- **CSP** estricta en `index.html` (`default-src 'self'`, sin scripts inline).
- El preload expone **funciones concretas**, no `ipcRenderer` completo.
- Toda la lógica destructiva vive en `main.js`, donde se aplica `isProtected()` antes de borrar, sin importar lo que envíe la UI.

### Módulos dentro de `main.js`

| Módulo | Canales IPC | Qué hace |
|---|---|---|
| **Utilidades** | – | `run` (execFile), `ps`/`psJson` (PowerShell → JSON), `dirSize` (recorrido recursivo con limitador de 96 operaciones de E/S concurrentes), `exists` |
| **Protección** | – | `isProtected(path)`: bloquea raíces de unidad, `C:\Windows`, `Program Files`, `Users`, ProgramData, perfil del usuario, `System Volume Information`, `pagefile/hiberfil`, etc. |
| **Eliminación** | – | `removePath(p, force)`, `forceUnlock(p)`, `emptyDir(dir)` |
| **Limpieza** | `clean:scan`, `clean:run` | Define categorías (`buildCategories`), mide tamaño antes/después y reporta lo liberado |
| **Procesos** | `proc:list`, `proc:kill` | `Get-Process` → JSON; `taskkill /PID n /F /T`; lista de procesos críticos bloqueados |
| **Almacenamiento** | `disk:list`, `disk:ls`, `disk:size`, `disk:delete` | Unidades lógicas y físicas, listado de carpetas, tamaño bajo demanda, borrado normal/forzoso |
| **Aplicaciones** | `apps:list`, `apps:uninstall`, `apps:leftovers` | Lee el registro (HKLM, WOW6432Node, HKCU), ejecuta el desinstalador, busca restos |
| **Sistema** | `sys:isAdmin`, `sys:relaunchAdmin` | Detecta admin con `net session`; relanza con `Start-Process -Verb RunAs` |

## 4. Flujos de trabajo

### 4.1 Arranque
1. `app.whenReady()` → crea `BrowserWindow` con preload y carga `index.html`.
2. `renderer.js` llama a `api.isAdmin()` y muestra la insignia (🛡 admin / sin privilegios).
3. Las pestañas Procesos, Almacenamiento y Aplicaciones cargan sus datos **de forma perezosa** al abrirse por primera vez.

### 4.2 Limpieza
```
Analizar → clean:scan → por categoría: dirSize() de cada ruta → tabla con tamaños
Marcar categorías → Limpiar → confirm()
  → clean:run(ids): medir "antes" → emptyDir()/Clear-RecycleBin → medir "después"
  → reporte {liberado, fallidos} → toast → re-análisis automático
```
- Borra el **contenido** de las carpetas, no las carpetas.
- Archivos en uso se omiten y se cuentan como fallidos (borrado sin `force`).
- Las categorías que requieren admin se marcan y quedan desmarcadas por defecto si no se es admin.

### 4.3 Procesos
```
proc:list → tabla (filtro, orden por columna) → seleccionar → Finalizar → confirm()
  → proc:kill: descarta PID ≤ 4, el propio proceso y los críticos → taskkill /F /T → resultado por PID
```

### 4.4 Almacenamiento
```
disk:list → tarjetas por unidad (usado/libre/%) + discos físicos
Explorar → disk:ls(dir): lista inmediata (archivos con tamaño, carpetas "calculando...")
         → 3 workers llaman a disk:size por carpeta; las barras se reescalan al ir llegando
Seleccionar → Eliminar → modal de confirmación → disk:delete(paths, force)
```
**Borrado forzoso** (solo con admin):
1. `fs.rm` normal.
2. Si falla: `forceUnlock` → detiene procesos cuyo `Path` está dentro de la ruta → `takeown /R` → `icacls … *S-1-5-32-544:F` → `attrib -R -S -H`.
3. Reintenta `fs.rm`; como último recurso `cmd rd /s /q` o `del /f /q /a`.
4. Si aún existe, informa que está bloqueado por el sistema.

### 4.5 Desinstalación
```
apps:list (registro) → buscar → Desinstalar → confirm()
  → apps:uninstall: ejecuta UninstallString (o QuietUninstallString si "Silencioso");
                    convierte msiexec /I{GUID} en /X{GUID}; espera el código de salida
  → apps:leftovers: InstallLocation + carpetas de AppData/LocalAppData/ProgramData/Program Files
                    con nombre exactamente igual al de la app (se descartan las protegidas)
  → modal con casillas → disk:delete (forzoso si es admin)
```

### 4.6 Elevación a administrador
- **Desarrollo:** botón "Reiniciar como administrador" → `Start-Process electron.exe "<ruta app>" -Verb RunAs` (aparece UAC) → la instancia actual se cierra.
- **Producción:** el `.exe` generado con `npm run dist` declara `requireAdministrator` y siempre se abre elevado.

## 5. Convenciones y detalles técnicos

- **PowerShell → JSON:** siempre `ConvertTo-Json -InputObject @(...)` para que un único resultado siga siendo un array; `psJson` normaliza el resultado.
- **Codificación:** `[Console]::OutputEncoding = UTF8` en cada invocación, para respetar tildes y caracteres no ASCII en rutas.
- **Rendimiento:** el limitador `io(96)` evita saturar el sistema de archivos (EMFILE) en recorridos grandes.
- **Locale de `takeown`:** se prueba con `/D Y` y `/D S` porque la respuesta del prompt depende del idioma de Windows.
- **Errores:** los handlers lanzan `Error`; el renderer los captura con `guard()` y los muestra como toast.

## 6. Limitaciones conocidas

- Solo Windows (usa PowerShell, registro y utilidades nativas).
- Archivos bloqueados por el kernel (p. ej. en uso por servicios del sistema) pueden requerir reinicio.
- La detección de restos tras desinstalar es por coincidencia exacta de nombre; no limpia claves del registro.
- No hay pruebas automatizadas; el código fue validado con `node --check` y consultas de prueba a PowerShell.

## 7. Comandos

```bash
npm install        # instalar dependencias
npm start          # ejecutar en desarrollo
npm run dist       # generar .exe portable (pide administrador)
```

## 8. Actualización: procesos enriquecidos y escaneo de disco rápido

**Procesos**
- `proc:list` obtiene `CompanyName`, `FileDescription` y `ProductName` de cada ejecutable con `FileVersionInfo` (una sola vez por ruta única).
- Un diccionario `KNOWN` en `main.js` aporta la función y el software de ~70 procesos conocidos (svchost, explorer, chrome, etc.); si no está, se usa la descripción del propio ejecutable.
- `proc:icons` obtiene el icono real con `app.getFileIcon` (caché en memoria) y la UI lo carga después de pintar la tabla. La CSP permite `img-src data:`.
- La selección se conserva al filtrar, ordenar o refrescar.

**Almacenamiento**
- **Motor de escaneo:** `robocopy /L` (solo lista, no escribe) lanzado en paralelo por cada subcarpeta (máx. 8 procesos). Mide 12,7 s para 528 000 archivos / 114 GB, frente a 116 s con `lstat` por archivo. Si robocopy falla, se usa el recorrido con `fs` como respaldo.
- **Progreso:** el canal `disk:event` envía `list` (entradas al instante), `entry` (carpeta terminada) y `progress` (cada 150 ms). El porcentaje se calcula con bytes leídos / bytes esperados (espacio usado de la unidad, o tamaño conocido de un análisis previo); si no hay referencia, la barra es indeterminada. Se puede cancelar (mata los procesos robocopy).
- **Caché de análisis:** volver a una carpeta ya analizada es instantáneo; "Actualizar" fuerza un nuevo análisis y muestra cuánto se liberó respecto al anterior.
- **Gráfico de torta:** SVG tipo dona con las 8 mayores entradas + "Otros". Pasar el ratón o seleccionar una fila resalta su sector y muestra en el centro nombre, tamaño, % de la carpeta y % del disco. Clic en un sector abre la carpeta.
- Las columnas son ordenables (por defecto de mayor a menor tamaño, reordenando mientras llegan resultados).

## 9. Actualización: tamaños exactos (escáner nativo)

- `src/native/DiskScan.cs` es un escáner en C# que usa `NtQueryDirectoryFile` (`FileFullDirectoryInformation`). Cada entrada del directorio trae **EndOfFile** (tamaño lógico) y **AllocationSize** (espacio realmente ocupado en disco: clusters, compresión, archivos dispersos, marcadores de OneDrive), sin llamadas por archivo, con un pool de hilos.
- Se compila una sola vez con el `csc.exe` que incluye Windows (.NET Framework 4) y se guarda en `%APPDATA%\cleanerdev\diskscan-<hash>.exe`; si falla, se usa robocopy como respaldo (solo tamaño lógico).
- Medido: 1,5 M de archivos / 373 GB (C:\) en 5,4 s; `AppData\Local` en 6,2 s.
- La UI muestra **En disco** (principal, usado en gráfico y porcentajes) y **Tamaño** (datos). Informa de las carpetas sin acceso (`X`) y, en la raíz de una unidad, del espacio **no contabilizado** (pagefile, hiberfil, MFT, restauración, archivos protegidos) como sector propio del gráfico.
- Corrección: `el()` ignoraba `dataset` (propiedad de solo lectura), lo que dejaba `data-path` vacío en la desinstalación y en la limpieza.

## 10. Actualización: Limpieza enfocada en RAM

La pestaña **Limpieza** ahora tiene tres bloques:

1. **Memoria RAM (en vivo, cada 3 s):** dona con los programas que más memoria usan (agrupados por software con el diccionario `KNOWN`), "Sistema y controladores", "Caché en espera" y "Libre". `ram:info` combina `tasklist` (working set por proceso) con los contadores `Win32_PerfFormattedData_PerfOS_Memory` (standby, modificadas). La suma usado + standby + libre coincide con el total.
2. **Botón "Limpieza de RAM"** (`ram:clean`, ejecuta `src/native/RamClean.cs`):
   - `EmptyWorkingSet` en cada proceso accesible, **salvo** el de la ventana en primer plano, el Sistema y la propia app. No cierra nada.
   - Con administrador: `NtSetSystemInformation(SystemMemoryListInformation)` para escribir a disco las páginas modificadas y vaciar la lista de espera.
   - `ipconfig /flushdns`.
   - Mide la memoria disponible antes/después y muestra lo liberado.
3. **Procesos que no están en uso:** mide la CPU durante ~4 s y propone procesos sin ventana, sin actividad, de programas que no tienen ninguna ventana abierta, fuera de `C:\Windows` y que no sean de Microsoft/drivers. Nada viene marcado por defecto.
4. **Caches y temporales en disco:** la limpieza anterior (solo borra lo que no está en uso).

`ensureNative(file)` compila cualquier `.cs` de `src/native` con el `csc.exe` de Windows y lo guarda en `%APPDATA%\cleanerdev`.

## 11. Instalador y empaquetado

- `Instalar.bat` → `Instalar.ps1`: (1) se eleva a administrador (UAC), (2) **analiza** SO, PowerShell, espacio, archivos del proyecto, .NET (`csc.exe`), Node.js/npm, winget, dependencias e internet, (3) **instala** lo que falte (Node.js LTS con winget o MSI oficial; `npm install`), (4) **compila** con `npm run dist` y, si falla, reintenta en modo compatible (`signAndEditExecutable=false`), (5) copia `CleanerDev.exe` a la raíz y avisa "LISTO: YA PUEDES EJECUTAR EL .EXE". Registro en `instalador.log`; `-SoloAnalizar` solo muestra el análisis.
- `package.json > build`: target `portable` x64, salida en `release/`, `requestedExecutionLevel: requireAdministrator` y `portable.requestExecutionLevel: admin` (el .exe pide UAC al abrirse).
- Los fuentes `.cs` viajan dentro del asar; la app los lee con `fs` y los compila en `%APPDATA%\cleanerdev` (el compilador externo no puede leer del asar).
- Requisitos detallados: `REQUISITOS.md`.
