#!/usr/bin/env bash
# ==============================================================================
# SkyArt & Web Server Production Hardening & Security Setup
# Target Domain: skyart.n890gf.com
# Target Backend: http://127.0.0.1:5005
# ==============================================================================
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run with sudo: sudo bash $0"
    exit 1
fi

echo "🛡️  [1/6] Configuring Nginx Global Security & Rate Limiting..."
# Safely set server_tokens off in main nginx.conf to avoid duplicate directive
sed -i 's/server_tokens build;/server_tokens off;/' /etc/nginx/nginx.conf 2>/dev/null || true

cat <<'EOF' > /etc/nginx/conf.d/security.conf
# Global Security Settings & Rate Limiting Zones

# Rate Limiting: Limit requests per IP address to defend against DDoS/spammers
limit_req_zone $binary_remote_addr zone=skyart_limit:10m rate=15r/s;
limit_req_status 429;

# Connection Limiting: Max concurrent connections per IP address
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;
limit_conn_status 429;

# Buffer limits to mitigate buffer overflow attacks & memory exhaustion
client_body_buffer_size 128k;
client_header_buffer_size 1k;
client_max_body_size 15M;
large_client_header_buffers 4 8k;

# Timeouts to mitigate Slowloris and stalled connection attacks
client_body_timeout 15s;
client_header_timeout 15s;
keepalive_timeout 30s;
send_timeout 15s;
EOF

echo "🌐 [2/6] Configuring Nginx Virtual Host for skyart.n890gf.com..."
cat <<'EOF' > /etc/nginx/sites-available/skyart
server {
    server_name skyart.n890gf.com;

    # Apply Rate Limiting (up to 30 burst requests allowed without stalling)
    limit_req zone=skyart_limit burst=30 nodelay;
    limit_conn conn_limit 20;

    # HTTP Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Block access to hidden files and directories (.git, .env, etc.)
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }

    # Block common automated bot probes & web vulnerability scanners
    location ~* (\.php|wp-admin|wp-login|xmlrpc\.php|phpmyadmin|\.bak|\.sql)$ {
        deny all;
        access_log off;
        log_not_found off;
    }

    location / {
        limit_except GET POST HEAD OPTIONS DELETE {
            deny all;
        }
        include proxy_params;
        proxy_pass http://127.0.0.1:5005;
    }

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    listen 80;
}
EOF

echo "🔗 [3/6] Enabling site & verifying Nginx configuration..."
ln -sf /etc/nginx/sites-available/skyart /etc/nginx/sites-enabled/skyart
nginx -t
systemctl reload nginx

echo "🔒 [4/6] Provisioning SSL certificate via Certbot for skyart.n890gf.com..."
if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d skyart.n890gf.com --non-interactive --agree-tos --email geofahm@gmail.com --redirect || {
        echo "⚠️ Certbot automatic cert generation encountered an issue; continuing with other hardening..."
    }
else
    echo "⚠️ Certbot not found, skipping SSL generation."
fi

echo "🧱 [5/6] Installing and configuring Fail2ban (Anti-Spam / Anti-Brute-Force)..."
apt-get update -y
apt-get install -y fail2ban

cat <<'EOF' > /etc/fail2ban/jail.local
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = 22
maxretry = 4

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
filter = nginx-botsearch
port = http,https
logpath = /var/log/nginx/access.log
maxretry = 3
bantime = 24h

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
bantime = 1h
EOF

systemctl enable --now fail2ban
systemctl restart fail2ban

echo "🔥 [6/6] Verifying UFW Firewall..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow 22/tcp
    ufw allow 'Nginx Full'
    if ! ufw status | grep -q "Status: active"; then
        echo "Activating UFW..."
        echo "y" | ufw enable
    fi
    ufw status verbose
fi

echo "=============================================================================="
echo "✅ Production hardening complete!"
echo "   - SkyArt Public URL: https://skyart.n890gf.com"
echo "   - Rate limiting: 15 req/sec (burst 30), 429 on abuse"
echo "   - Bot / Exploit scanner auto-blocking enabled"
echo "   - Fail2ban active for SSH, Nginx rate limits, and malicious bot searches"
echo "   - UFW firewall active (Ports 22, 80, 443 permitted)"
echo "=============================================================================="
