import {
  type AdminRole,
  createAdminSessionToken,
  getAdminSessionSecret,
  getSessionCookieOptions,
} from "@/core/auth/adminSession";
import {
  AdminSetupRequiredError,
  authenticateAdminCredentials,
  clearAdminLoginAttempts,
  consumeAdminLoginAttempt,
} from "@/core/auth/adminUsers";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { extractClientIp } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const REMEMBERED_SESSION_SECONDS = 30 * 24 * 60 * 60;

export async function POST(request: NextRequest) {
  const sessionSecret = getAdminSessionSecret();

  if (!sessionSecret || sessionSecret.length < 32) {
    return NextResponse.json(
      {
        error: "Admin authentication is not configured.",
      },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return NextResponse.json(
      { error: "Invalid login request." },
      { status: 400 },
    );
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || password.length === 0 || password.length > 1024) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const clientIp = extractClientIp(request);

  let throttleDecision;
  try {
    throttleDecision = await consumeAdminLoginAttempt(
      email,
      sessionSecret,
      clientIp,
    );
  } catch {
    return NextResponse.json(
      { error: "Admin authentication is temporarily unavailable." },
      { status: 503 },
    );
  }
  if (!throttleDecision.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(throttleDecision.retryAfterSeconds),
        },
      },
    );
  }

  let authResult: {
    authenticated: boolean;
    tokenVersion: number;
    role: AdminRole;
    memberId: string;
    email: string;
  };
  try {
    authResult = await authenticateAdminCredentials(email, password);
  } catch (err) {
    if (err instanceof AdminSetupRequiredError) {
      return NextResponse.json(
        {
          error: "Initial admin setup is required before signing in.",
          code: err.code,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Admin authentication is temporarily unavailable." },
      { status: 503 },
    );
  }

  if (!authResult.authenticated) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  try {
    await clearAdminLoginAttempts(email, sessionSecret, clientIp);
  } catch {
    return NextResponse.json(
      { error: "Admin authentication is temporarily unavailable." },
      { status: 503 },
    );
  }

  const remember = body.remember === true;
  const maxAge = remember ? REMEMBERED_SESSION_SECONDS : SESSION_SECONDS;
  const expiresAt = Date.now() + maxAge * 1000;
  const effectiveEmail = authResult.email || email;
  const token = await createAdminSessionToken(
    effectiveEmail,
    sessionSecret,
    expiresAt,
    authResult.tokenVersion,
    authResult.role,
    authResult.memberId,
  );

  await recordAdminAuditLogAsync({
    actorEmail: effectiveEmail,
    actorRole: authResult.role || "owner",
    action: "ADMIN_LOGIN",
    target: effectiveEmail,
    ipAddress: clientIp,
    metadata: { remember },
  });

  const response = NextResponse.json({
    success: true,
    role: authResult.role || "owner",
  });

  response.cookies.set(
    SESSION_COOKIE,
    token,
    getSessionCookieOptions(request, maxAge),
  );

  return response;
}
