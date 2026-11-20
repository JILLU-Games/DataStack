import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type AdminRole,
  type AdminSessionPayload,
  getAdminSessionPayload,
  getAdminSessionSecret,
  normalizeAdminRole,
} from "./adminSession";
import { clearAuditLogsForTests } from "./auditLog";
import { DatabaseEngine, ensureCoreSchemaOnPool } from "../Database/database";

const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const DATABASE_LOCK_ID = "72025102501";
const LOGIN_ATTEMPT_LIMIT = 5;
const IP_LOGIN_ATTEMPT_LIMIT = 25;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOCAL_THROTTLE_MAX_ENTRIES = 5000;
const LOCAL_THROTTLE_CLEANUP_MS = 60 * 1000;
const DEV_DEFAULT_SETUP_KEY = "datastack-default-setup-key-32-chars";

interface LoginThrottleEntry {
  windowStartedAt: number;
  failedAttempts: number;
  blockedUntil: number;
  updatedAt: number;
}

interface LoginThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface LoginThrottleBucket {
  keyHash: string;
  limit: number;
}

interface InMemoryAdmin {
  id: number;
  email: string;
  passwordSalt: Buffer;
  passwordHash: Buffer;
  tokenVersion: number;
  createdAt: Date;
}

interface InMemoryTeamMember {
  id: string;
  email: string;
  role: AdminRole;
  status: "active" | "disabled";
  passwordSalt: Buffer;
  passwordHash: Buffer;
  tokenVersion: number;
  invitedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminTeamMemberPublic {
  id: string;
  email: string;
  role: AdminRole;
  status: "active" | "disabled";
  tokenVersion: number;
  invitedBy: string;
  isPrimaryOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

type AdminDatabaseGlobals = typeof globalThis & {
  __dataStackAdminSchema?: Promise<void>;
  __dataStackInMemoryAdmin?: InMemoryAdmin;
  __dataStackInMemoryTeamMembers?: Map<string, InMemoryTeamMember>;
  __dataStackLastVerifiedMemberId?: string;
};

const globals = globalThis as AdminDatabaseGlobals;
const localLoginThrottle = new Map<string, LoginThrottleEntry>();
let lastLocalThrottleCleanup = 0;
let lastDatabaseThrottleCleanup = 0;

function getInMemoryTeamMap(): Map<string, InMemoryTeamMember> {
  if (!(globals.__dataStackInMemoryTeamMembers instanceof Map)) {
    globals.__dataStackInMemoryTeamMembers = new Map<
      string,
      InMemoryTeamMember
    >();
  }
  return globals.__dataStackInMemoryTeamMembers;
}

export class AdminSetupRequiredError extends Error {
  public readonly code = "SETUP_REQUIRED";

  constructor(message = "Admin account has not completed initial setup.") {
    super(message);
    this.name = "AdminSetupRequiredError";
  }
}

export class AdminDatabaseRequiredError extends Error {
  public readonly code = "DATABASE_NOT_CONFIGURED";

  constructor(
    message = "PostgreSQL DATABASE_URL is required for initial admin setup in production.",
  ) {
    super(message);
    this.name = "AdminDatabaseRequiredError";
  }
}

export class PrimaryOwnerProtectedError extends Error {
  public readonly code = "CANNOT_REVOKE_PRIMARY_OWNER";

  constructor(
    message = "CANNOT_REVOKE_PRIMARY_OWNER: The primary Owner account (id=1) cannot be deleted, disabled, or demoted.",
  ) {
    super(message);
    this.name = "PrimaryOwnerProtectedError";
  }
}

export class TeamMemberValidationError extends Error {
  public readonly code: string;

  constructor(message: string, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "TeamMemberValidationError";
    this.code = code;
  }
}

function isProductionEnv() {
  return process.env.NODE_ENV === "production";
}

export function isAdminDatabaseConfigured(): boolean {
  return Boolean(getPool());
}

export function requiresPersistentAdminDatabase(): boolean {
  return (
    isProductionEnv() &&
    !getPool() &&
    !process.env.DATASTACK_ADMIN_PASSWORD
  );
}

function getPool(): Pool | null {
  return DatabaseEngine.getPool();
}

async function ensureAdminTable() {
  const pool = getPool();
  if (!pool) return;

  globals.__dataStackAdminSchema ??= ensureCoreSchemaOnPool(pool);

  try {
    await globals.__dataStackAdminSchema;
  } catch (error) {
    globals.__dataStackAdminSchema = undefined;
    throw error;
  }
}

function derivePasswordHash(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, PASSWORD_HASH_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function matchesSecret(candidate: string, expected: string) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export function getAdminSetupKey(): string | null {
  const configured = process.env.DATASTACK_ADMIN_SETUP_KEY?.trim() || "";
  if (isProductionEnv()) {
    return configured.length >= 32 ? configured : null;
  }
  if (configured.length > 0) {
    return configured.length >= 32 ? configured : null;
  }
  return DEV_DEFAULT_SETUP_KEY;
}

export function createLoginThrottleBuckets(
  email: string,
  secret: string,
  ip = "unknown",
): LoginThrottleBucket[] {
  const cleanEmail = email.trim().toLowerCase();
  const cleanIp = ip.trim().toLowerCase() || "unknown";
  const buckets: LoginThrottleBucket[] = [
    {
      keyHash: createHmac("sha256", secret)
        .update(`ip_email:${cleanIp}:${cleanEmail}`)
        .digest("hex"),
      limit: LOGIN_ATTEMPT_LIMIT,
    },
  ];
  if (cleanIp !== "unknown") {
    buckets.push({
      keyHash: createHmac("sha256", secret)
        .update(`ip:${cleanIp}`)
        .digest("hex"),
      limit: IP_LOGIN_ATTEMPT_LIMIT,
    });
  }
  return buckets;
}

function getAdvisoryLockId(keyHash: string) {
  return BigInt.asIntN(64, BigInt(`0x${keyHash.slice(0, 16)}`)).toString();
}

async function lockLoginThrottleKeys(client: PoolClient, keyHashes: string[]) {
  const lockIds = [...new Set(keyHashes.map(getAdvisoryLockId))].sort(
    (left, right) => (BigInt(left) < BigInt(right) ? -1 : 1),
  );

  for (const lockId of lockIds) {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockId]);
  }
}

function cleanupLocalLoginThrottle(now: number) {
  if (now - lastLocalThrottleCleanup < LOCAL_THROTTLE_CLEANUP_MS) return;
  lastLocalThrottleCleanup = now;

  for (const [keyHash, entry] of localLoginThrottle) {
    if (now - entry.updatedAt >= LOGIN_WINDOW_MS + LOGIN_BLOCK_MS) {
      localLoginThrottle.delete(keyHash);
    }
  }

  while (localLoginThrottle.size > LOCAL_THROTTLE_MAX_ENTRIES) {
    const oldestKey = localLoginThrottle.keys().next().value;
    if (!oldestKey) break;
    localLoginThrottle.delete(oldestKey);
  }
}

function consumeLocalLoginAttempt(
  buckets: LoginThrottleBucket[],
  now: number,
): LoginThrottleDecision {
  cleanupLocalLoginThrottle(now);

  const blockedUntil = buckets.reduce(
    (latest, bucket) =>
      Math.max(
        latest,
        localLoginThrottle.get(bucket.keyHash)?.blockedUntil ?? 0,
      ),
    0,
  );
  if (blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }

  for (const bucket of buckets) {
    const previous = localLoginThrottle.get(bucket.keyHash);
    const windowExpired =
      !previous || now - previous.windowStartedAt >= LOGIN_WINDOW_MS;
    const failedAttempts = windowExpired ? 1 : previous.failedAttempts + 1;
    localLoginThrottle.set(bucket.keyHash, {
      windowStartedAt: windowExpired ? now : previous.windowStartedAt,
      failedAttempts,
      blockedUntil:
        failedAttempts >= bucket.limit ? now + LOGIN_BLOCK_MS : 0,
      updatedAt: now,
    });
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

async function consumeDatabaseLoginAttempt(
  buckets: LoginThrottleBucket[],
  now: number,
): Promise<LoginThrottleDecision> {
  const pool = getPool();
  if (!pool) return consumeLocalLoginAttempt(buckets, now);
  await ensureAdminTable();
  const keyHashes = buckets.map((b) => b.keyHash);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await lockLoginThrottleKeys(client, keyHashes);
    const result = await client.query(
      `SELECT key_hash, window_started_at, failed_attempts, blocked_until
       FROM admin_login_attempts
       WHERE key_hash = ANY($1::text[])
       FOR UPDATE`,
      [keyHashes],
    );

    const entries = new Map(
      result.rows.map((row) => [row.key_hash as string, row]),
    );
    const blockedUntil = result.rows.reduce((latest, row) => {
      const timestamp = row.blocked_until
        ? new Date(row.blocked_until as string | Date).getTime()
        : 0;
      return Math.max(latest, timestamp);
    }, 0);

    if (blockedUntil > now) {
      await client.query("COMMIT");
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
      };
    }

    for (const bucket of buckets) {
      const previous = entries.get(bucket.keyHash);
      const windowStartedAt = previous
        ? new Date(previous.window_started_at as string | Date).getTime()
        : 0;
      const windowExpired =
        !previous || now - windowStartedAt >= LOGIN_WINDOW_MS;
      const failedAttempts = windowExpired
        ? 1
        : Number(previous.failed_attempts) + 1;
      const nextWindowStartedAt = windowExpired
        ? new Date(now)
        : new Date(windowStartedAt);
      const nextBlockedUntil =
        failedAttempts >= bucket.limit
          ? new Date(now + LOGIN_BLOCK_MS)
          : null;

      await client.query(
        `INSERT INTO admin_login_attempts
           (key_hash, window_started_at, failed_attempts, blocked_until, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key_hash) DO UPDATE SET
           window_started_at = EXCLUDED.window_started_at,
           failed_attempts = EXCLUDED.failed_attempts,
           blocked_until = EXCLUDED.blocked_until,
           updated_at = NOW()`,
        [bucket.keyHash, nextWindowStartedAt, failedAttempts, nextBlockedUntil],
      );
    }

    if (now - lastDatabaseThrottleCleanup >= LOCAL_THROTTLE_CLEANUP_MS) {
      await client.query(
        "DELETE FROM admin_login_attempts WHERE updated_at < NOW() - INTERVAL '24 hours'",
      );
      lastDatabaseThrottleCleanup = now;
    }

    await client.query("COMMIT");
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getOrInitInMemoryAdmin(): Promise<InMemoryAdmin> {
  if (!globals.__dataStackInMemoryAdmin) {
    const envPassword = process.env.DATASTACK_ADMIN_PASSWORD;
    const allowDemo =
      !isProductionEnv() && process.env.DATASTACK_ALLOW_DEMO_ADMIN !== "false";

    if (!envPassword && !allowDemo) {
      throw new AdminSetupRequiredError();
    }

    const defaultEmail = (
      process.env.DATASTACK_ADMIN_EMAIL || "admin@datastack.dev"
    )
      .trim()
      .toLowerCase();
    const defaultPassword = envPassword || "admin12345678";
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const hash = await derivePasswordHash(defaultPassword, salt);
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: defaultEmail,
      passwordSalt: salt,
      passwordHash: hash,
      tokenVersion: 1,
      createdAt: new Date(),
    };
  }
  return globals.__dataStackInMemoryAdmin;
}

export async function consumeAdminLoginAttempt(
  email: string,
  secret: string,
  ip = "unknown",
): Promise<LoginThrottleDecision> {
  const buckets = createLoginThrottleBuckets(email, secret, ip);
  const now = Date.now();

  const pool = getPool();
  if (!pool) {
    return consumeLocalLoginAttempt(buckets, now);
  }

  return await consumeDatabaseLoginAttempt(buckets, now);
}

export async function clearAdminLoginAttempts(
  email: string,
  secret: string,
  ip = "unknown",
) {
  const buckets = createLoginThrottleBuckets(email, secret, ip);
  const keyHashes = buckets.map((b) => b.keyHash);

  const pool = getPool();
  if (!pool) {
    keyHashes.forEach((keyHash) => localLoginThrottle.delete(keyHash));
    return;
  }

  await ensureAdminTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockLoginThrottleKeys(client, keyHashes);
    await client.query(
      "DELETE FROM admin_login_attempts WHERE key_hash = ANY($1::text[])",
      [keyHashes],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function verifyAdminSetupKey(candidate: string) {
  const expected = getAdminSetupKey();
  if (!expected || expected.length < 32 || !candidate) return false;
  return matchesSecret(candidate, expected);
}

export async function isAdminSetupComplete() {
  const pool = getPool();
  if (!pool) {
    if (globals.__dataStackInMemoryAdmin) {
      return true;
    }
    if (isProductionEnv()) {
      return Boolean(process.env.DATASTACK_ADMIN_PASSWORD);
    }
    return process.env.DATASTACK_ALLOW_DEMO_ADMIN !== "false";
  }

  await ensureAdminTable();
  const result = await pool.query("SELECT 1 FROM admin_users WHERE id = 1");
  return result.rowCount === 1;
}

export async function createInitialAdmin(email: string, password: string) {
  const cleanEmail = email.trim().toLowerCase();
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const passwordHash = await derivePasswordHash(password, salt);
  const pool = getPool();

  if (!pool) {
    if (isProductionEnv()) {
      throw new AdminDatabaseRequiredError();
    }
    if (globals.__dataStackInMemoryAdmin) {
      return false;
    }
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash,
      tokenVersion: 1,
      createdAt: new Date(),
    };
    return true;
  }

  await ensureAdminTable();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      DATABASE_LOCK_ID,
    ]);

    const existing = await client.query(
      "SELECT 1 FROM admin_users WHERE id = 1",
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `INSERT INTO admin_users (id, email, password_salt, password_hash, token_version)
       VALUES (1, $1, $2, $3, 1)`,
      [cleanEmail, salt, passwordHash],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateAdminCredentials(
  email: string,
  password: string,
): Promise<{
  authenticated: boolean;
  tokenVersion: number;
  role: AdminRole;
  memberId: string;
  email: string;
}> {
  const cleanEmail = email.trim().toLowerCase();
  const pool = getPool();

  if (pool) {
    await ensureAdminTable();
    const result = await pool.query(
      `SELECT email, password_salt, password_hash, COALESCE(token_version, 1) AS token_version
       FROM admin_users
       WHERE id = 1`,
    );
    if (!result.rowCount || result.rowCount === 0) {
      return {
        authenticated: false,
        tokenVersion: 0,
        role: "owner",
        memberId: "owner-1",
        email: cleanEmail,
      };
    }
    const admin = result.rows[0] as {
      email: string;
      password_salt: Buffer;
      password_hash: Buffer;
      token_version: number;
    };
    const emailMatches = matchesSecret(
      cleanEmail,
      admin.email.trim().toLowerCase(),
    );
    if (emailMatches) {
      const actualHash = await derivePasswordHash(
        password,
        admin.password_salt,
      );
      const passwordMatches = timingSafeEqual(actualHash, admin.password_hash);
      return {
        authenticated: passwordMatches,
        tokenVersion: passwordMatches ? Number(admin.token_version) || 1 : 0,
        role: "owner",
        memberId: "owner-1",
        email: admin.email,
      };
    }

    // Check secondary team members in PostgreSQL
    const teamResult = await pool.query(
      `SELECT id, email, role, status, password_salt, password_hash, COALESCE(token_version, 1) AS token_version
       FROM admin_team_members
       WHERE LOWER(email) = $1`,
      [cleanEmail],
    );
    if (!teamResult.rowCount || teamResult.rowCount === 0) {
      return {
        authenticated: false,
        tokenVersion: 0,
        role: "viewer",
        memberId: "",
        email: cleanEmail,
      };
    }

    const member = teamResult.rows[0] as {
      id: string;
      email: string;
      role: string;
      status: string;
      password_salt: Buffer;
      password_hash: Buffer;
      token_version: number;
    };
    if (member.status !== "active") {
      return {
        authenticated: false,
        tokenVersion: 0,
        role: normalizeAdminRole(member.role),
        memberId: member.id,
        email: member.email,
      };
    }
    const actualHash = await derivePasswordHash(password, member.password_salt);
    const passwordMatches = timingSafeEqual(actualHash, member.password_hash);
    return {
      authenticated: passwordMatches,
      tokenVersion: passwordMatches ? Number(member.token_version) || 1 : 0,
      role: normalizeAdminRole(member.role),
      memberId: member.id,
      email: member.email,
    };
  }

  const inMem = await getOrInitInMemoryAdmin();
  if (matchesSecret(cleanEmail, inMem.email)) {
    const actualHash = await derivePasswordHash(password, inMem.passwordSalt);
    const authenticated = timingSafeEqual(actualHash, inMem.passwordHash);
    return {
      authenticated,
      tokenVersion: authenticated ? inMem.tokenVersion : 0,
      role: "owner",
      memberId: "owner-1",
      email: inMem.email,
    };
  }

  // Check in-memory team members
  const teamMap = getInMemoryTeamMap();
  for (const member of teamMap.values()) {
    if (matchesSecret(cleanEmail, member.email.toLowerCase())) {
      if (member.status !== "active") {
        return {
          authenticated: false,
          tokenVersion: 0,
          role: member.role,
          memberId: member.id,
          email: member.email,
        };
      }
      const actualHash = await derivePasswordHash(
        password,
        member.passwordSalt,
      );
      const authenticated = timingSafeEqual(actualHash, member.passwordHash);
      return {
        authenticated,
        tokenVersion: authenticated ? member.tokenVersion : 0,
        role: member.role,
        memberId: member.id,
        email: member.email,
      };
    }
  }

  return {
    authenticated: false,
    tokenVersion: 0,
    role: "viewer",
    memberId: "",
    email: cleanEmail,
  };
}

export async function verifyAdminCredentials(email: string, password: string) {
  const result = await authenticateAdminCredentials(email, password);
  return result.authenticated;
}

export async function getAdminAccountInfo(targetEmail?: string) {
  const cleanTarget = targetEmail?.trim().toLowerCase() || "";
  const pool = getPool();
  if (pool) {
    await ensureAdminTable();
    const result = await pool.query(
      `SELECT email, created_at, COALESCE(token_version, 1) AS token_version
       FROM admin_users
       WHERE id = 1`,
    );
    if (result.rowCount && result.rowCount > 0) {
      const row = result.rows[0] as {
        email: string;
        created_at: Date | string;
        token_version: number;
      };
      if (!cleanTarget || cleanTarget === row.email.trim().toLowerCase()) {
        return {
          email: row.email,
          role: "owner" as AdminRole,
          memberId: "owner-1",
          createdAt: new Date(row.created_at).toISOString(),
          tokenVersion: Number(row.token_version) || 1,
          storageMode: "PostgreSQL" as const,
        };
      }

      const memberResult = await pool.query(
        `SELECT id, email, role, status, created_at, COALESCE(token_version, 1) AS token_version
         FROM admin_team_members
         WHERE LOWER(email) = $1`,
        [cleanTarget],
      );
      if (memberResult.rowCount && memberResult.rowCount > 0) {
        const m = memberResult.rows[0] as {
          id: string;
          email: string;
          role: string;
          status: string;
          created_at: Date | string;
          token_version: number;
        };
        return {
          email: m.email,
          role: normalizeAdminRole(m.role),
          memberId: m.id,
          createdAt: new Date(m.created_at).toISOString(),
          tokenVersion: Number(m.token_version) || 1,
          storageMode: "PostgreSQL" as const,
        };
      }

      return {
        email: row.email,
        role: "owner" as AdminRole,
        memberId: "owner-1",
        createdAt: new Date(row.created_at).toISOString(),
        tokenVersion: Number(row.token_version) || 1,
        storageMode: "PostgreSQL" as const,
      };
    }
    throw new Error("Admin account is not initialized.");
  }

  const inMem = await getOrInitInMemoryAdmin();
  if (cleanTarget && cleanTarget !== inMem.email.toLowerCase()) {
    for (const member of getInMemoryTeamMap().values()) {
      if (member.email.toLowerCase() === cleanTarget) {
        return {
          email: member.email,
          role: member.role,
          memberId: member.id,
          createdAt: member.createdAt.toISOString(),
          tokenVersion: member.tokenVersion,
          storageMode: "In-Memory" as const,
        };
      }
    }
  }

  return {
    email: targetEmail || inMem.email,
    role: "owner" as AdminRole,
    memberId: "owner-1",
    createdAt: inMem.createdAt.toISOString(),
    tokenVersion: inMem.tokenVersion,
    storageMode: "In-Memory" as const,
  };
}

export async function verifyRequestAdminSession(
  cookieToken: string | undefined,
): Promise<
  | { valid: true; session: AdminSessionPayload; sessionSecret: string }
  | { valid: false; reason: "UNCONFIGURED" | "UNAUTHORIZED" | "UNAVAILABLE" }
> {
  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret) {
    return { valid: false, reason: "UNCONFIGURED" };
  }
  if (!cookieToken) {
    return { valid: false, reason: "UNAUTHORIZED" };
  }

  const session = await getAdminSessionPayload(cookieToken, sessionSecret);
  if (!session) {
    return { valid: false, reason: "UNAUTHORIZED" };
  }

  const sessionEmail = session.email.trim().toLowerCase();

  try {
    const account = await getAdminAccountInfo();
    const ownerEmailMatches = matchesSecret(
      sessionEmail,
      account.email.trim().toLowerCase(),
    );

    if (ownerEmailMatches) {
      if (session.tokenVersion !== account.tokenVersion) {
        return { valid: false, reason: "UNAUTHORIZED" };
      }
      globals.__dataStackLastVerifiedMemberId = "owner-1";
      return {
        valid: true,
        session: {
          ...session,
          role: "owner",
          memberId: "owner-1",
        },
        sessionSecret,
      };
    }

    // Check secondary team member (in PG or in-memory)
    const pool = getPool();
    if (pool) {
      const teamRes = await pool.query(
        `SELECT id, email, role, status, COALESCE(token_version, 1) AS token_version
         FROM admin_team_members
         WHERE LOWER(email) = $1`,
        [sessionEmail],
      );
      if (!teamRes.rowCount || teamRes.rowCount === 0) {
        return { valid: false, reason: "UNAUTHORIZED" };
      }
      const member = teamRes.rows[0] as {
        id: string;
        email: string;
        role: string;
        status: string;
        token_version: number;
      };
      if (
        member.status !== "active" ||
        session.tokenVersion !== (Number(member.token_version) || 1)
      ) {
        return { valid: false, reason: "UNAUTHORIZED" };
      }
      globals.__dataStackLastVerifiedMemberId = member.id;
      return {
        valid: true,
        session: {
          ...session,
          role: normalizeAdminRole(member.role),
          memberId: member.id,
        },
        sessionSecret,
      };
    }

    for (const member of getInMemoryTeamMap().values()) {
      if (matchesSecret(sessionEmail, member.email.toLowerCase())) {
        if (
          member.status !== "active" ||
          session.tokenVersion !== member.tokenVersion
        ) {
          return { valid: false, reason: "UNAUTHORIZED" };
        }
        globals.__dataStackLastVerifiedMemberId = member.id;
        return {
          valid: true,
          session: {
            ...session,
            role: member.role,
            memberId: member.id,
          },
          sessionSecret,
        };
      }
    }

    return { valid: false, reason: "UNAUTHORIZED" };
  } catch (error) {
    if (getPool()) {
      return { valid: false, reason: "UNAVAILABLE" };
    }
    void error;
    return { valid: false, reason: "UNAUTHORIZED" };
  }
}

export async function updateAdminAccount({
  currentEmail,
  currentPassword,
  nextEmail,
  nextPassword,
}: {
  currentEmail: string;
  currentPassword: string;
  nextEmail: string;
  nextPassword?: string;
}) {
  const authCheck = await authenticateAdminCredentials(
    currentEmail,
    currentPassword,
  );
  if (!authCheck.authenticated) {
    return { ok: false as const, error: "Current password is incorrect." };
  }

  const cleanEmail = nextEmail.trim().toLowerCase();
  const passwordToSave =
    nextPassword && nextPassword.length > 0 ? nextPassword : currentPassword;
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const passwordHash = await derivePasswordHash(passwordToSave, salt);

  const pool = getPool();
  if (pool) {
    await ensureAdminTable();
    if (authCheck.memberId === "owner-1") {
      const updated = await pool.query(
        `UPDATE admin_users
         SET email = $1,
             password_salt = $2,
             password_hash = $3,
             token_version = COALESCE(token_version, 1) + 1
         WHERE id = 1
         RETURNING token_version`,
        [cleanEmail, salt, passwordHash],
      );
      if (!updated.rowCount || updated.rowCount === 0) {
        return { ok: false as const, error: "Admin account not found." };
      }
      return {
        ok: true as const,
        email: cleanEmail,
        role: "owner" as AdminRole,
        memberId: "owner-1",
        tokenVersion: Number(updated.rows[0].token_version) || 1,
      };
    }

    const updatedMember = await pool.query(
      `UPDATE admin_team_members
       SET email = $1,
           password_salt = $2,
           password_hash = $3,
           token_version = COALESCE(token_version, 1) + 1,
           updated_at = NOW()
       WHERE id = $4
       RETURNING token_version, role`,
      [cleanEmail, salt, passwordHash, authCheck.memberId],
    );
    if (!updatedMember.rowCount || updatedMember.rowCount === 0) {
      return { ok: false as const, error: "Team account not found." };
    }
    return {
      ok: true as const,
      email: cleanEmail,
      role: normalizeAdminRole(updatedMember.rows[0].role),
      memberId: authCheck.memberId,
      tokenVersion: Number(updatedMember.rows[0].token_version) || 1,
    };
  }

  if (authCheck.memberId === "owner-1") {
    const existing = await getOrInitInMemoryAdmin();
    const nextVersion = existing.tokenVersion + 1;
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash,
      tokenVersion: nextVersion,
      createdAt: existing.createdAt,
    };
    return {
      ok: true as const,
      email: cleanEmail,
      role: "owner" as AdminRole,
      memberId: "owner-1",
      tokenVersion: nextVersion,
    };
  }

  const teamMap = getInMemoryTeamMap();
  const member = teamMap.get(authCheck.memberId);
  if (!member) {
    return { ok: false as const, error: "Team account not found." };
  }
  const nextVersion = member.tokenVersion + 1;
  teamMap.set(member.id, {
    ...member,
    email: cleanEmail,
    passwordSalt: salt,
    passwordHash,
    tokenVersion: nextVersion,
    updatedAt: new Date(),
  });
  return {
    ok: true as const,
    email: cleanEmail,
    role: member.role,
    memberId: member.id,
    tokenVersion: nextVersion,
  };
}

export async function revokeAdminSessions(memberId?: string): Promise<number> {
  const effectiveMemberId =
    memberId || globals.__dataStackLastVerifiedMemberId || "owner-1";
  const pool = getPool();

  if (effectiveMemberId !== "owner-1" && effectiveMemberId !== "1") {
    if (pool) {
      await ensureAdminTable();
      const updated = await pool.query(
        `UPDATE admin_team_members
         SET token_version = COALESCE(token_version, 1) + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING token_version`,
        [effectiveMemberId],
      );
      if (updated.rowCount && updated.rowCount > 0) {
        return Number(updated.rows[0].token_version) || 1;
      }
    } else {
      const teamMap = getInMemoryTeamMap();
      const member = teamMap.get(effectiveMemberId);
      if (member) {
        member.tokenVersion += 1;
        member.updatedAt = new Date();
        teamMap.set(member.id, member);
        return member.tokenVersion;
      }
    }
  }

  if (pool) {
    await ensureAdminTable();
    const updated = await pool.query(
      `UPDATE admin_users
       SET token_version = COALESCE(token_version, 1) + 1
       WHERE id = 1
       RETURNING token_version`,
    );
    if (!updated.rowCount || updated.rowCount === 0) {
      return 0;
    }
    return Number(updated.rows[0].token_version) || 1;
  }

  const existing =
    globals.__dataStackInMemoryAdmin ?? (await getOrInitInMemoryAdmin());
  existing.tokenVersion += 1;
  globals.__dataStackInMemoryAdmin = existing;
  return existing.tokenVersion;
}

function isPrimaryOwnerTargetId(id: string): boolean {
  const clean = id.trim().toLowerCase();
  return clean === "owner-1" || clean === "1" || clean === "owner";
}

function isValidEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function listAdminTeamMembersAsync(): Promise<
  AdminTeamMemberPublic[]
> {
  const pool = getPool();
  const list: AdminTeamMemberPublic[] = [];

  if (pool) {
    await ensureAdminTable();
    const ownerRes = await pool.query(
      `SELECT email, created_at, COALESCE(token_version, 1) AS token_version
       FROM admin_users
       WHERE id = 1`,
    );
    if (ownerRes.rowCount && ownerRes.rowCount > 0) {
      const o = ownerRes.rows[0] as {
        email: string;
        created_at: Date | string;
        token_version: number;
      };
      const iso = new Date(o.created_at).toISOString();
      list.push({
        id: "owner-1",
        email: o.email,
        role: "owner",
        status: "active",
        tokenVersion: Number(o.token_version) || 1,
        invitedBy: "system",
        isPrimaryOwner: true,
        createdAt: iso,
        updatedAt: iso,
      });
    }

    const teamRes = await pool.query(
      `SELECT id, email, role, status, COALESCE(token_version, 1) AS token_version, invited_by, created_at, updated_at
       FROM admin_team_members
       ORDER BY created_at ASC`,
    );
    for (const row of teamRes.rows as Array<{
      id: string;
      email: string;
      role: string;
      status: string;
      token_version: number;
      invited_by: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>) {
      list.push({
        id: row.id,
        email: row.email,
        role: normalizeAdminRole(row.role),
        status: row.status === "disabled" ? "disabled" : "active",
        tokenVersion: Number(row.token_version) || 1,
        invitedBy: row.invited_by || "owner",
        isPrimaryOwner: false,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    return list;
  }

  const inMemOwner = await getOrInitInMemoryAdmin();
  const ownerIso = inMemOwner.createdAt.toISOString();
  list.push({
    id: "owner-1",
    email: inMemOwner.email,
    role: "owner",
    status: "active",
    tokenVersion: inMemOwner.tokenVersion,
    invitedBy: "system",
    isPrimaryOwner: true,
    createdAt: ownerIso,
    updatedAt: ownerIso,
  });

  for (const member of getInMemoryTeamMap().values()) {
    list.push({
      id: member.id,
      email: member.email,
      role: member.role,
      status: member.status,
      tokenVersion: member.tokenVersion,
      invitedBy: member.invitedBy,
      isPrimaryOwner: false,
      createdAt: member.createdAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
    });
  }

  return list;
}

export async function createAdminTeamMemberAsync(input: {
  email: string;
  password: string;
  role: string;
  invitedBy?: string;
}): Promise<AdminTeamMemberPublic> {
  const cleanEmail = (input.email || "").trim().toLowerCase();
  if (!isValidEmailFormat(cleanEmail)) {
    throw new TeamMemberValidationError(
      "Enter a valid email address for the team member.",
      "INVALID_EMAIL",
    );
  }

  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < 8 || password.length > 256) {
    throw new TeamMemberValidationError(
      "Password must be between 8 and 256 characters.",
      "INVALID_PASSWORD",
    );
  }

  const rawRole = (input.role || "").trim().toLowerCase();
  if (
    rawRole !== "owner" &&
    rawRole !== "admin" &&
    rawRole !== "operator" &&
    rawRole !== "viewer"
  ) {
    throw new TeamMemberValidationError(
      "Role must be one of: owner, admin, operator, viewer.",
      "INVALID_ROLE",
    );
  }
  const role = normalizeAdminRole(rawRole);
  const invitedBy = (input.invitedBy || "owner").trim().toLowerCase();
  const memberId = `adm_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const passwordHash = await derivePasswordHash(password, salt);
  const now = new Date();

  const pool = getPool();
  if (pool) {
    await ensureAdminTable();
    const ownerCheck = await pool.query(
      `SELECT 1 FROM admin_users WHERE LOWER(email) = $1`,
      [cleanEmail],
    );
    if (ownerCheck.rowCount && ownerCheck.rowCount > 0) {
      throw new TeamMemberValidationError(
        `An administrator with email '${cleanEmail}' already exists.`,
        "TEAM_MEMBER_EXISTS",
      );
    }

    const dupCheck = await pool.query(
      `SELECT 1 FROM admin_team_members WHERE LOWER(email) = $1`,
      [cleanEmail],
    );
    if (dupCheck.rowCount && dupCheck.rowCount > 0) {
      throw new TeamMemberValidationError(
        `An administrator with email '${cleanEmail}' already exists.`,
        "TEAM_MEMBER_EXISTS",
      );
    }

    await pool.query(
      `INSERT INTO admin_team_members (
         id, email, role, status, password_salt, password_hash, token_version, invited_by, created_at, updated_at
       )
       VALUES ($1, $2, $3, 'active', $4, $5, 1, $6, $7::timestamptz, $7::timestamptz)`,
      [
        memberId,
        cleanEmail,
        role,
        salt,
        passwordHash,
        invitedBy,
        now.toISOString(),
      ],
    );

    return {
      id: memberId,
      email: cleanEmail,
      role,
      status: "active",
      tokenVersion: 1,
      invitedBy,
      isPrimaryOwner: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  const inMemOwner = await getOrInitInMemoryAdmin();
  if (inMemOwner.email.toLowerCase() === cleanEmail) {
    throw new TeamMemberValidationError(
      `An administrator with email '${cleanEmail}' already exists.`,
      "TEAM_MEMBER_EXISTS",
    );
  }
  const teamMap = getInMemoryTeamMap();
  for (const existing of teamMap.values()) {
    if (existing.email.toLowerCase() === cleanEmail) {
      throw new TeamMemberValidationError(
        `An administrator with email '${cleanEmail}' already exists.`,
        "TEAM_MEMBER_EXISTS",
      );
    }
  }

  const record: InMemoryTeamMember = {
    id: memberId,
    email: cleanEmail,
    role,
    status: "active",
    passwordSalt: salt,
    passwordHash,
    tokenVersion: 1,
    invitedBy,
    createdAt: now,
    updatedAt: now,
  };
  teamMap.set(memberId, record);

  return {
    id: memberId,
    email: cleanEmail,
    role,
    status: "active",
    tokenVersion: 1,
    invitedBy,
    isPrimaryOwner: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function updateAdminTeamMemberAsync(
  id: string,
  input: {
    role?: string;
    status?: string;
    password?: string;
    revokeSessions?: boolean;
  },
): Promise<AdminTeamMemberPublic> {
  if (isPrimaryOwnerTargetId(id)) {
    throw new PrimaryOwnerProtectedError();
  }

  let nextRole: AdminRole | undefined;
  if (input.role !== undefined) {
    const rawRole = String(input.role).trim().toLowerCase();
    if (
      rawRole !== "owner" &&
      rawRole !== "admin" &&
      rawRole !== "operator" &&
      rawRole !== "viewer"
    ) {
      throw new TeamMemberValidationError(
        "Role must be one of: owner, admin, operator, viewer.",
        "INVALID_ROLE",
      );
    }
    nextRole = normalizeAdminRole(rawRole);
  }

  let nextStatus: "active" | "disabled" | undefined;
  if (input.status !== undefined) {
    const rawStatus = String(input.status).trim().toLowerCase();
    if (rawStatus !== "active" && rawStatus !== "disabled") {
      throw new TeamMemberValidationError(
        "Status must be 'active' or 'disabled'.",
        "INVALID_STATUS",
      );
    }
    nextStatus = rawStatus;
  }

  let nextSalt: Buffer | undefined;
  let nextHash: Buffer | undefined;
  if (input.password !== undefined && input.password !== "") {
    if (
      typeof input.password !== "string" ||
      input.password.length < 8 ||
      input.password.length > 256
    ) {
      throw new TeamMemberValidationError(
        "Password must be between 8 and 256 characters.",
        "INVALID_PASSWORD",
      );
    }
    nextSalt = randomBytes(PASSWORD_SALT_BYTES);
    nextHash = await derivePasswordHash(input.password, nextSalt);
  }

  const pool = getPool();
  if (pool) {
    await ensureAdminTable();
    const ownerRes = await pool.query(
      `SELECT email FROM admin_users WHERE id = 1`,
    );
    if (
      ownerRes.rowCount &&
      ownerRes.rowCount > 0 &&
      id.trim().toLowerCase() ===
        String(ownerRes.rows[0].email).trim().toLowerCase()
    ) {
      throw new PrimaryOwnerProtectedError();
    }

    const existingRes = await pool.query(
      `SELECT id, email, role, status, COALESCE(token_version, 1) AS token_version, invited_by, created_at
       FROM admin_team_members
       WHERE id = $1`,
      [id],
    );
    if (!existingRes.rowCount || existingRes.rowCount === 0) {
      throw new TeamMemberValidationError(
        `Team member '${id}' not found.`,
        "TEAM_MEMBER_NOT_FOUND",
      );
    }
    const existing = existingRes.rows[0] as {
      id: string;
      email: string;
      role: string;
      status: string;
      token_version: number;
      invited_by: string;
      created_at: Date | string;
    };

    const finalRole = nextRole ?? normalizeAdminRole(existing.role);
    const finalStatus =
      nextStatus ?? (existing.status === "disabled" ? "disabled" : "active");
    const nextTokenVersion = (Number(existing.token_version) || 1) + 1;

    if (nextSalt && nextHash) {
      await pool.query(
        `UPDATE admin_team_members
         SET role = $1,
             status = $2,
             password_salt = $3,
             password_hash = $4,
             token_version = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [finalRole, finalStatus, nextSalt, nextHash, nextTokenVersion, id],
      );
    } else {
      await pool.query(
        `UPDATE admin_team_members
         SET role = $1,
             status = $2,
             token_version = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [finalRole, finalStatus, nextTokenVersion, id],
      );
    }

    return {
      id: existing.id,
      email: existing.email,
      role: finalRole,
      status: finalStatus,
      tokenVersion: nextTokenVersion,
      invitedBy: existing.invited_by || "owner",
      isPrimaryOwner: false,
      createdAt: new Date(existing.created_at).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const inMemOwner = await getOrInitInMemoryAdmin();
  if (id.trim().toLowerCase() === inMemOwner.email.toLowerCase()) {
    throw new PrimaryOwnerProtectedError();
  }

  const teamMap = getInMemoryTeamMap();
  const existing = teamMap.get(id);
  if (!existing) {
    throw new TeamMemberValidationError(
      `Team member '${id}' not found.`,
      "TEAM_MEMBER_NOT_FOUND",
    );
  }

  const updated: InMemoryTeamMember = {
    ...existing,
    role: nextRole ?? existing.role,
    status: nextStatus ?? existing.status,
    passwordSalt: nextSalt ?? existing.passwordSalt,
    passwordHash: nextHash ?? existing.passwordHash,
    tokenVersion: existing.tokenVersion + 1,
    updatedAt: new Date(),
  };
  teamMap.set(id, updated);

  return {
    id: updated.id,
    email: updated.email,
    role: updated.role,
    status: updated.status,
    tokenVersion: updated.tokenVersion,
    invitedBy: updated.invitedBy,
    isPrimaryOwner: false,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

export async function deleteAdminTeamMemberAsync(
  id: string,
): Promise<{ id: string; email: string }> {
  if (isPrimaryOwnerTargetId(id)) {
    throw new PrimaryOwnerProtectedError();
  }

  const pool = getPool();
  if (pool) {
    await ensureAdminTable();
    const ownerRes = await pool.query(
      `SELECT email FROM admin_users WHERE id = 1`,
    );
    if (
      ownerRes.rowCount &&
      ownerRes.rowCount > 0 &&
      id.trim().toLowerCase() ===
        String(ownerRes.rows[0].email).trim().toLowerCase()
    ) {
      throw new PrimaryOwnerProtectedError();
    }

    const delRes = await pool.query(
      `DELETE FROM admin_team_members WHERE id = $1 RETURNING id, email`,
      [id],
    );
    if (!delRes.rowCount || delRes.rowCount === 0) {
      throw new TeamMemberValidationError(
        `Team member '${id}' not found.`,
        "TEAM_MEMBER_NOT_FOUND",
      );
    }
    return {
      id: String(delRes.rows[0].id),
      email: String(delRes.rows[0].email),
    };
  }

  const inMemOwner = await getOrInitInMemoryAdmin();
  if (id.trim().toLowerCase() === inMemOwner.email.toLowerCase()) {
    throw new PrimaryOwnerProtectedError();
  }

  const teamMap = getInMemoryTeamMap();
  const existing = teamMap.get(id);
  if (!existing) {
    throw new TeamMemberValidationError(
      `Team member '${id}' not found.`,
      "TEAM_MEMBER_NOT_FOUND",
    );
  }
  teamMap.delete(id);
  return { id: existing.id, email: existing.email };
}

export function resetAdminStateForTests() {
  globals.__dataStackInMemoryAdmin = undefined;
  globals.__dataStackInMemoryTeamMembers?.clear();
  globals.__dataStackLastVerifiedMemberId = undefined;
  localLoginThrottle.clear();
  lastLocalThrottleCleanup = 0;
  clearAuditLogsForTests();
}
