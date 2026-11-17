import {
  createAdminSessionToken,
  getAdminSessionPayload,
  getSessionCookieOptions,
} from "@/core/auth/adminSession";
import {
  getAdminAccountInfo,
  updateAdminAccount,
} from "@/core/auth/adminUsers";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function GET(request: NextRequest) {
  const sessionSecret =
    process.env.DATASTACK_ADMIN_SESSION_SECRET ||
    "datastack-admin-session-default-secret-32-chars";
  const token = request.cookies.get(SESSION_COOKIE)?.value || "";
  const session = await getAdminSessionPayload(token, sessionSecret);

  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const account = await getAdminAccountInfo(session.email);
  return NextResponse.json({
    profile: {
      email: account.email,
      role: "Owner",
      storageMode: account.storageMode,
      createdAt: account.createdAt,
      sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    },
  });
}

export async function PUT(request: NextRequest) {
  const sessionSecret =
    process.env.DATASTACK_ADMIN_SESSION_SECRET ||
    "datastack-admin-session-default-secret-32-chars";
  const token = request.cookies.get(SESSION_COOKIE)?.value || "";
  const session = await getAdminSessionPayload(token, sessionSecret);

  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    const body = await request.json();
    const nextEmail =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : session.email;
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

    const account = await getAdminAccountInfo(session.email);
    const result = await updateAdminAccount({
      currentEmail: account.email,
      currentPassword,
      nextEmail,
      nextPassword: newPassword || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    // Preserve remaining session duration (e.g., 30-day "Remember me" session)
    const remainingSeconds = Math.max(
      SESSION_SECONDS,
      Math.ceil((session.expiresAt - Date.now()) / 1000),
    );
    const expiresAt = Date.now() + remainingSeconds * 1000;
    const nextToken = await createAdminSessionToken(
      result.email,
      sessionSecret,
      expiresAt,
    );

    const response = NextResponse.json({
      success: true,
      profile: {
        email: result.email,
        role: "Owner",
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
      { status: 400 },
    );
  }
}
