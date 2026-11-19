import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { NextRequest, NextResponse } from "next/server";

export const ADMIN_SESSION_COOKIE = "datastack_admin_session";

export async function requireAdminApiSession(req: NextRequest) {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  const auth = await verifyRequestAdminSession(token);
  if (auth.valid) {
    return { valid: true as const, auth };
  }

  return {
    valid: false as const,
    response: NextResponse.json(
      {
        error:
          auth.reason === "UNAUTHORIZED"
            ? "Authentication required."
            : "Admin authentication is temporarily unavailable.",
      },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    ),
  };
}

/**
 * Extracts the client IP for authentication throttling in a reverse-proxy-safe order:
 * 1. `x-real-ip` (overwritten directly by Nginx/Coolify with `$remote_addr`)
 * 2. Rightmost non-empty hop of `x-forwarded-for` (appended by the trusted edge proxy,
 *    preventing attackers from spoofing arbitrary leftmost client IPs)
 * 3. Fallback `"unknown"`
 */
export function extractClientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp.slice(0, 128);
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmost = hops[hops.length - 1];
    if (rightmost) {
      return rightmost.slice(0, 128);
    }
  }

  return "unknown";
}
