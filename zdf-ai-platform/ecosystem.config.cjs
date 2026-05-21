module.exports = {
  apps: [
    {
      name: 'zdf-ai-platform',
      script: 'backend/server.js',
      cwd: '/var/www/zdfai',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
