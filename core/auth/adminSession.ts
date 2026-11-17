const encoder = new TextEncoder();

const DEV_DEFAULT_SESSION_SECRET =
  "datastack-admin-session-default-secret-32-chars";

export interface AdminSessionPayload {
  email: string;
  expiresAt: number;
  tokenVersion: number;
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
) {
  const safeVersion =
    Number.isInteger(tokenVersion) && tokenVersion >= 1 ? tokenVersion : 1;
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({ email, expiresAt, tokenVersion: safeVersion }),
    ),
  );
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
      return session;
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
  const originHeader = request.headers.get("origin")?.toLowerCase() ?? "";
  const isHttps =
    forwardedProto === "https" ||
    originHeader.startsWith("https://") ||
    request.url.startsWith("https://");

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
