#!/usr/bin/env node
/**
 * DataStack Unified Development Runner
 * Starts both the Next.js Web Console (Port 3000) and Express/Socket.IO Ingestion Server (Port 4000)
 * concurrently with unified terminal logging and clean shutdown handling.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const webPort = String(process.env.PORT || '3000');
const nextBin = require.resolve('next/dist/bin/next');
const serverEntry = path.resolve(__dirname, '..', 'server', 'index.js');
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 7000;

console.log('\x1b[36m%s\x1b[0m', '=======================================================');
console.log('\x1b[36m%s\x1b[0m', '  DataStack Unified Development Runner');
console.log('\x1b[36m%s\x1b[0m', `  - Port ${webPort}: Next.js 15 Web & Admin Console (/vcon/*)`);
console.log('\x1b[36m%s\x1b[0m', '  - Port 4000: Ingestion & Socket.IO Streaming Engine');
console.log('\x1b[36m%s\x1b[0m', '=======================================================\n');

const nextProc = spawn(process.execPath, [nextBin, 'dev', '-p', webPort, '-H', '0.0.0.0'], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env },
});

const serverProc = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env },
});

let shuttingDown = false;
let exitedChildren = 0;
let nextExited = false;
let serverExited = false;
let exitCodePending = 0;

function markChildExited() {
  exitedChildren += 1;
  if (shuttingDown && exitedChildren >= 2) {
    process.exit(exitCodePending);
  }
}

function signalChild(child, exited, signal) {
  if (exited || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Child already exited
  }
}

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCodePending = exitCode;
  console.log(`\n[DataStack] Received ${signal}. Gracefully stopping all dev services...`);
  signalChild(nextProc, nextExited, signal);
  signalChild(serverProc, serverExited, signal);
  if (exitedChildren >= 2) {
    process.exit(exitCodePending);
    return;
  }
  setTimeout(() => {
    signalChild(nextProc, nextExited, 'SIGKILL');
    signalChild(serverProc, serverExited, 'SIGKILL');
    process.exit(exitCodePending);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

nextProc.on('exit', (code) => {
  nextExited = true;
  markChildExited();
  if (!shuttingDown) {
    console.error(`[DataStack] Next.js development server exited with code ${code ?? 0}`);
    shutdown('SIGTERM', code || 1);
  }
});

serverProc.on('exit', (code) => {
  serverExited = true;
  markChildExited();
  if (!shuttingDown) {
    console.error(`[DataStack] Ingestion server exited with code ${code ?? 0}`);
    shutdown('SIGTERM', code || 1);
  }
});
