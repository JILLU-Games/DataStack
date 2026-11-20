import {
  createAdminSessionToken,
  formatAdminRoleLabel,
  getSessionCookieOptions,
} from "@/core/auth/adminSession";
import {
  getAdminAccountInfo,
  updateAdminAccount,
  verifyRequestAdminSession,
} from "@/core/auth/adminUsers";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { extractClientIp } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const auth = await verifyRequestAdminSession(token);

  if (!auth.valid) {
    const status = auth.reason === "UNAUTHORIZED" ? 401 : 503;
    const code =
      auth.reason === "UNAUTHORIZED" ? "SESSION_EXPIRED" : "AUTH_UNAVAILABLE";
    const message =
      auth.reason === "UNAUTHORIZED"
        ? "Authentication required."
        : "Admin authentication is temporarily unavailable.";
    return NextResponse.json({ error: message, code }, { status });
  }

  try {
    const account = await getAdminAccountInfo(auth.session.email);
    const effectiveRole = auth.session.role || account.role || "owner";
    return NextResponse.json({
      profile: {
        email: account.email,
        role: formatAdminRoleLabel(effectiveRole),
        roleKey: effectiveRole,
        memberId: auth.session.memberId || account.memberId || "owner-1",
        storageMode: account.storageMode,
        createdAt: account.createdAt,
        sessionExpiresAt: new Date(auth.session.expiresAt).toISOString(),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to load admin profile." },
      { status: 503 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const auth = await verifyRequestAdminSession(token);

  if (!auth.valid) {
    const status = auth.reason === "UNAUTHORIZED" ? 401 : 503;
    const code =
      auth.reason === "UNAUTHORIZED" ? "SESSION_EXPIRED" : "AUTH_UNAVAILABLE";
    const message =
      auth.reason === "UNAUTHORIZED"
        ? "Authentication required."
        : "Admin authentication is temporarily unavailable.";
    return NextResponse.json({ error: message, code }, { status });
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
      { error: "Invalid profile payload." },
      { status: 400 },
    );
  }

  try {
    const nextEmail =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : auth.session.email;
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";

    if (!validEmail(nextEmail)) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 },
      );
    }

    if (!currentPassword) {
      return NextResponse.json(
        { error: "Current password is required to save changes." },
        { status: 400 },
      );
    }

    if (newPassword && (newPassword.length < 8 || newPassword.length > 256)) {
      return NextResponse.json(
        { error: "New password must be between 8 and 256 characters." },
        { status: 400 },
      );
    }

    const account = await getAdminAccountInfo(auth.session.email);
    const result = await updateAdminAccount({
      currentEmail: account.email,
      currentPassword,
      nextEmail,
      nextPassword: newPassword || undefined,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: "INVALID_PASSWORD" },
        { status: 401 },
      );
    }

    const remainingSeconds = Math.max(
      SESSION_SECONDS,
      Math.ceil((auth.session.expiresAt - Date.now()) / 1000),
    );
    const expiresAt = Date.now() + remainingSeconds * 1000;
    const effectiveRole = result.role || auth.session.role || "owner";
    const effectiveMemberId =
      result.memberId || auth.session.memberId || "owner-1";
    const nextToken = await createAdminSessionToken(
      result.email,
      auth.sessionSecret,
      expiresAt,
      result.tokenVersion,
      effectiveRole,
      effectiveMemberId,
    );

    await recordAdminAuditLogAsync({
      actorEmail: result.email,
      actorRole: effectiveRole,
      action: newPassword ? "ADMIN_PASSWORD_UPDATED" : "ADMIN_PROFILE_UPDATED",
      target: result.email,
      ipAddress: extractClientIp(request),
      metadata: {
        emailChanged: result.email !== account.email,
        passwordRotated: Boolean(newPassword),
      },
    });

    const response = NextResponse.json({
      success: true,
      profile: {
        email: result.email,
        role: formatAdminRoleLabel(effectiveRole),
        roleKey: effectiveRole,
        memberId: effectiveMemberId,
        storageMode: account.storageMode,
        createdAt: account.createdAt,
        sessionExpiresAt: new Date(expiresAt).toISOString(),
      },
    });

    response.cookies.set(
      SESSION_COOKIE,
      nextToken,
      getSessionCookieOptions(request, remainingSeconds),
    );

    return response;
  } catch {
    return NextResponse.json(
      { error: "Unable to update profile." },
      { status: 500 },
    );
  }
}
