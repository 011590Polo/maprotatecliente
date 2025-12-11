@echo off
REM Script para iniciar el servidor y el cliente Angular en desarrollo (Windows)

echo 🚀 Iniciando Fleet Tracking...

REM Iniciar servidor en nueva ventana
echo 📡 Iniciando servidor Node.js...
start "Fleet Tracking Server" cmd /k "cd server && npm start"

REM Esperar un poco para que el servidor inicie
timeout /t 3 /nobreak >nul

REM Iniciar Angular
echo 🌐 Iniciando Angular...
npm start





