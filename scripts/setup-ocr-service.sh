#!/bin/bash
# One-time setup for the local PaddleOCR microservice.
# Usage: ./scripts/setup-ocr-service.sh
#
# Creates a project-local Python venv under python/venv, installs pinned
# dependencies, and pre-downloads the PaddleOCR model bundles so the always-on
# service (managed by pm2, see ecosystem.config.cjs) never needs network
# access to start and the first real request isn't slowed by a cold download.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$ROOT_DIR/python"

echo "==> Creating venv at $PYTHON_DIR/venv (if missing)"
if [ ! -d "$PYTHON_DIR/venv" ]; then
  python3 -m venv "$PYTHON_DIR/venv"
fi

echo "==> Installing Python dependencies"
"$PYTHON_DIR/venv/bin/pip" install --upgrade pip
"$PYTHON_DIR/venv/bin/pip" install -r "$PYTHON_DIR/requirements.txt"

echo "==> Warming up PaddleOCR models (downloads on first run, cached after)"
(cd "$PYTHON_DIR" && "./venv/bin/python" warm_models.py)

echo ""
echo "Setup complete. Start the service with:"
echo "  cd $ROOT_DIR && pm2 start ecosystem.config.cjs --only ocr-service"
echo "Or run it directly for local testing with:"
echo "  $PYTHON_DIR/venv/bin/uvicorn ocr_service:app --host 127.0.0.1 --port 8010 --app-dir $PYTHON_DIR"
