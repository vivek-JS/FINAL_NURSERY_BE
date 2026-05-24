/**
 * PM2 — WhatsApp LocalAuth requires a single process and time to shut down cleanly.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart erp-backend
 *   pm2 logs erp-backend
 *
 * Set WHATSAPP_SESSION_PATH in .env to an absolute path outside the deploy folder, e.g.
 *   /var/www/erp-whatsapp/.wwebjs_auth
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
  ],
};
