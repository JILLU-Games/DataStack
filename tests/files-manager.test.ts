import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAdminSessionToken } from '../core/auth/adminSession';

const fm = require('../server/filesManager');

test('FM-REQ-02: buildCloudCmdConfig enforces RCE lockdown, root jail, zip packer, and scrubs default tokens', () => {
  const tmpRoot = path.resolve(os.tmpdir(), 'datastack-fm-cfg-test');
  const cfg = fm.buildCloudCmdConfig(tmpRoot);

  assert.equal(cfg.root, tmpRoot);
  assert.equal(cfg.prefix, '/vcon/files-engine');
  assert.equal(cfg.console, false);
  assert.equal(cfg.terminal, false);
  assert.equal(cfg.configDialog, false);
  assert.equal(cfg.auth, false);
  assert.equal(cfg.open, false);
  assert.equal(cfg.online, false);
  assert.equal(cfg.contact, false);
  assert.equal(cfg.oneFilePanel, true);
  assert.equal(cfg.packer, 'zip');
  assert.equal(cfg.editor, 'edward');
  assert.equal(cfg.password, '');
  assert.equal(cfg.exportToken, '');
  assert.equal(cfg.importToken, '');
  assert.equal(cfg.dropboxToken, '');
});

test('FM-REQ-04: authenticateFilesRequest fails closed on missing prod secret and DB outages', async () => {
  const token = await createAdminSessionToken(
    'owner@datastack.dev',
    fm.DEV_DEFAULT_SESSION_SECRET,
    Date.now() + 60_000,
    1,
    'owner',
    'owner-1',
  );

  const prodMissing = await fm.authenticateFilesRequest({
    cookieHeader: `datastack_admin_session=${token}`,
    dbPool: null,
    env: { NODE_ENV: 'production', DATASTACK_ADMIN_SESSION_SECRET: '' },
  });
  assert.equal(prodMissing.valid, false);
  assert.equal(prodMissing.status, 503);
  assert.equal(prodMissing.code, 'FILES_AUTH_UNCONFIGURED');

  const dbUnavailable = await fm.authenticateFilesRequest({
    cookieHeader: `datastack_admin_session=${token}`,
    dbPool: {
      query: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
  });
  assert.equal(dbUnavailable.valid, false);
  assert.equal(dbUnavailable.status, 503);
  assert.equal(dbUnavailable.code, 'AUTH_DB_UNAVAILABLE');
});

test('FM-REQ-01..06: live CloudCmd mount enforces auth, DB revocation, RBAC, CSRF, *.lock & traversal guards, and full file CRUD + ZIP/UNZIP', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datastack-fm-e2e-'));
  fs.mkdirSync(path.join(tmpRoot, 'client-alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'client-alpha', '2026-11-20.csv'),
    'eventId,clientId\nev-1,client-alpha\n',
  );
  fs.writeFileSync(path.join(tmpRoot, 'client-alpha', '2026-11-20.csv.lock'), 'pid=99');

  const app = express();
  const server = http.createServer(app);
  let activeDbPool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null = null;

  const handle = await fm.mountFilesManager({
    app,
    server,
    rootDir: tmpRoot,
    getDbPool: () => activeDbPool,
  });

  try {
    assert.equal(handle.engineReady, true, `CloudCmd failed to init: ${handle.initErrorMessage}`);
    assert.equal(handle.socketPath, '/vcon/files-engine/socket.io');
    // Cloudcmd's Windows-specific representation must still resolve to the jailed root.
    assert.equal(path.resolve(handle.configOptions.root), tmpRoot);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hostHeader = `127.0.0.1:${address.port}`;

    const ownerToken = await createAdminSessionToken(
      'owner@datastack.dev',
      fm.DEV_DEFAULT_SESSION_SECRET,
      Date.now() + 60_000,
      1,
      'owner',
      'owner-1',
    );
    const viewerToken = await createAdminSessionToken(
      'viewer@datastack.dev',
      fm.DEV_DEFAULT_SESSION_SECRET,
      Date.now() + 60_000,
      1,
      'viewer',
      'member-viewer-1',
    );

    const ownerHeaders = {
      Cookie: `datastack_admin_session=${ownerToken}`,
      Origin: baseUrl,
      Host: hostHeader,
    };
    const viewerHeaders = {
      Cookie: `datastack_admin_session=${viewerToken}`,
      Origin: baseUrl,
      Host: hostHeader,
    };

    // 1. Unauthenticated access blocked
    assert.equal((await fetch(`${baseUrl}/vcon/files-engine/_status`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/vcon/files-engine/`)).status, 401);

    // 2. Authenticated status probe & locked HTML output
    const statusRes = await fetch(`${baseUrl}/vcon/files-engine/_status`, {
      headers: { Cookie: ownerHeaders.Cookie },
    });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { ok: boolean; role: string; readOnly: boolean };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.role, 'owner');
    assert.equal(statusJson.readOnly, false);

    const htmlRes = await fetch(`${baseUrl}/vcon/files-engine/`, {
      headers: { Cookie: ownerHeaders.Cookie },
    });
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('/vcon/files-engine'));
    assert.ok(html.includes('"console":false'));
    assert.ok(html.includes('"terminal":false'));
    assert.ok(html.includes('"configDialog":false'));
    assert.ok(html.includes('"packer":"zip"'));

    // 3. Create, rename, ZIP, UNZIP, download, and delete
    const createRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/fs/client-alpha/note.csv`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: 'k,v\n1,ok\n',
    });
    if (createRes.status !== 200) {
      assert.fail(`Cloudcmd PUT failed with ${createRes.status}: ${(await createRes.text()).slice(0, 240)}`);
    }
    assert.equal(fs.readFileSync(path.join(tmpRoot, 'client-alpha', 'note.csv'), 'utf8'), 'k,v\n1,ok\n');

    const renameRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/rename`, {
      method: 'PUT',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/client-alpha/note.csv', to: '/client-alpha/note-renamed.csv' }),
    });
    assert.equal(renameRes.status, 200);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'client-alpha', 'note-renamed.csv')), true);

    const packRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/pack`, {
      method: 'PUT',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '/client-alpha',
        to: '/client-alpha/bundle.zip',
        names: ['note-renamed.csv'],
      }),
    });
    assert.equal(packRes.status, 200);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'client-alpha', 'bundle.zip')), true);

    fs.mkdirSync(path.join(tmpRoot, 'client-alpha', 'extracted'), { recursive: true });
    const extractRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/extract`, {
      method: 'PUT',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '/client-alpha/bundle.zip',
        to: '/client-alpha/extracted',
      }),
    });
    assert.equal(extractRes.status, 200);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'client-alpha', 'extracted', 'note-renamed.csv')), true);

    const downloadRes = await fetch(
      `${baseUrl}/vcon/files-engine/fs/client-alpha/note-renamed.csv?download`,
      { headers: { Cookie: ownerHeaders.Cookie } },
    );
    assert.equal(downloadRes.status, 200);
    assert.equal(await downloadRes.text(), 'k,v\n1,ok\n');

    const deleteRes = await fetch(
      `${baseUrl}/vcon/files-engine/api/v1/fs/client-alpha/note-renamed.csv`,
      { method: 'DELETE', headers: ownerHeaders },
    );
    assert.equal(deleteRes.status, 200);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'client-alpha', 'note-renamed.csv')), false);

    // 4. Viewer role: GET allowed, mutations blocked (403)
    const viewerList = await fetch(`${baseUrl}/vcon/files-engine/api/v1/fs/`, {
      headers: { Cookie: viewerHeaders.Cookie },
    });
    assert.equal(viewerList.status, 200);

    const viewerWrite = await fetch(`${baseUrl}/vcon/files-engine/api/v1/fs/client-alpha/nope.csv`, {
      method: 'PUT',
      headers: viewerHeaders,
      body: 'blocked',
    });
    assert.equal(viewerWrite.status, 403);
    assert.equal(((await viewerWrite.json()) as { code: string }).code, 'INSUFFICIENT_ROLE_PERMISSION');

    // 5. Cross-origin CSRF rejected (403)
    const csrfRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/fs/client-alpha/csrf.csv`, {
      method: 'PUT',
      headers: { Cookie: ownerHeaders.Cookie, Origin: 'https://evil.example', Host: hostHeader },
      body: 'blocked',
    });
    assert.equal(csrfRes.status, 403);
    assert.equal(((await csrfRes.json()) as { code: string }).code, 'CSRF_REJECTED');

    // 6. Cooperative *.lock protection in URL and JSON body
    const lockUrlRes = await fetch(
      `${baseUrl}/vcon/files-engine/api/v1/fs/client-alpha/2026-11-20.csv.lock`,
      { method: 'DELETE', headers: ownerHeaders },
    );
    assert.equal(lockUrlRes.status, 403);
    assert.equal(((await lockUrlRes.json()) as { code: string }).code, 'LOCKFILE_PROTECTED');

    const lockBodyRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/rename`, {
      method: 'PUT',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '/client-alpha/2026-11-20.csv.lock',
        to: '/client-alpha/hijack.csv',
      }),
    });
    assert.equal(lockBodyRes.status, 403);
    assert.equal(((await lockBodyRes.json()) as { code: string }).code, 'LOCKFILE_PROTECTED');

    // 7. Path traversal & runtime config PATCH blocked
    const travRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/fs/..%2F..%2Fpackage.json`, {
      headers: { Cookie: ownerHeaders.Cookie },
    });
    assert.equal(travRes.status, 403);
    assert.equal(((await travRes.json()) as { code: string }).code, 'PATH_OUTSIDE_ROOT');

    const cfgPatchRes = await fetch(`${baseUrl}/vcon/files-engine/api/v1/config`, {
      method: 'PATCH',
      headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ console: true }),
    });
    assert.equal(cfgPatchRes.status, 403);
    assert.equal(((await cfgPatchRes.json()) as { code: string }).code, 'CONFIG_LOCKED');

    // 8. Revoked DB token_version immediately rejects session (401 SESSION_REVOKED)
    activeDbPool = {
      query: async (sql: string) => {
        if (sql.includes('admin_users')) {
          return { rows: [{ email: 'owner@datastack.dev', token_version: 2 }] };
        }
        return { rows: [] };
      },
    };
    const revokedRes = await fetch(`${baseUrl}/vcon/files-engine/_status`, {
      headers: { Cookie: ownerHeaders.Cookie },
    });
    assert.equal(revokedRes.status, 401);
    assert.equal(((await revokedRes.json()) as { code: string }).code, 'SESSION_REVOKED');
  } finally {
    await handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('FM-REQ-07..09: proxy routing, SW bypass, Sidebar nav, and /vcon/files workspace are cleanly wired', () => {
  const root = process.cwd();
  const nextConfig = fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8');
  const coolifyNginx = fs.readFileSync(path.join(root, 'docker', 'coolify-nginx.conf'), 'utf8');
  const localNginx = fs.readFileSync(path.join(root, 'nginx', 'default.conf'), 'utf8');
  const swJs = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  const sidebar = fs.readFileSync(path.join(root, 'components', 'layout', 'Sidebar.tsx'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'app', 'vcon', 'files', 'page.tsx'), 'utf8');
  const workspace = fs.readFileSync(
    path.join(root, 'components', 'sections', 'FilesManagerWorkspace.tsx'),
    'utf8',
  );

  assert.ok(nextConfig.includes("source: '/vcon/files-engine/:path*'"));
  assert.ok(coolifyNginx.includes('location /vcon/files-engine'));
  assert.ok(localNginx.includes('location /vcon/files-engine'));
  assert.ok(swJs.includes("url.pathname.startsWith('/vcon/files-engine/')"));
  assert.ok(sidebar.includes("{ name: 'Files Manager', href: '/vcon/files', icon: 'FolderOpen' }"));
  assert.ok(page.includes('FilesManagerWorkspace'));
  const statusRoute = fs.readFileSync(
    path.join(root, 'app', 'api', 'files', 'status', 'route.ts'),
    'utf8',
  );
  assert.ok(statusRoute.includes('/vcon/files-engine/_status'));
  assert.ok(workspace.includes('/api/files/status'));
  assert.ok(workspace.includes('files-manager-offline'));
  assert.ok(workspace.includes('files-manager-iframe'));
});
