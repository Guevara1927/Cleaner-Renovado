@echo off
title Instalador de CleanerDev
cd /d "%~dp0"
echo.
echo  Instalador de CleanerDev
echo  ------------------------
echo  Analiza tu equipo, instala lo que falte y genera CleanerDev.exe
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1" %*
if errorlevel 1 (
    echo.
    echo  La instalacion no se completo. Revisa REQUISITOS.md e instalador.log
    pause
)
