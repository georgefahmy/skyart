#!/usr/bin/env bash
# run.sh - Start SkyArt standalone development server
cd "$(dirname "$0")"

PORT="${PORT:-5005}"
echo "🎨 Starting SkyArt Standalone Server on http://0.0.0.0:${PORT} ..."

if [ -f "$HOME/.virtualenvs/skyart/bin/python3" ]; then
    PYTHON="$HOME/.virtualenvs/skyart/bin/python3"
else
    PYTHON="python3"
fi

exec "$PYTHON" app.py
