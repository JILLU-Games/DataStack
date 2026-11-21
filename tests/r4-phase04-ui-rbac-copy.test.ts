import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getVconRoleCapabilities } from '../lib/vconUiHelpers';

const ROOT = process.cwd();

async function readSource(relPath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relPath), 'utf8');
}

test('R4-Phase-04 [AUDIT-14]: TeamWorkspace seeds role from useVconRole, confirms deletes via Modal, and distinguishes operator vs admin', async () => {
  const src = await readSource('components/sections/TeamWorkspace.tsx');

  // Eliminates hardcoded 'owner' initial flash
  assert.match(src, /useVconRole\(\)/);
  assert.doesNotMatch(src, /useState<string>\(\s*['"]owner['"]\s*\)/);
  assert.match(src, /useState<string>\(\(\)\s*=>\s*shellRole\s*\|\|\s*['"]viewer['"]\)/);

  // Explicit delete confirmation modal before DELETE /api/team/[id]
  assert.match(src, /setDeleteTarget\(row\)/);
  assert.match(src, /title="Confirm Team Member Removal"/);
  assert.match(src, /data-testid="confirm-remove-member"/);
  assert.doesNotMatch(src, /onClick=\{\(\)\s*=>\s*void handleDeleteMember\(row\)\}/);

  // Preserves distinct operator vs admin options instead of silently coercing operator -> admin
  assert.doesNotMatch(src, /row\.role === ['"]operator['"] \? ['"]admin['"]/);
  assert.match(src, /value:\s*['"]operator['"]/);
  assert.match(src, /value:\s*['"]admin['"]/);
});

test('R4-Phase-04 [AUDIT-15 / ERR-R4-10]: /vcon/sdk skips ?includeToken=true fetch for viewer and renders explicit RBAC notice', async () => {
  const src = await readSource('app/vcon/sdk/page.tsx');

  assert.match(src, /useVconRole\(\)/);
  assert.match(src, /getVconRoleCapabilities\(shellRole\)/);
  assert.match(src, /if \(!selectedClientId \|\| !canOperate\)/);
  assert.match(src, /data-testid="sdk-viewer-rbac-banner"/);
  assert.match(src, /Operator or Owner role required/i);

  // Confirm capability helper blocks viewer token retrieval while allowing operator/admin/owner
  assert.equal(getVconRoleCapabilities('viewer').canOperate, false);
  assert.equal(getVconRoleCapabilities('operator').canOperate, true);
  assert.equal(getVconRoleCapabilities('admin').canOperate, true);
  assert.equal(getVconRoleCapabilities('owner').canOperate, true);

  // Preserve V2-Phase-04 and R2-Phase-03 compatibility checks
  assert.match(src, /Python SDK \(v2\.2\.0\)/);
  assert.match(src, /Node\.js \/ TypeScript SDK \(v2\.2\.0\)/);
  assert.match(src, /setSelectedClientToken\(''\);\s*\n\s*setLoadingToken\(true\);/);
});

test('R4-Phase-04 [AUDIT-16]: Sidebar uses useVconRole and Client SDKs label; Navbar covers all admin routes', async () => {
  const sidebarSrc = await readSource('components/layout/Sidebar.tsx');
  assert.match(sidebarSrc, /useVconRole\(\)/);
  assert.match(sidebarSrc, /\{\s*name:\s*['"]Client SDKs['"],\s*href:\s*['"]\/vcon\/sdk['"]/);
  assert.doesNotMatch(sidebarSrc, /\{\s*name:\s*['"]Python SDK['"]/);
  assert.doesNotMatch(sidebarSrc, /getCached<CachedProfile>\('vcon:profile',\s*\{\}\)\.role\s*\|\|\s*['"]Owner['"]/);
  assert.match(sidebarSrc, /getCached<CachedProfile>\('vcon:profile',\s*\{\}\)\.role\s*\|\|\s*initialRoleLabel/);

  const navbarSrc = await readSource('components/layout/Navbar.tsx');
  assert.match(navbarSrc, /'\/vcon\/files':\s*'Files Manager'/);
  assert.match(navbarSrc, /'\/vcon\/sdk':\s*'Client SDKs'/);
  assert.match(navbarSrc, /'\/vcon\/team':\s*'Team & RBAC'/);
  assert.match(navbarSrc, /'\/vcon\/audit':\s*'Audit Log'/);
  assert.doesNotMatch(navbarSrc, /'\/vcon\/sdk':\s*'Python SDK'/);
});

test('R4-Phase-04 [AUDIT-19 & AUDIT-07]: ProfileWorkspace drops hardcoded demo defaults and DataBrowser surfaces corruptPartitions warnings', async () => {
  const profileSrc = await readSource('components/sections/ProfileWorkspace.tsx');
  assert.doesNotMatch(profileSrc, /DEFAULT_PROFILE/);
  assert.doesNotMatch(profileSrc, /email:\s*'admin@datastack\.dev'/);
  assert.doesNotMatch(profileSrc, /storageMode:\s*'In-Memory'/);
  assert.match(profileSrc, /EMPTY_PROFILE/);
  assert.match(profileSrc, /Loading\.\.\./);

  const dataBrowserSrc = await readSource('components/sections/DataBrowser.tsx');
  assert.match(dataBrowserSrc, /corruptPartitions/);
  assert.match(dataBrowserSrc, /data-testid="data-corrupt-partitions-warning"/);
});

test('R4-Phase-04 [AUDIT-18]: Public landing Hero, SdkSection, and LandingAbout reflect both Python and Node.js / TypeScript SDKs', async () => {
  const heroSrc = await readSource('components/sections/Hero.tsx');
  assert.match(heroSrc, /href="\/#sdk"[\s\S]*?>\s*Client SDKs\s*<\/Link>/);
  assert.doesNotMatch(heroSrc, />\s*Python SDK\s*<\/Link>/);

  const sdkSectionSrc = await readSource('components/sections/SdkSection.tsx');
  assert.match(sdkSectionSrc, /label="Client SDKs"/);
  assert.match(sdkSectionSrc, /datastack/);
  assert.match(sdkSectionSrc, /@datastack\/sdk/);
  assert.match(sdkSectionSrc, /npm install/);
  assert.match(sdkSectionSrc, /pip install/);

  const aboutSrc = await readSource('components/sections/LandingAbout.tsx');
  assert.match(aboutSrc, /href="\/#sdk"[\s\S]*?>\s*View Client SDKs\s*<\/Link>/);
  assert.doesNotMatch(aboutSrc, /View Python SDK/);
});
