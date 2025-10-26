#!/bin/bash

# Market Dashboard Startup Script
# Starts both backend API server and React frontend

echo "🚀 Starting Market Dashboard..."

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start backend server in background
echo "🔧 Starting backend API server on port 3001..."
node server.js &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 3

# Start React frontend
echo "⚛️  Starting React frontend on port 3000..."
npm start &
FRONTEND_PID=$!

echo ""
echo "✅ Market Dashboard is running!"
echo "📊 Frontend: http://localhost:3000"
echo "🔧 Backend:  http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop both servers"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping servers..."
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    exit 0
}

# Trap Ctrl+C
trap cleanup SIGINT

# Wait for user to stop
wait
