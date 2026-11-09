@echo off
title CleanerDev
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js no esta instalado. Descargalo de https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\electron" (
    echo Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo Fallo la instalacion de dependencias.
        pause
        exit /b 1
    )
)

echo Iniciando CleanerDev...
call npm start
if errorlevel 1 pause
