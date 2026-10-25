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

type AdminDatabaseGlobals = typeof globalThis & {
  __dataStackAdminPool?: Pool;
  __dataStackAdminSchema?: Promise<void>;
};

const globals = globalThis as AdminDatabaseGlobals;
const localLoginThrottle = new Map<string, LoginThrottleEntry>();
let lastLocalThrottleCleanup = 0;
let lastDatabaseThrottleCleanup = 0;

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  globals.__dataStackAdminPool ??= new Pool({
    connectionString,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    max: 5,
  });

  return globals.__dataStackAdminPool;
}

async function ensureAdminTable() {
  globals.__dataStackAdminSchema ??= Promise.all([
    getPool().query(
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
    getPool().query(
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
  await ensureAdminTable();
  const client = await getPool().connect();

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

export async function consumeAdminLoginAttempt(
  email: string,
  secret: string,
): Promise<LoginThrottleDecision> {
  const keyHashes = createLoginThrottleKeys(email, secret);
  const now = Date.now();

  if (!process.env.DATABASE_URL) {
    return consumeLocalLoginAttempt(keyHashes, now);
  }

  return consumeDatabaseLoginAttempt(keyHashes, now);
}

export async function clearAdminLoginAttempts(email: string, secret: string) {
  const keyHashes = createLoginThrottleKeys(email, secret);

  if (!process.env.DATABASE_URL) {
    keyHashes.forEach((keyHash) => localLoginThrottle.delete(keyHash));
    return;
  }

  await ensureAdminTable();
  const client = await getPool().connect();
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
  const expected = process.env.DATASTACK_ADMIN_SETUP_KEY;
  if (!expected || expected.length < 32) return false;
  return matchesSecret(candidate, expected);
}

export async function isAdminSetupComplete() {
  await ensureAdminTable();
  const result = await getPool().query(
    "SELECT 1 FROM admin_users WHERE id = 1",
  );
  return result.rowCount === 1;
}

export async function createInitialAdmin(email: string, password: string) {
  await ensureAdminTable();
  const client = await getPool().connect();

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

    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const passwordHash = await derivePasswordHash(password, salt);
    await client.query(
      `INSERT INTO admin_users (id, email, password_salt, password_hash)
       VALUES (1, $1, $2, $3)`,
      [email, salt, passwordHash],
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

export async function verifyAdminCredentials(email: string, password: string) {
  await ensureAdminTable();
  const result = await getPool().query(
    `SELECT email, password_salt, password_hash
     FROM admin_users
     WHERE email = $1`,
    [email],
  );
  const admin = result.rows[0] as
    | { email: string; password_salt: Buffer; password_hash: Buffer }
    | undefined;
  const salt = admin?.password_salt ?? Buffer.alloc(PASSWORD_SALT_BYTES);
  const expectedHash =
    admin?.password_hash ?? Buffer.alloc(PASSWORD_HASH_BYTES);
  const actualHash = await derivePasswordHash(password, salt);
  const passwordMatches = timingSafeEqual(actualHash, expectedHash);

  return Boolean(admin && passwordMatches);
}
