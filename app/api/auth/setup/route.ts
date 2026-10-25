import { createAdminSessionToken } from "@/core/auth/adminSession";
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
  const sessionSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;
  const configuredAdminEmail =
    process.env.DATASTACK_ADMIN_EMAIL?.trim().toLowerCase();
  if (!sessionSecret || sessionSecret.length < 32) {
    return NextResponse.json(
      { error: "Admin session configuration is unavailable." },
      { status: 503 },
    );
  }
  if (!configuredAdminEmail || !validEmail(configuredAdminEmail)) {
    return NextResponse.json(
      { error: "Admin setup configuration is unavailable." },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
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
    if (email !== configuredAdminEmail) {
      return NextResponse.json(
        {
          error: "Use the administrator email configured for this deployment.",
        },
        { status: 403 },
      );
    }
    if (password.length < 12 || password.length > 256) {
      return NextResponse.json(
        { error: "Choose a password between 12 and 256 characters." },
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
    );
    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Admin setup is temporarily unavailable." },
      { status: 503 },
    );
  }
}
