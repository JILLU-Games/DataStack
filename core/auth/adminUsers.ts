import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type AdminSessionPayload,
  getAdminSessionPayload,
  getAdminSessionSecret,
} from "./adminSession";
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

type AdminDatabaseGlobals = typeof globalThis & {
  __dataStackAdminSchema?: Promise<void>;
  __dataStackInMemoryAdmin?: InMemoryAdmin;
};

const globals = globalThis as AdminDatabaseGlobals;
const localLoginThrottle = new Map<string, LoginThrottleEntry>();
let lastLocalThrottleCleanup = 0;
let lastDatabaseThrottleCleanup = 0;

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
      Math.max(latest, localLoginThrottle.get(bucket.keyHash)?.blockedUntil ?? 0),
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
): Promise<{ authenticated: boolean; tokenVersion: number }> {
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
      return { authenticated: false, tokenVersion: 0 };
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
    const actualHash = await derivePasswordHash(password, admin.password_salt);
    const passwordMatches = timingSafeEqual(actualHash, admin.password_hash);
    return {
      authenticated: emailMatches && passwordMatches,
      tokenVersion: Number(admin.token_version) || 1,
    };
  }

  const inMem = await getOrInitInMemoryAdmin();
  if (!matchesSecret(cleanEmail, inMem.email)) {
    return { authenticated: false, tokenVersion: 0 };
  }
  const actualHash = await derivePasswordHash(password, inMem.passwordSalt);
  const authenticated = timingSafeEqual(actualHash, inMem.passwordHash);
  return {
    authenticated,
    tokenVersion: authenticated ? inMem.tokenVersion : 0,
  };
}

export async function verifyAdminCredentials(email: string, password: string) {
  const result = await authenticateAdminCredentials(email, password);
  return result.authenticated;
}

export async function getAdminAccountInfo(fallbackEmail?: string) {
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
      return {
        email: row.email,
        createdAt: new Date(row.created_at).toISOString(),
        tokenVersion: Number(row.token_version) || 1,
        storageMode: "PostgreSQL" as const,
      };
    }
    throw new Error("Admin account is not initialized.");
  }

  const inMem = await getOrInitInMemoryAdmin();
  return {
    email: fallbackEmail || inMem.email,
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

  try {
    const account = await getAdminAccountInfo();
    const emailMatches = matchesSecret(
      session.email.trim().toLowerCase(),
      account.email.trim().toLowerCase(),
    );
    if (!emailMatches || session.tokenVersion !== account.tokenVersion) {
      return { valid: false, reason: "UNAUTHORIZED" };
    }
    return { valid: true, session, sessionSecret };
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
  const verified = await verifyAdminCredentials(currentEmail, currentPassword);
  if (!verified) {
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
      tokenVersion: Number(updated.rows[0].token_version) || 1,
    };
  }

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
  return { ok: true as const, email: cleanEmail, tokenVersion: nextVersion };
}

export async function revokeAdminSessions(): Promise<number> {
  const pool = getPool();
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

  const existing = globals.__dataStackInMemoryAdmin ?? (await getOrInitInMemoryAdmin());
  existing.tokenVersion += 1;
  globals.__dataStackInMemoryAdmin = existing;
  return existing.tokenVersion;
}

export function resetAdminStateForTests() {
  globals.__dataStackInMemoryAdmin = undefined;
  localLoginThrottle.clear();
  lastLocalThrottleCleanup = 0;
}
