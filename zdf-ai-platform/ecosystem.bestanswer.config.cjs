/**
 * PM2 app definition for the /BestAnswer/ subpath on a shared host.
 * Do not use the stock ecosystem.config.cjs / deploy.sh there — those bind
 * name `zdf-ai-platform`, cwd `/var/www/zdfai`, and PORT 3000 for a dedicated domain.
 *
 * Set PORT to a free port on the shared box, and point nginx-bestanswer.conf
 * proxy_pass at the same port. Set JWT_SECRET in the process environment;
 * this file does not invent production secrets.
 */
module.exports = {
  apps: [
    {
      name: 'zdf-ai-bestanswer',
      script: 'backend/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        BASE_PATH: '/BestAnswer',
      },
    },
  ],
};
