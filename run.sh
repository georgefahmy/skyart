#!/usr/bin/env bash
# run.sh - Start SkyArt standalone development server
cd "$(dirname "$0")"

PORT="${PORT:-5005}"
echo "🎨 Starting SkyArt Local Development Server on http://localhost:${PORT} ..."
echo "   (Open in your browser: http://127.0.0.1:${PORT})"
echo ""

if [ -f "./venv/bin/python3" ]; then
    PYTHON="./venv/bin/python3"
elif [ -f "$HOME/.virtualenvs/skyart/bin/python3" ]; then
    PYTHON="$HOME/.virtualenvs/skyart/bin/python3"
else
    PYTHON="python3"
fi

exec "$PYTHON" app.py
