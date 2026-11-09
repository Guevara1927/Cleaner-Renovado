# Instalador de CleanerDev
# 1) Analiza que herramientas hay y cuales faltan   2) Instala las que faltan
# 3) Instala dependencias del proyecto              4) Genera el .exe
# Uso: doble clic en Instalar.bat   (o: powershell -File Instalar.ps1 [-SoloAnalizar] [-SinPausa])
param(
    [switch]$SoloAnalizar,   # solo muestra el analisis, no instala ni compila
    [switch]$SinPausa        # no espera Enter al final
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location $root

# ---------- elevacion a administrador ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SoloAnalizar) {
    Write-Host 'Se necesitan permisos de administrador (instalar Node.js y generar el .exe).' -ForegroundColor Yellow
    Write-Host 'Acepta el aviso de Windows (UAC) que aparecera...' -ForegroundColor Yellow
    $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($SinPausa) { $argsList += '-SinPausa' }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argsList -Verb RunAs
    } catch {
        Write-Host 'No se concedieron permisos de administrador. Instalacion cancelada.' -ForegroundColor Red
        if (-not $SinPausa) { Read-Host 'Pulsa Enter para cerrar' | Out-Null }
        exit 1
    }
    exit 0
}

$logFile = Join-Path $root 'instalador.log'
try { Start-Transcript -Path $logFile -Force | Out-Null } catch { }

# ---------- utilidades ----------
function Title($t) { Write-Host ''; Write-Host ('=== ' + $t + ' ===') -ForegroundColor Cyan }
function Ok($t)    { Write-Host ('  [OK]     ' + $t) -ForegroundColor Green }
function Warn($t)  { Write-Host ('  [AVISO]  ' + $t) -ForegroundColor Yellow }
function Bad($t)   { Write-Host ('  [FALTA]  ' + $t) -ForegroundColor Red }
function Info($t)  { Write-Host ('  ' + $t) -ForegroundColor Gray }

function Refresh-Path {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
    $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
    if ((Test-Path $nodeDir) -and ($env:Path -notlike "*$nodeDir*")) { $env:Path += ';' + $nodeDir }
}

function Get-NodeInfo {
    Refresh-Path
    $info = @{ Node = $null; Npm = $null }
    try { $v = (& node -v) 2>$null; if ($v) { $info.Node = [version]($v.Trim().TrimStart('v')) } } catch { }
    try { $v = (& cmd /c 'npm -v') 2>$null; if ($v) { $info.Npm = [version]($v | Select-Object -First 1).Trim() } } catch { }
    return $info
}

function Has-Internet {
    try { Invoke-WebRequest -Uri 'https://registry.npmjs.org/' -UseBasicParsing -Method Head -TimeoutSec 10 | Out-Null; return $true } catch { return $false }
}

$MIN_NODE = [version]'18.0.0'
$pending = New-Object System.Collections.ArrayList   # lo que hay que instalar

# =====================================================================
Title 'PASO 1: ANALISIS DEL EQUIPO'
# =====================================================================
Write-Host ''
Write-Host ('  Carpeta del proyecto: ' + $root) -ForegroundColor Gray

# Sistema operativo
$os = [Environment]::OSVersion.Version
if ($os.Major -ge 10 -and [Environment]::Is64BitOperatingSystem) { Ok ("Windows 10/11 de 64 bits (build $($os.Build))") }
else { Bad 'Se requiere Windows 10/11 de 64 bits'; $fatal = $true }

# PowerShell
if ($PSVersionTable.PSVersion -ge [version]'5.1') { Ok ("PowerShell $($PSVersionTable.PSVersion)") } else { Bad 'Se requiere PowerShell 5.1 o superior'; $fatal = $true }

# Privilegios
if ($isAdmin) { Ok 'Permisos de administrador' } else { Warn 'Sin permisos de administrador (modo analisis)' }

# Espacio en disco
try {
    $drive = (Get-Item $root).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -ge 2) { Ok ("Espacio libre en $($drive.Name): $freeGB GB (minimo 2 GB)") }
    else { Bad "Espacio libre insuficiente en $($drive.Name): $freeGB GB (minimo 2 GB)"; $fatal = $true }
} catch { Warn 'No se pudo comprobar el espacio libre' }

# Archivos del proyecto
foreach ($f in 'package.json', 'src\main.js', 'src\renderer.js', 'src\native\DiskScan.cs', 'src\native\RamClean.cs') {
    if (Test-Path (Join-Path $root $f)) { } else { Bad "Archivo del proyecto no encontrado: $f"; $fatal = $true }
}
if (-not $fatal) { Ok 'Archivos del proyecto completos' }

# Compilador .NET Framework (escaner nativo / limpiador de RAM)
$csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (Test-Path $csc) { Ok '.NET Framework 4 (compilador csc.exe)' }
else { Warn '.NET Framework 4 no encontrado: la app usara el modo compatible (mas lento, sin limpieza profunda de RAM)' }

# Node.js y npm
$ni = Get-NodeInfo
if ($ni.Node -and $ni.Node -ge $MIN_NODE) { Ok "Node.js v$($ni.Node)" }
elseif ($ni.Node) { Bad "Node.js v$($ni.Node) es demasiado antiguo (minimo v$MIN_NODE)"; [void]$pending.Add('node') }
else { Bad 'Node.js no esta instalado'; [void]$pending.Add('node') }
if ($ni.Npm) { Ok "npm v$($ni.Npm)" } elseif ($ni.Node) { Bad 'npm no encontrado'; if ($pending -notcontains 'node') { [void]$pending.Add('node') } } else { Bad 'npm no esta instalado (viene con Node.js)' }

# winget (opcional)
$hasWinget = $null -ne (Get-Command winget.exe -ErrorAction SilentlyContinue)
if ($hasWinget) { Ok 'winget disponible (instalacion automatica de Node.js)' } else { Info 'winget no disponible: se descargara el instalador de Node.js directamente' }

# Dependencias del proyecto
$electronOk = Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe')
$builderOk = Test-Path (Join-Path $root 'node_modules\.bin\electron-builder.cmd')
if ($electronOk -and $builderOk) { Ok 'Dependencias del proyecto (electron, electron-builder)' }
else { Bad 'Dependencias del proyecto sin instalar (electron, electron-builder)'; [void]$pending.Add('npm') }

# .exe ya generado
$exeOut = Join-Path $root 'release\CleanerDev.exe'
if (Test-Path $exeOut) { Info ('Ya existe un .exe anterior: ' + $exeOut + ' (se regenerara)') }

# Internet (solo si hay algo que descargar)
$needDownload = ($pending.Count -gt 0) -or (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache')))
if ($needDownload) {
    if (Has-Internet) { Ok 'Conexion a internet' } else { Bad 'Sin conexion a internet (se necesita para descargar herramientas)'; $fatal = $true }
}

Write-Host ''
if ($fatal) {
    Write-Host 'Hay requisitos que no se pueden resolver automaticamente. Revisa REQUISITOS.md.' -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch { }
    if (-not $SinPausa) { Read-Host 'Pulsa Enter para cerrar' | Out-Null }
    exit 1
}
if ($pending.Count -eq 0) { Write-Host 'No falta ninguna herramienta.' -ForegroundColor Green }
else { Write-Host ('Faltan: ' + ($pending -join ', ')) -ForegroundColor Yellow }

if ($SoloAnalizar) {
    Write-Host ''
    Write-Host 'Modo -SoloAnalizar: no se instalo ni compilo nada.' -ForegroundColor Cyan
    try { Stop-Transcript | Out-Null } catch { }
    exit 0
}

function Fail($msg) {
    Write-Host ''
    Write-Host ('ERROR: ' + $msg) -ForegroundColor Red
    Write-Host ('Detalles en: ' + $logFile) -ForegroundColor Gray
    try { Stop-Transcript | Out-Null } catch { }
    if (-not $SinPausa) { Read-Host 'Pulsa Enter para cerrar' | Out-Null }
    exit 1
}

# =====================================================================
Title 'PASO 2: INSTALACION DE HERRAMIENTAS FALTANTES'
# =====================================================================
if ($pending -contains 'node') {
    $done = $false
    if ($hasWinget) {
        Write-Host '  Instalando Node.js LTS con winget...' -ForegroundColor White
        try {
            & winget.exe install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        } catch { Warn "winget fallo: $($_.Exception.Message)" }
        $ni = Get-NodeInfo
        if ($ni.Node -and $ni.Node -ge $MIN_NODE) { $done = $true }
    }
    if (-not $done) {
        Write-Host '  Descargando instalador oficial de Node.js LTS...' -ForegroundColor White
        try {
            $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
            $ver = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
            $msi = Join-Path $env:TEMP "node-$ver-x64.msi"
            Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-x64.msi" -OutFile $msi -UseBasicParsing
            if ((Get-Item $msi).Length -lt 10MB) { throw 'Descarga incompleta' }
            Write-Host "  Instalando Node.js $ver (puede tardar un minuto)..." -ForegroundColor White
            $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
            if ($p.ExitCode -notin 0, 3010) { throw "msiexec devolvio el codigo $($p.ExitCode)" }
        } catch { Fail "No se pudo instalar Node.js automaticamente ($($_.Exception.Message)). Instalalo desde https://nodejs.org y vuelve a ejecutar." }
        $ni = Get-NodeInfo
    }
    if ($ni.Node -and $ni.Node -ge $MIN_NODE -and $ni.Npm) { Ok "Node.js v$($ni.Node) y npm v$($ni.Npm) instalados" }
    else { Fail 'Node.js se instalo pero no se detecta. Cierra esta ventana y ejecuta Instalar.bat otra vez.' }
} else {
    Ok 'Node.js y npm ya estaban instalados'
}

if ($pending -contains 'npm' -or $pending -contains 'node') {
    Write-Host '  Instalando dependencias del proyecto (npm install)...' -ForegroundColor White
    & cmd.exe /c 'npm install --no-audit --no-fund'
    if ($LASTEXITCODE -ne 0) { Fail 'npm install fallo (revisa tu conexion o proxy).' }
    if (-not (Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe'))) { Fail 'Electron no se descargo correctamente.' }
    Ok 'Dependencias instaladas'
} else {
    Ok 'Dependencias del proyecto ya estaban instaladas'
}

# =====================================================================
Title 'PASO 3: GENERANDO EL .EXE (puede tardar 1-3 minutos)'
# =====================================================================
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
if (Test-Path (Join-Path $root 'release')) { Remove-Item (Join-Path $root 'release') -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host '  Compilando (con ejecucion como administrador integrada)...' -ForegroundColor White
& cmd.exe /c 'npm run dist'
$built = Test-Path $exeOut
if (-not $built) {
    Warn 'El metodo principal fallo. Reintentando en modo compatible...'
    & cmd.exe /c 'npx electron-builder --win portable --config.win.signAndEditExecutable=false'
    $built = Test-Path $exeOut
    if ($built) { Warn 'El .exe se genero en modo compatible: no pide administrador al abrirse (usa el boton "Reiniciar como administrador" dentro de la app).' }
}
if (-not $built) { Fail 'No se pudo generar el .exe. Revisa el log.' }

$final = Join-Path $root 'CleanerDev.exe'
Copy-Item $exeOut $final -Force
$sizeMB = [math]::Round((Get-Item $final).Length / 1MB, 1)

# =====================================================================
Write-Host ''
Write-Host '==========================================================' -ForegroundColor Green
Write-Host '   LISTO: YA PUEDES EJECUTAR EL .EXE' -ForegroundColor Green
Write-Host '==========================================================' -ForegroundColor Green
Write-Host ('   Archivo : ' + $final) -ForegroundColor White
Write-Host ('   Tamano  : ' + $sizeMB + ' MB') -ForegroundColor White
Write-Host '   Nota    : Windows pedira permisos de administrador al abrirlo.' -ForegroundColor Gray
Write-Host '             Si aparece SmartScreen: "Mas informacion" > "Ejecutar de todas formas".' -ForegroundColor Gray
Write-Host ''
try { Stop-Transcript | Out-Null } catch { }

if (-not $SinPausa) {
    $r = Read-Host 'Quieres abrir CleanerDev ahora? (S/N)'
    if ($r -match '^[sSyY]') { Start-Process -FilePath $final }
}
exit 0
