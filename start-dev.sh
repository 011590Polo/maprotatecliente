#!/bin/bash

# Script para iniciar el servidor y el cliente Angular en desarrollo

echo "🚀 Iniciando Fleet Tracking..."

# Iniciar servidor en background
echo "📡 Iniciando servidor Node.js..."
cd server
npm start &
SERVER_PID=$!
cd ..

# Esperar un poco para que el servidor inicie
sleep 3

# Iniciar Angular
echo "🌐 Iniciando Angular..."
npm start

# Cuando se cierre Angular, cerrar también el servidor
trap "kill $SERVER_PID" EXIT





