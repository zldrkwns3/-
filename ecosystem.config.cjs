module.exports = {
  apps: [
    {
      name: 'stock-bot',
      script: 'C:\\Windows\\System32\\cmd.exe',
      args: '/c "C:\\Program Files\\nodejs\\npx.cmd" tsx server.ts',
      interpreter: 'none',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'development',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
    }
  ]
};
