#!/usr/bin/env bash
# Deploy FINAL_NURSERY_BE to DigitalOcean
# Usage: ./deploy/deploy.sh [user@host]
set -euo pipefail

REMOTE="${1:-root@167.71.232.6}"
APP_DIR="/var/www/FINAL_NURSERY_BE"
BRANCH="${DEPLOY_BRANCH:-prod}"
PM2_NAME="${PM2_NAME:-erp-backend}"

echo "==> Deploy backend -> ${REMOTE}:${APP_DIR} (branch ${BRANCH})"
ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail
cd ${APP_DIR}
cp -f .env /tmp/final_nursery_be.env.bak 2>/dev/null || true
git fetch origin
git reset --hard origin/${BRANCH}
cp -f /tmp/final_nursery_be.env.bak .env 2>/dev/null || true
npm install --omit=dev
pm2 restart ${PM2_NAME} --update-env
pm2 status ${PM2_NAME}
REMOTE_SCRIPT

echo "==> Done. API should be live on the droplet."
