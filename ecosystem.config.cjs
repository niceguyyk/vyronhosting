module.exports = {
  apps: [
    {
      name: 'vyron-app',
      cwd: __dirname + '/Webserver',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 3001 },
      max_memory_restart: '300M'
    },
    {
      name: 'vyron-api',
      cwd: __dirname + '/API',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 8787 },
      max_memory_restart: '300M'
    },
    {
      name: 'vyron-panel',
      cwd: __dirname + '/Appserver',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 3002 },
      max_memory_restart: '300M'
    },
    {
      name: 'vyron-status',
      cwd: __dirname + '/Statusserver',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 3004, DISCORD_CLIENT_ID: '1546867027778605110' },
      max_memory_restart: '150M'
    },
    {
      name: 'vyron-agent',
      cwd: __dirname + '/Agent',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 8790 },
      max_memory_restart: '250M'
    }
  ]
}
