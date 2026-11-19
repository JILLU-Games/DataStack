import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const DEV_DEFAULT_SESSION_SECRET =
  "datastack-admin-session-default-secret-32-chars";
const VAULT_PREFIX = "v1";
const HKDF_SALT = Buffer.from("datastack-vault-salt-v1", "utf8");
const HKDF_INFO = Buffer.from("datastack-aes-256-gcm-v1", "utf8");

export type SecretVaultErrorCode =
  | "SECRET_VAULT_KEY_UNAVAILABLE"
  | "SECRET_VAULT_DECRYPT_FAILED"
  | "SECRET_VAULT_INVALID_INPUT";

export class SecretVaultError extends Error {
  public readonly code: SecretVaultErrorCode;

  constructor(code: SecretVaultErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SecretVaultError";
    this.code = code;
  }
}

export function resolveVaultMasterSecret(secretOverride?: string): string | null {
  const candidate = (
    secretOverride ??
    process.env.DATASTACK_ADMIN_SESSION_SECRET ??
    ""
  ).trim();
  if (process.env.NODE_ENV === "production") {
    return candidate.length >= 32 ? candidate : null;
  }
  if (candidate.length > 0) {
    return candidate.length >= 32 ? candidate : null;
  }
  return DEV_DEFAULT_SESSION_SECRET;
}

function deriveAesKey(secretOverride?: string): Buffer {
  const master = resolveVaultMasterSecret(secretOverride);
  if (!master) {
    throw new SecretVaultError(
      "SECRET_VAULT_KEY_UNAVAILABLE",
      "DATASTACK_ADMIN_SESSION_SECRET (>= 32 characters) is required to encrypt or decrypt stored secrets.",
    );
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(master, "utf8"),
    HKDF_SALT,
    HKDF_INFO,
    32,
  );
  return Buffer.from(derived);
}

export function encryptSecret(
  plaintext: string,
  secretOverride?: string,
): string {
  if (typeof plaintext !== "string") {
    throw new SecretVaultError(
      "SECRET_VAULT_INVALID_INPUT",
      "Secret value must be a string.",
    );
  }
  if (!plaintext) {
    return "";
  }
  const key = deriveAesKey(secretOverride);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VAULT_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptSecret(
  ciphertext: string,
  secretOverride?: string,
): string {
  if (!ciphertext || typeof ciphertext !== "string") {
    return "";
  }
  const parts = ciphertext.trim().split(":");
  if (parts.length !== 4 || parts[0] !== VAULT_PREFIX) {
    throw new SecretVaultError(
      "SECRET_VAULT_DECRYPT_FAILED",
      "Stored secret ciphertext has an unrecognized format.",
    );
  }

  const key = deriveAesKey(secretOverride);
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const payload = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error("Invalid IV or auth tag length");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(payload),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (err: unknown) {
    if (err instanceof SecretVaultError) {
      throw err;
    }
    throw new SecretVaultError(
      "SECRET_VAULT_DECRYPT_FAILED",
      "Unable to decrypt stored secret. Verify DATASTACK_ADMIN_SESSION_SECRET matches the key used to encrypt it.",
    );
  }
}

export function maskSecretHint(plaintext: string): string {
  const trimmed = String(plaintext || "").trim();
  if (!trimmed) return "";
  if (trimmed.length >= 8) {
    return `••••${trimmed.slice(-4)}`;
  }
  return "••••••••";
}

export function getMaskedHintFromEncrypted(
  ciphertext: string,
  secretOverride?: string,
): string {
  if (!ciphertext || !ciphertext.trim()) return "";
  try {
    const plain = decryptSecret(ciphertext, secretOverride);
    return maskSecretHint(plain);
  } catch {
    return "••••(locked)";
  }
}
