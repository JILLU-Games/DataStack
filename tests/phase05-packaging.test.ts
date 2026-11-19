import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

test('BUG-E01 & BUG-E03: Canonical datastack and compat datastack-sdk packaging metadata, versions, and py.typed align', () => {
  const pyproject = fs.readFileSync(
    path.join(ROOT, 'sdk/python/datastack/pyproject.toml'),
    'utf8',
  );
  const canonicalSetup = fs.readFileSync(
    path.join(ROOT, 'sdk/python/datastack/setup.py'),
    'utf8',
  );
  const compatSetup = fs.readFileSync(
    path.join(ROOT, 'sdk-python/setup.py'),
    'utf8',
  );
  const canonicalInit = fs.readFileSync(
    path.join(ROOT, 'sdk/python/datastack/datastack/__init__.py'),
    'utf8',
  );

  assert.match(canonicalInit, /__version__\s*=\s*["']2\.2\.0["']/);
  assert.match(pyproject, /version\s*=\s*"2\.2\.0"/);
  assert.match(canonicalSetup, /version="2\.2\.0"/);
  assert.match(compatSetup, /version="2\.2\.0"/);

  assert.equal(
    fs.existsSync(path.join(ROOT, 'sdk/python/datastack/datastack/py.typed')),
    true,
    'PEP 561 py.typed marker must exist in datastack package',
  );
  assert.match(pyproject, /datastack\s*=\s*\["py\.typed"\]/);
  assert.match(canonicalSetup, /package_data=\{"datastack": \["py\.typed"\]\}/);

  for (const dep of [
    '"python-socketio[client]>=5.8.0"',
    '"requests>=2.28.0"',
    '"websocket-client>=1.5.0"',
  ]) {
    assert.ok(pyproject.includes(dep), `pyproject.toml missing ${dep}`);
    assert.ok(canonicalSetup.includes(dep), `setup.py missing ${dep}`);
    assert.ok(compatSetup.includes(dep), `sdk-python/setup.py missing ${dep}`);
  }
});

test('BUG-E03 & BUG-E04: Root package.json engines and production start-all shutdown coordination are valid', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.engines?.node, '>=20.0.0');
  assert.equal(pkg.scripts?.start, 'node scripts/start-all.js');
  assert.equal(pkg.scripts?.['start:web'], 'next start');
  assert.equal(pkg.scripts?.['start:server'], 'node server/index.js');

  const startAll = fs.readFileSync(
    path.join(ROOT, 'scripts/start-all.js'),
    'utf8',
  );
  assert.match(startAll, /markChildExited/);
  assert.match(startAll, /exitedChildren >= 2/);
});

test('BUG-26: Legacy datastack-sdk declares datastack>=2.2.0 dependency and raises actionable ImportError', () => {
  const compatSetup = fs.readFileSync(
    path.join(ROOT, 'sdk-python/setup.py'),
    'utf8',
  );
  const compatInit = fs.readFileSync(
    path.join(ROOT, 'sdk-python/datastack_sdk/__init__.py'),
    'utf8',
  );

  assert.ok(
    compatSetup.includes('"datastack>=2.2.0"'),
    'sdk-python/setup.py install_requires must include datastack>=2.2.0',
  );
  assert.match(
    compatInit,
    /raise ImportError\([\s\S]*datastack>=2\.2\.0[\s\S]*pip install \.\/sdk\/python\/datastack/,
    'sdk-python/datastack_sdk/__init__.py must provide actionable install guidance if canonical datastack is missing',
  );
});

test('BUG-27: start-all.js and dev-all.js avoid shell: true orphaning and allow >= 7000ms graceful shutdown flush', () => {
  for (const relPath of ['scripts/start-all.js', 'scripts/dev-all.js']) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    assert.equal(
      /shell:\s*true/.test(src),
      false,
      `${relPath} must NOT use shell: true (prevents orphaned child processes on SIGTERM)`,
    );
    assert.match(src, /shell:\s*false/, `${relPath} must explicitly set shell: false`);
    assert.match(
      src,
      /spawn\(\s*process\.execPath/,
      `${relPath} must spawn child services directly via process.execPath`,
    );
    assert.match(
      src,
      /GRACEFUL_SHUTDOWN_TIMEOUT_MS\s*=\s*7000/,
      `${relPath} must wait at least 7000ms for graceful CSV/Redis shutdown flush`,
    );
    assert.match(src, /SIGKILL/, `${relPath} must escalate to SIGKILL after grace timeout`);
    assert.match(src, /exitedChildren >= 2/, `${relPath} must wait for both child processes`);
  }
});
