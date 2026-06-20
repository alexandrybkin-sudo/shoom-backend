#!/usr/bin/env bash
# First-time Let's Encrypt certificate issuance (run once, from the shoom-backend dir).
# Requires: DNS for shoom.fun AND livekit.shoom.fun already pointing at this server,
#           and port 80 free (run before bringing nginx up).
set -euo pipefail

EMAIL="${1:?usage: ./deploy/init-letsencrypt.sh you@example.com}"

mkdir -p certbot/conf certbot/www

docker run --rm \
  -p 80:80 \
  -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --standalone \
  -d shoom.fun -d www.shoom.fun -d livekit.shoom.fun \
  --email "$EMAIL" --agree-tos --no-eff-email -n

echo "✅ Certificates issued. Now run: docker compose up -d --build"
