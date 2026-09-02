@echo off
title BPlace Server
cd /d "%~dp0"
echo ===================================================
echo   Iniciando servidor BPlace en http://localhost:3002
echo ===================================================
node server.js
pause
