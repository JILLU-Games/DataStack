import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { Pool } from "pg";

const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const DATABASE_LOCK_ID = "72025102501";

type AdminDatabaseGlobals = typeof globalThis & {
  __dataStackAdminPool?: Pool;
  __dataStackAdminSchema?: Promise<void>;
};

const globals = globalThis as AdminDatabaseGlobals;

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
  globals.__dataStackAdminSchema ??= getPool()
    .query(
      `
      CREATE TABLE IF NOT EXISTS admin_users (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        email TEXT NOT NULL UNIQUE,
        password_salt BYTEA NOT NULL,
        password_hash BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    )
    .then(() => undefined);

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
