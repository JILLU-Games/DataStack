import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { POST as setupPost } from '../app/api/auth/setup/route';
import { GET as filesStatusGet } from '../app/api/files/status/route';
import {
  createAdminSessionToken,
  getAdminSessionPayload,
  getAdminSessionSecret,
} from '../core/auth/adminSession';
import { resetAdminStateForTests } from '../core/auth/adminUsers';
import { middleware } from '../middleware';
import { DataStack, DiskSpooler } from '../sdk/node/datastack';

const require = createRequire(import.meta.url);
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function makeFakeJwt(clientId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ clientId, iat: 1700000000 })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('R4-Phase-03: Node SDK Packaging & Spool Parity, Docker & Proxy Hint, Auth Hygiene', () => {
  beforeEach(() => {
    restoreEnv();
    resetAdminStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    restoreEnv();
    resetAdminStateForTests();
  });

  it('AUDIT-02: prebuilds @datastack/sdk dist artifacts, sets prepare/typescript metadata, and loads directly via CJS require', () => {
    const sdkDir = path.join(process.cwd(), 'sdk', 'node', 'datastack');
    const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      main?: string;
      types?: string;
    };

    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.equal(pkg.scripts?.build, 'tsc -p tsconfig.json');
    assert.equal(pkg.scripts?.prepare, 'npm run build');
    assert.ok(pkg.devDependencies?.typescript, 'typescript must be listed in devDependencies');

    for (const file of [
      'index.js',
      'index.d.ts',
      'spool.js',
      'spool.d.ts',
      'types.js',
      'types.d.ts',
    ]) {
      assert.equal(
        fs.existsSync(path.join(sdkDir, 'dist', file)),
        true,
        `Missing prebuilt dist artifact: ${file}`
      );
    }

    const cjsLoaded = require(path.join(sdkDir, 'dist', 'index.js')) as {
      DataStack?: typeof DataStack;
      DataStackClient?: typeof DataStack;
      DiskSpooler?: typeof DiskSpooler;
      SDK_VERSION?: string;
    };
    assert.equal(typeof cjsLoaded.DataStack, 'function');
    assert.equal(typeof cjsLoaded.DataStackClient, 'function');
    assert.equal(typeof cjsLoaded.DiskSpooler, 'function');
    assert.equal(cjsLoaded.SDK_VERSION, '2.2.0');

    const token = makeFakeJwt('cjs_loader_probe');
    const client = new cjsLoaded.DataStack!({
      token,
      autoConnect: false,
      offlineSpoolEnabled: false,
    });
    assert.equal(client.clientId, 'cjs_loader_probe');
  });

  it('AUDIT-20: DiskSpooler.ackAndRequeueFront preserves FIFO tail and client.flushSpool recovers partial 429 progress atomically', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-r4-p03-spool-'));
    try {
      // 1. Direct DiskSpooler unit check
      const spooler = new DiskSpooler({ spoolDir: tmpDir, enabled: true });
      const mkEnv = (id: string) => ({
        clientId: 'sensor_node',
        eventId: id,
        timestamp: '2026-11-21T00:00:00.000Z',
        data: { id },
      });
      spooler.enqueue([mkEnv('e1'), mkEnv('e2'), mkEnv('e3'), mkEnv('e4'), mkEnv('e5')]);
      const removedCount = spooler.ackAndRequeueFront(3, [mkEnv('e2')]);
      assert.equal(removedCount, 2);

      const afterPartial = spooler.peekBatch(10).map((e) => e.eventId);
      assert.deepEqual(afterPartial, ['e2', 'e4', 'e5']);

      // Ensure no leftover .tmp files exist in spoolDir
      const entries = fs.readdirSync(tmpDir);
      assert.equal(entries.some((f) => f.endsWith('.tmp')), false);

      // Clean and test partial recovery through DataStack.flushSpool()
      spooler.clear();
      const deliveredIds: string[] = [];
      let simulatePartial = true;

      const token = makeFakeJwt('sensor_node');
      const client = new DataStack({
        token,
        apiUrl: 'http://localhost:3000',
        serverUrl: 'http://localhost:4000',
        autoConnect: false,
        offlineSpoolEnabled: true,
        offlineSpoolDir: tmpDir,
        batchChunkSize: 3,
        maxRetries: 0,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body || '{}')) as {
            batch?: Array<{ eventId: string }>;
          };
          const batch = body.batch || [];
          if (simulatePartial && batch.length === 3) {
            // Simulate partial 429 HTTP rejection where batch[1] is rate-limited
            const limitedId = batch[1].eventId;
            deliveredIds.push(batch[0].eventId, batch[2].eventId);
            return new Response(
              JSON.stringify({
                success: false,
                code: 'RATE_LIMIT_EXCEEDED',
                error: 'Rate limit reached for 1 event',
                rateLimitedEventIds: [limitedId],
              }),
              { status: 429, headers: { 'Content-Type': 'application/json' } }
            );
          }
          for (const item of batch) {
            deliveredIds.push(item.eventId);
          }
          return new Response(
            JSON.stringify({ success: true, accepted: batch.length }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
      });

      client.spooler.enqueue([mkEnv('s1'), mkEnv('s2'), mkEnv('s3'), mkEnv('s4')]);
      const firstFlush = await client.flushSpool();
      assert.equal(firstFlush.drained, 2);
      assert.equal(firstFlush.remaining, 2);
      assert.deepEqual(
        client.spooler.peekBatch(10).map((e) => e.eventId),
        ['s2', 's4']
      );

      // Next flush delivers remaining [s2, s4] cleanly with zero duplicates or data loss
      simulatePartial = false;
      const secondFlush = await client.flushSpool();
      assert.equal(secondFlush.drained, 2);
      assert.equal(secondFlush.remaining, 0);
      assert.deepEqual(deliveredIds, ['s1', 's3', 's2', 's4']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('AUDIT-08 & ERR-R4-09: docker-compose ingestion configures DATASTACK_ADMIN_EMAIL and /api/files/status + UI expose non-Nginx WS hint', async () => {
    const compose = fs.readFileSync(path.join(process.cwd(), 'docker', 'docker-compose.yml'), 'utf8');
    const ingestionBlockMatch = compose.match(
      /ingestion:\s*\n[\s\S]*?\n\s+proxy:/
    );
    assert.ok(ingestionBlockMatch, 'ingestion service block must exist in docker-compose.yml');
    assert.match(
      ingestionBlockMatch[0],
      /DATASTACK_ADMIN_EMAIL:\s*"\$\{DATASTACK_ADMIN_EMAIL:-admin@datastack\.dev\}"/
    );

    delete process.env.DATABASE_URL;
    delete process.env.DATASTACK_PROXY_MODE;
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      'phase03-files-status-session-secret-min-32-chars';

    const secret = getAdminSessionSecret()!;
    const ownerCookie = await createAdminSessionToken(
      'admin@datastack.dev',
      secret,
      Date.now() + 60_000,
      1,
      'owner',
      'owner-1'
    );

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          engine: 'cloudcmd',
          role: 'owner',
          readOnly: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    // 1. Standalone Next.js mode (no reverse-proxy headers)
    const standaloneRes = await filesStatusGet(
      new NextRequest('http://localhost:3000/api/files/status', {
        headers: { cookie: `datastack_admin_session=${ownerCookie}` },
      })
    );
    assert.equal(standaloneRes.status, 200);
    const standaloneJson = (await standaloneRes.json()) as {
      ok: boolean;
      proxyMode: string;
      wsSupported: boolean;
      wsHint: string | null;
    };
    assert.equal(standaloneJson.ok, true);
    assert.equal(standaloneJson.proxyMode, 'standalone');
    assert.equal(standaloneJson.wsSupported, false);
    assert.ok(standaloneJson.wsHint && /HTTP polling/i.test(standaloneJson.wsHint));

    // 2. Nginx reverse-proxy headers present
    const nginxRes = await filesStatusGet(
      new NextRequest('http://localhost:3000/api/files/status', {
        headers: {
          cookie: `datastack_admin_session=${ownerCookie}`,
          'x-forwarded-host': 'console.example.com',
          'x-forwarded-proto': 'https',
        },
      })
    );
    assert.equal(nginxRes.status, 200);
    const nginxJson = (await nginxRes.json()) as {
      proxyMode: string;
      wsSupported: boolean;
      wsHint: string | null;
    };
    assert.equal(nginxJson.proxyMode, 'nginx');
    assert.equal(nginxJson.wsSupported, true);
    assert.equal(nginxJson.wsHint, null);

    // 3. UI component renders proxy hint element safely when present
    const workspaceSrc = fs.readFileSync(
      path.join(process.cwd(), 'components', 'sections', 'FilesManagerWorkspace.tsx'),
      'utf8'
    );
    assert.ok(workspaceSrc.includes('files-manager-proxy-hint'));
    assert.ok(workspaceSrc.includes('data.wsHint'));
  });

  it('AUDIT-13: middleware removes dead /api/auth/setup/status exemption and POST /api/auth/setup embeds explicit owner role/memberId', async () => {
    const mwSrc = fs.readFileSync(path.join(process.cwd(), 'middleware.ts'), 'utf8');
    assert.equal(mwSrc.includes('/api/auth/setup/status'), false);

    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      'phase03-setup-session-secret-at-least-32-chars';
    const mwRes = await middleware(
      new NextRequest('http://localhost:3000/api/auth/setup/status', { method: 'GET' })
    );
    assert.equal(mwRes.status, 401);

    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = 'false';
    process.env.DATASTACK_ADMIN_SETUP_KEY =
      'phase03-custom-setup-key-over-32-characters-long';

    const setupRes = await setupPost(
      new NextRequest('http://localhost:3000/api/auth/setup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.15',
        },
        body: JSON.stringify({
          email: 'founder@datastack.dev',
          password: 'FounderPassword123!',
          setupKey: process.env.DATASTACK_ADMIN_SETUP_KEY,
        }),
      })
    );
    assert.equal(setupRes.status, 200);
    const cookieVal = setupRes.cookies.get('datastack_admin_session')?.value;
    assert.ok(cookieVal);

    const payload = await getAdminSessionPayload(
      cookieVal!,
      process.env.DATASTACK_ADMIN_SESSION_SECRET
    );
    assert.ok(payload);
    assert.equal(payload!.email, 'founder@datastack.dev');
    assert.equal(payload!.role, 'owner');
    assert.equal(payload!.memberId, 'owner-1');
  });
});
