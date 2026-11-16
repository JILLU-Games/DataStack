import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { Pool, type PoolClient } from "pg";

const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const DATABASE_LOCK_ID = "72025102501";
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOCAL_THROTTLE_MAX_ENTRIES = 5000;
const LOCAL_THROTTLE_CLEANUP_MS = 60 * 1000;

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

interface InMemoryAdmin {
  id: number;
  email: string;
  passwordSalt: Buffer;
  passwordHash: Buffer;
  createdAt: Date;
}

type AdminDatabaseGlobals = typeof globalThis & {
  __dataStackAdminPool?: Pool | null;
  __dataStackAdminSchema?: Promise<void>;
  __dataStackInMemoryAdmin?: InMemoryAdmin;
};

const globals = globalThis as AdminDatabaseGlobals;
const localLoginThrottle = new Map<string, LoginThrottleEntry>();
let lastLocalThrottleCleanup = 0;
let lastDatabaseThrottleCleanup = 0;

function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  if (globals.__dataStackAdminPool === undefined) {
    try {
      globals.__dataStackAdminPool = new Pool({
        connectionString,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 30000,
        max: 5,
      });
    } catch {
      globals.__dataStackAdminPool = null;
    }
  }

  return globals.__dataStackAdminPool ?? null;
}

async function ensureAdminTable() {
  const pool = getPool();
  if (!pool) return;

  globals.__dataStackAdminSchema ??= Promise.all([
    pool.query(
      `
      CREATE TABLE IF NOT EXISTS admin_users (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        email TEXT NOT NULL UNIQUE,
        password_salt BYTEA NOT NULL,
        password_hash BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    ),
    pool.query(
      `
      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        key_hash TEXT PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL,
        failed_attempts INTEGER NOT NULL,
        blocked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    ),
  ]).then(() => undefined);

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

function createLoginThrottleKeys(email: string, secret: string) {
  return [createHmac("sha256", secret).update(`email:${email}`).digest("hex")];
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
  keyHashes: string[],
  now: number,
): LoginThrottleDecision {
  cleanupLocalLoginThrottle(now);

  const blockedUntil = keyHashes.reduce(
    (latest, keyHash) =>
      Math.max(latest, localLoginThrottle.get(keyHash)?.blockedUntil ?? 0),
    0,
  );
  if (blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }

  for (const keyHash of keyHashes) {
    const previous = localLoginThrottle.get(keyHash);
    const windowExpired =
      !previous || now - previous.windowStartedAt >= LOGIN_WINDOW_MS;
    const failedAttempts = windowExpired ? 1 : previous.failedAttempts + 1;
    localLoginThrottle.set(keyHash, {
      windowStartedAt: windowExpired ? now : previous.windowStartedAt,
      failedAttempts,
      blockedUntil:
        failedAttempts >= LOGIN_ATTEMPT_LIMIT ? now + LOGIN_BLOCK_MS : 0,
      updatedAt: now,
    });
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

async function consumeDatabaseLoginAttempt(
  keyHashes: string[],
  now: number,
): Promise<LoginThrottleDecision> {
  const pool = getPool();
  if (!pool) return consumeLocalLoginAttempt(keyHashes, now);
  await ensureAdminTable();
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

    for (const keyHash of keyHashes) {
      const previous = entries.get(keyHash);
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
        failedAttempts >= LOGIN_ATTEMPT_LIMIT
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
        [keyHash, nextWindowStartedAt, failedAttempts, nextBlockedUntil],
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
    const defaultEmail = (
      process.env.DATASTACK_ADMIN_EMAIL || "admin@datastack.dev"
    )
      .trim()
      .toLowerCase();
    const defaultPassword =
      process.env.DATASTACK_ADMIN_PASSWORD || "admin12345678";
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const hash = await derivePasswordHash(defaultPassword, salt);
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: defaultEmail,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date(),
    };
  }
  return globals.__dataStackInMemoryAdmin;
}

export async function consumeAdminLoginAttempt(
  email: string,
  secret: string,
): Promise<LoginThrottleDecision> {
  const keyHashes = createLoginThrottleKeys(email, secret);
  const now = Date.now();

  const pool = getPool();
  if (!pool) {
    return consumeLocalLoginAttempt(keyHashes, now);
  }

  try {
    return await consumeDatabaseLoginAttempt(keyHashes, now);
  } catch {
    return consumeLocalLoginAttempt(keyHashes, now);
  }
}

export async function clearAdminLoginAttempts(email: string, secret: string) {
  const keyHashes = createLoginThrottleKeys(email, secret);

  const pool = getPool();
  if (!pool) {
    keyHashes.forEach((keyHash) => localLoginThrottle.delete(keyHash));
    return;
  }

  try {
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
  } catch {
    keyHashes.forEach((keyHash) => localLoginThrottle.delete(keyHash));
  }
}

export function verifyAdminSetupKey(candidate: string) {
  const expected =
    process.env.DATASTACK_ADMIN_SETUP_KEY ||
    "datastack-default-setup-key-32-chars";
  if (!expected || expected.length < 32) return false;
  return matchesSecret(candidate, expected);
}

export async function isAdminSetupComplete() {
  const pool = getPool();
  if (!pool) {
    return true;
  }
  try {
    await ensureAdminTable();
    const result = await pool.query(
      "SELECT 1 FROM admin_users WHERE id = 1",
    );
    return result.rowCount === 1;
  } catch {
    return true;
  }
}

export async function createInitialAdmin(email: string, password: string) {
  const cleanEmail = email.trim().toLowerCase();
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const passwordHash = await derivePasswordHash(password, salt);
  const pool = getPool();

  if (!pool) {
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash,
      createdAt: new Date(),
    };
    return true;
  }

  try {
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
        `INSERT INTO admin_users (id, email, password_salt, password_hash)
         VALUES (1, $1, $2, $3)`,
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
  } catch {
    globals.__dataStackInMemoryAdmin = {
      id: 1,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash,
      createdAt: new Date(),
    };
    return true;
  }
}

export async function verifyAdminCredentials(email: string, password: string) {
  const cleanEmail = email.trim().toLowerCase();
  const pool = getPool();

  if (pool) {
    try {
      await ensureAdminTable();
      const result = await pool.query(
        `SELECT email, password_salt, password_hash
         FROM admin_users
         WHERE email = $1`,
        [cleanEmail],
      );
      if (result.rowCount && result.rowCount > 0) {
        const admin = result.rows[0] as
          | { email: string; password_salt: Buffer; password_hash: Buffer }
          | undefined;
        const salt = admin?.password_salt ?? Buffer.alloc(PASSWORD_SALT_BYTES);
        const expectedHash =
          admin?.password_hash ?? Buffer.alloc(PASSWORD_HASH_BYTES);
        const actualHash = await derivePasswordHash(password, salt);
        return Boolean(admin && timingSafeEqual(actualHash, expectedHash));
      }
    } catch {
      // Database connection error, fall back to in-memory admin
    }
  }

  const inMem = await getOrInitInMemoryAdmin();
  if (!matchesSecret(cleanEmail, inMem.email)) {
    return false;
  }
  const actualHash = await derivePasswordHash(password, inMem.passwordSalt);
  return timingSafeEqual(actualHash, inMem.passwordHash);
}

export async function getAdminAccountInfo(fallbackEmail?: string) {
  const pool = getPool();
  if (pool) {
    try {
      await ensureAdminTable();
      const result = await pool.query(
        `SELECT email, created_at FROM admin_users WHERE id = 1`,
      );
      if (result.rowCount && result.rowCount > 0) {
        const row = result.rows[0] as { email: string; created_at: Date | string };
        return {
          email: row.email,
          createdAt: new Date(row.created_at).toISOString(),
          storageMode: "PostgreSQL" as const,
        };
      }
    } catch {
      // Fall back to in-memory admin
    }
  }

  const inMem = await getOrInitInMemoryAdmin();
  return {
    email: fallbackEmail || inMem.email,
    createdAt: inMem.createdAt.toISOString(),
    storageMode: "In-Memory" as const,
  };
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
    try {
      await ensureAdminTable();
      const updated = await pool.query(
        `UPDATE admin_users
         SET email = $1, password_salt = $2, password_hash = $3
         WHERE id = 1`,
        [cleanEmail, salt, passwordHash],
      );
      if (updated.rowCount && updated.rowCount > 0) {
        return { ok: true as const, email: cleanEmail };
      }
    } catch {
      // Fall back to in-memory update
    }
  }

  const existing = await getOrInitInMemoryAdmin();
  globals.__dataStackInMemoryAdmin = {
    id: 1,
    email: cleanEmail,
    passwordSalt: salt,
    passwordHash,
    createdAt: existing.createdAt,
  };
  return { ok: true as const, email: cleanEmail };
}
