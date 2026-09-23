const { mkdirSync, existsSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { dirname, resolve } = require('node:path');
const { createApp } = require('./app');

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^("|')(.*)\1$/, '$2');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(resolve(process.cwd(), '.env'));

const port = Number(process.env.PORT || 4444);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const databasePath = resolve(process.cwd(), process.env.DATABASE_PATH || 'data/terms.sqlite');
const host = process.env.HOST || '127.0.0.1';
mkdirSync(dirname(databasePath), { recursive: true });

const server = createServer(createApp({
  apiKey: process.env.API_KEY,
  databasePath,
}));

server.listen(port, host, () => {
  console.log(`term-lookup-api listening on http://${host}:${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
