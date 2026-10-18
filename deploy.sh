#!/usr/bin/env bash
# ==============================================================================
# deploy.sh - 1-Click deployment script from laptop to production server
# ==============================================================================
set -euo pipefail

SERVER="georgefahmy@192.168.68.89"
REMOTE_DIR="/home/georgefahmy/Documents/sky_art"

echo "🧪 [1/4] Running local verification tests..."
node tests/test_zoom_pan_sync.js
node tests/test_waypoint_manipulation.js
node tests/test_theme_map_layer.js
./venv/bin/python3 -m unittest discover tests

echo "🚀 [2/4] Pushing latest local commits to GitHub..."
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"

echo "📥 [3/4] Pulling updates on production server ($SERVER)..."
ssh "$SERVER" "bash -s" <<EOF
set -euo pipefail
cd "$REMOTE_DIR"
git pull origin "$CURRENT_BRANCH"

# Update systemd service file if changed
if [ -f "sky-art.service" ]; then
    mkdir -p ~/.config/systemd/user
    cp sky-art.service ~/.config/systemd/user/sky-art.service
    systemctl --user daemon-reload
fi

# Update Python dependencies if requirements.txt was changed
if [ -f "requirements.txt" ]; then
    ./venv/bin/pip install -q -r requirements.txt
fi

echo "🔄 [4/4] Restarting SkyArt background service..."
systemctl --user restart sky-art

# Verify service is running
if systemctl --user is-active --quiet sky-art; then
    echo "✅ SkyArt successfully updated and running healthy!"
else
    echo "❌ Error: Service failed to start. Run 'journalctl --user -u sky-art -e' to inspect."
    exit 1
fi
EOF

echo ""
echo "✨ Deployment Complete!"
echo "   Live Domain: https://skyart.n890gf.com"
echo ""
