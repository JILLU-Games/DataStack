const encoder = new TextEncoder();

const DEV_DEFAULT_SESSION_SECRET =
  "datastack-admin-session-default-secret-32-chars";

export type AdminRole = "owner" | "admin" | "operator" | "viewer";

export interface AdminSessionPayload {
  email: string;
  expiresAt: number;
  tokenVersion: number;
  role?: AdminRole;
  memberId?: string;
}

export function normalizeAdminRole(
  raw: unknown,
  fallback: AdminRole = "viewer",
): AdminRole {
  if (typeof raw !== "string") return fallback;
  const clean = raw.trim().toLowerCase();
  if (clean === "owner") return "owner";
  if (clean === "admin") return "admin";
  if (clean === "operator") return "operator";
  if (clean === "viewer") return "viewer";
  return fallback;
}

export function getAdminRoleRank(role?: string): number {
  const normalized = normalizeAdminRole(role, "owner");
  if (normalized === "owner") return 3;
  if (normalized === "admin" || normalized === "operator") return 2;
  return 1;
}

export function formatAdminRoleLabel(role?: string): string {
  const normalized = normalizeAdminRole(role, "owner");
  if (normalized === "owner") return "Owner";
  if (normalized === "admin") return "Admin";
  if (normalized === "operator") return "Operator";
  return "Viewer";
}

export function getAdminSessionSecret(): string | null {
  const configured = process.env.DATASTACK_ADMIN_SESSION_SECRET?.trim() || "";
  if (process.env.NODE_ENV === "production") {
    return configured.length >= 32 ? configured : null;
  }
  if (configured.length > 0) {
    return configured.length >= 32 ? configured : null;
  }
  return DEV_DEFAULT_SESSION_SECRET;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createAdminSessionToken(
  email: string,
  secret: string,
  expiresAt: number,
  tokenVersion = 1,
  role?: AdminRole,
  memberId?: string,
) {
  const safeVersion =
    Number.isInteger(tokenVersion) && tokenVersion >= 1 ? tokenVersion : 1;
  const payloadObj: AdminSessionPayload = {
    email,
    expiresAt,
    tokenVersion: safeVersion,
    ...(role ? { role: normalizeAdminRole(role, "owner") } : {}),
    ...(memberId ? { memberId } : {}),
  };
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(payloadObj)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function getAdminSessionPayload(
  token: string,
  secret: string,
): Promise<AdminSessionPayload | null> {
  if (!secret || secret.length < 32) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;

    const session = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as AdminSessionPayload;
    if (
      typeof session.email === "string" &&
      typeof session.expiresAt === "number" &&
      session.expiresAt > Date.now() &&
      typeof session.tokenVersion === "number" &&
      Number.isInteger(session.tokenVersion) &&
      session.tokenVersion >= 1
    ) {
      return {
        ...session,
        ...(session.role
          ? { role: normalizeAdminRole(session.role, "owner") }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyAdminSessionToken(token: string, secret: string) {
  const session = await getAdminSessionPayload(token, secret);
  return Boolean(session);
}

export function getSessionCookieOptions(request: Request, maxAge: number) {
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const isHttps =
    forwardedProto === "https" || request.url.startsWith("https://");

  if (isHttps) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      partitioned: true,
      path: "/",
      maxAge,
    };
  }

  return {
    httpOnly: true,
    secure: false,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
