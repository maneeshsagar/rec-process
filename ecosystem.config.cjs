// PM2 Configuration
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'meetup',
      script: 'server/index.js',
      instances: 1, // mediasoup manages its own workers, so 1 Node process is correct
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logs
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
