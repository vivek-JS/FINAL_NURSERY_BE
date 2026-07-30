/**
 * PM2 — WhatsApp LocalAuth requires a single process and time to shut down cleanly.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart erp-backend
 *   pm2 logs erp-backend
 *
 * Set WHATSAPP_SESSION_PATH in .env to an absolute path outside the deploy folder, e.g.
 *   /var/www/erp-whatsapp/.wwebjs_auth
 *
 * ocr-service is the local PaddleOCR microservice (see python/ocr_service.py).
 * It binds to 127.0.0.1 only (never exposed publicly) and is started separately:
 *   ./scripts/setup-ocr-service.sh          # one-time: venv + deps + model download
 *   pm2 start ecosystem.config.cjs --only ocr-service
 */
const path = require("path");

module.exports = {
  apps: [
    {
      name: "erp-backend",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 30000,
      listen_timeout: 10000,
      max_memory_restart: "450M",
      env_file: path.join(__dirname, ".env"),
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ocr-service",
      script: "venv/bin/uvicorn",
      args: "ocr_service:app --host 127.0.0.1 --port 8010",
      interpreter: "none",
      cwd: path.join(__dirname, "python"),
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 15000,
      listen_timeout: 20000,
      // Two warm PaddleOCR pipelines (paddlepaddle + numpy/opencv/scipy) sit
      // around ~600MB RSS at idle and climb to ~900MB-1GB after the first real
      // inference (one-time buffer/cache warmup inside paddle/opencv/BLAS).
      // 1100M gives headroom above the measured steady state while still
      // catching genuine runaway leaks.
      max_memory_restart: "1100M",
      autorestart: true,
      env: {
        OCR_PY_PORT: "8010",
      },
    },
  ],
};
