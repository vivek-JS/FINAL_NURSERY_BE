/**
 * PM2 — Baileys WhatsApp needs a single process (one linked device).
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart erp-backend
 *   pm2 logs erp-backend
 *
 * Login is stored in MongoDB (whatsapp_session_keys). Optional:
 *   WHATSAPP_SESSION_ID=erp-prod
 *   WHATSAPP_CLIENT_ENABLED=true
 *
 * ocr-service is the local PaddleOCR microservice (see python/ocr_service.py).
 *   ./scripts/setup-ocr-service.sh
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
      kill_timeout: 20000,
      listen_timeout: 15000,
      // Baileys is light; keep headroom for PDF Puppeteer + peak traffic
      max_memory_restart: "700M",
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
      max_memory_restart: "1100M",
      autorestart: true,
      env: {
        OCR_PY_PORT: "8010",
      },
    },
  ],
};
