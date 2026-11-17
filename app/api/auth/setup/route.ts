import {
  createAdminSessionToken,
  getAdminSessionSecret,
  getSessionCookieOptions,
} from "@/core/auth/adminSession";
import {
  createInitialAdmin,
  isAdminSetupComplete,
  verifyAdminSetupKey,
} from "@/core/auth/adminUsers";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: NextRequest) {
  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret || sessionSecret.length < 32) {
    return NextResponse.json(
      { error: "Admin session configuration is unavailable." },
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
      { error: "Invalid setup request payload." },
      { status: 400 },
    );
  }

  try {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const setupKey = typeof body.setupKey === "string" ? body.setupKey : "";

    if (!validEmail(email)) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 },
      );
    }
    if (password.length < 8 || password.length > 256) {
      return NextResponse.json(
        { error: "Choose a password between 8 and 256 characters." },
        { status: 400 },
      );
    }
    if (!verifyAdminSetupKey(setupKey)) {
      return NextResponse.json(
        { error: "The installation key is invalid." },
        { status: 403 },
      );
    }
    if (await isAdminSetupComplete()) {
      return NextResponse.json(
        { error: "Initial admin setup has already been completed." },
        { status: 409 },
      );
    }

    const created = await createInitialAdmin(email, password);
    if (!created) {
      return NextResponse.json(
        { error: "Initial admin setup has already been completed." },
        { status: 409 },
      );
    }

    const token = await createAdminSessionToken(
      email,
      sessionSecret,
      Date.now() + SESSION_SECONDS * 1000,
      1,
    );
    const response = NextResponse.json({ success: true });
    response.cookies.set(
      SESSION_COOKIE,
      token,
      getSessionCookieOptions(request, SESSION_SECONDS),
    );
    return response;
  } catch {
    return NextResponse.json(
      { error: "Admin setup is temporarily unavailable." },
      { status: 503 },
    );
  }
}
