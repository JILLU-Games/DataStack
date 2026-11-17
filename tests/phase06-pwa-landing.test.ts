import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

function readPngDimensions(filePath: string): { width: number; height: number } {
  const buf = fs.readFileSync(filePath);
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(pngSig), `${path.basename(filePath)} must be a valid PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

test('BUG-25: PWA manifest, icons (192/512/maskable/apple-touch), and Service Worker are complete and valid', () => {
  const manifestPath = path.join(ROOT, 'public/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.short_name && manifest.short_name.length <= 12);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  for (const icon of manifest.icons) {
    assert.ok(!String(icon.purpose || '').includes('any maskable'), 'Separate any and maskable purposes');
    const rel = String(icon.src).replace(/^\//, '');
    const full = path.join(ROOT, 'public', rel);
    assert.ok(fs.existsSync(full), `Missing manifest icon ${icon.src}`);
    const [expW, expH] = String(icon.sizes).split('x').map(Number);
    const dims = readPngDimensions(full);
    assert.equal(dims.width, expW);
    assert.equal(dims.height, expH);
  }

  const appleDims = readPngDimensions(path.join(ROOT, 'public/apple-touch-icon.png'));
  assert.deepEqual(appleDims, { width: 180, height: 180 });
  assert.ok(fs.existsSync(path.join(ROOT, 'public/icon.svg')));

  const swContent = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(swContent, /request\.method !== ['"]GET['"]/);
  assert.match(swContent, /\/api\//);
  assert.match(swContent, /\/socket\.io\//);
  assert.match(swContent, /new Response\(/);

  const layoutContent = fs.readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8');
  assert.match(layoutContent, /PwaLifecycle/);
  assert.match(layoutContent, /export const viewport: Viewport/);
  assert.match(layoutContent, /apple-touch-icon\.png/);

  const pwaClient = fs.readFileSync(path.join(ROOT, 'components/pwa/PwaLifecycle.tsx'), 'utf8');
  assert.match(pwaClient, /serviceWorker\.register\(['"]\/sw\.js['"]/);
  assert.match(pwaClient, /beforeinstallprompt/);
});

test('BUG-17: Landing/Navbar/Footer/404 navigation uses root-relative anchors and valid Link semantics', () => {
  const files = [
    'components/layout/Navbar.tsx',
    'components/layout/Footer.tsx',
    'components/sections/Hero.tsx',
    'components/sections/LandingAbout.tsx',
    'app/not-found.tsx',
  ];

  for (const rel of files) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/href=["']#/.test(content), false, `${rel} should use /#... root anchors instead of bare #...`);
    const linkBlocks = content.match(/<Link\b[\s\S]*?<\/Link>/g) || [];
    for (const block of linkBlocks) {
      assert.equal(/<Button\b/.test(block), false, `${rel} should not nest <Button> inside <Link>: ${block}`);
    }
  }

  const notFoundContent = fs.readFileSync(path.join(ROOT, 'app/not-found.tsx'), 'utf8');
  assert.match(notFoundContent, /href=["']\/["']/);
  assert.match(notFoundContent, /href=["']\/vcon\/dashboard["']/);
});
