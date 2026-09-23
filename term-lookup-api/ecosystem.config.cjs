module.exports = {
  apps: [
    {
      name: 'term-lookup-api',
      cwd: __dirname,
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 4444,
      },
    },
  ],
};
