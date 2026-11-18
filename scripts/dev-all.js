#!/usr/bin/env node
/**
 * DataStack Unified Development Runner
 * Starts both the Next.js Web Console (Port 3000) and Express/Socket.IO Ingestion Server (Port 4000)
 * concurrently with unified terminal logging and clean shutdown handling.
 */

const { spawn } = require('node:child_process');

console.log('\x1b[36m%s\x1b[0m', '=======================================================');
console.log('\x1b[36m%s\x1b[0m', '  DataStack Unified Development Runner');
console.log('\x1b[36m%s\x1b[0m', '  - Port 3000: Next.js 15 Web & Admin Console (/vcon/*)');
console.log('\x1b[36m%s\x1b[0m', '  - Port 4000: Ingestion & Socket.IO Streaming Engine');
console.log('\x1b[36m%s\x1b[0m', '=======================================================\n');

const nextProc = spawn('npm', ['run', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

const serverProc = spawn('npm', ['run', 'server'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

function shutdown(signal) {
  console.log(`\n[DataStack] Received ${signal}. Gracefully stopping all dev services...`);
  if (!nextProc.killed) nextProc.kill(signal);
  if (!serverProc.killed) serverProc.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

nextProc.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`[DataStack] Next.js development server exited with code ${code}`);
  }
});

serverProc.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`[DataStack] Ingestion server exited with code ${code}`);
  }
});
