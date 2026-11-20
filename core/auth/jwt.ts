import jwt from "jsonwebtoken";

export interface ClientTokenPayload {
  clientId: string;
  name?: string;
  rateLimit?: number;
  iat?: number;
  exp?: number;
}

const DEV_DEFAULT_JWT_SECRET =
  "datastack-jwt-default-secret-key-32-chars-long";

export function resolveDefaultJwtSecret(): string {
  const configured = process.env.DATASTACK_JWT_SECRET?.trim() || "";
  if (process.env.NODE_ENV === "production") {
    return configured.length >= 32 ? configured : "";
  }
  if (configured.length > 0) {
    return configured.length >= 32 ? configured : "";
  }
  return DEV_DEFAULT_JWT_SECRET;
}

export class AuthService {
  private static secret: string = resolveDefaultJwtSecret();

  public static setSecret(newSecret: string) {
    const trimmed = newSecret ? newSecret.trim() : "";
    if (trimmed.length >= 32) {
      this.secret = trimmed;
    } else if (process.env.NODE_ENV !== "production" && trimmed.length > 0) {
      this.secret = trimmed;
    } else if (process.env.NODE_ENV === "production") {
      this.secret = "";
    }
  }

  public static getSecret(): string {
    return this.secret;
  }

  public static isConfigured(): boolean {
    const minLen = process.env.NODE_ENV === "production" ? 32 : 1;
    return this.secret.length >= minLen;
  }

  /**
   * Generates a signed JWT for client SDK authentication.
   * When `expiresIn` is null/omitted, no hardcoded JWT `exp` claim is embedded so
   * database-backed `client_sdks.expires_at` (including "Never expires" or >30d
   * policies and live expiry extensions) remains the authoritative expiry check.
   */
  public static generateClientToken(
    payload: { clientId: string; name?: string; rateLimit?: number },
    expiresIn?: string | number | null,
  ): string {
    if (!this.isConfigured()) {
      throw new Error(
        "DATASTACK_JWT_SECRET (>= 32 characters) must be configured before generating client tokens.",
      );
    }

    const tokenBody = {
      clientId: payload.clientId,
      name: payload.name || payload.clientId,
      rateLimit: payload.rateLimit || 100,
    };

    if (expiresIn !== undefined && expiresIn !== null && expiresIn !== "") {
      return jwt.sign(tokenBody, this.secret, {
        expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
      });
    }

    return jwt.sign(tokenBody, this.secret);
  }

  /**
   * Verifies and decodes incoming token from Socket.IO handshake or HTTP ingestion.
   */
  public static verifyClientToken(token: string): {
    valid: boolean;
    payload?: ClientTokenPayload;
    error?: string;
  } {
    if (!this.isConfigured()) {
      return {
        valid: false,
        error: "DATASTACK_JWT_SECRET (>= 32 characters) is not configured.",
      };
    }

    try {
      const cleanToken = token.startsWith("Bearer ")
        ? token.slice(7).trim()
        : token.trim();
      const decoded = jwt.verify(cleanToken, this.secret) as ClientTokenPayload;
      return { valid: true, payload: decoded };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid token";
      return { valid: false, error: message };
    }
  }
}

export default AuthService;
