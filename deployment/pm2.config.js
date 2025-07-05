module.exports = {
  apps: [
    {
      name: 'nursery-backend',
      script: 'index.js',
      instances: 'max', // Use all available CPU cores
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      
      // Logging
      log_file: '/var/log/nursery-app/combined.log',
      out_file: '/var/log/nursery-app/out.log',
      error_file: '/var/log/nursery-app/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // Monitoring
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'uploads'],
      
      // Auto-restart settings
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      
      // Process management
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 8000,
      
      // Health check
      health_check_grace_period: 3000,
      
      // Environment variables
      env_file: '.env.production',
      
      // Advanced settings
      node_args: '--max-old-space-size=1024',
      merge_logs: true,
      
      // Cron jobs for cleanup
      cron_restart: '0 2 * * *', // Restart daily at 2 AM
      
      // Error handling
      autorestart: true,
      exp_backoff_restart_delay: 100
    }
  ],

  deploy: {
    production: {
      user: 'nursery',
      host: 'your-server-ip',
      ref: 'origin/main',
      repo: 'git@github.com:vivek-JS/FINAL_NURSERY_BE.git',
      path: '/var/www/nursery-app',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
}; 