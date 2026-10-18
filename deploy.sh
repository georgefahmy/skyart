#!/usr/bin/env bash
# ==============================================================================
# deploy.sh - 1-Click deployment script from laptop to production server
# ==============================================================================
set -euo pipefail

SERVER="georgefahmy@192.168.68.89"
REMOTE_DIR="/home/georgefahmy/Documents/sky_art"

echo "🚀 [1/3] Pushing latest local commits to GitHub..."
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"

echo "📥 [2/3] Pulling updates on production server ($SERVER)..."
ssh "$SERVER" "bash -s" <<EOF
set -euo pipefail
cd "$REMOTE_DIR"
git pull origin "$CURRENT_BRANCH"

# Update Python dependencies if requirements.txt was changed
if [ -f "requirements.txt" ]; then
    ./venv/bin/pip install -q -r requirements.txt
fi

echo "🔄 [3/3] Restarting SkyArt background service..."
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
echo "   Local Server: http://192.168.68.89:5005"
