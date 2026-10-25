import { createAdminSessionToken } from "@/core/auth/adminSession";
import {
  clearAdminLoginAttempts,
  consumeAdminLoginAttempt,
  verifyAdminCredentials,
} from "@/core/auth/adminUsers";
import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "datastack_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const REMEMBERED_SESSION_SECONDS = 30 * 24 * 60 * 60;

function constantTimeEqual(left: string, right: string) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export async function POST(request: NextRequest) {
  const sessionSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;

  if (!sessionSecret || sessionSecret.length < 32) {
    return NextResponse.json(
      {
        error: "Admin authentication is not configured.",
      },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || password.length === 0 || password.length > 1024) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 },
      );
    }

    let throttleDecision;
    try {
      throttleDecision = await consumeAdminLoginAttempt(email, sessionSecret);
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

    let authenticated = false;
    if (process.env.NODE_ENV !== "production" && !process.env.DATABASE_URL) {
      const adminEmail = process.env.DATASTACK_ADMIN_EMAIL;
      const adminPassword = process.env.DATASTACK_ADMIN_PASSWORD;
      authenticated = Boolean(
        adminEmail &&
        adminPassword &&
        constantTimeEqual(email, adminEmail.trim().toLowerCase()) &&
        constantTimeEqual(password, adminPassword),
      );
    } else {
      try {
        authenticated = await verifyAdminCredentials(email, password);
      } catch {
        return NextResponse.json(
          { error: "Admin authentication is temporarily unavailable." },
          { status: 503 },
        );
      }
    }

    if (!authenticated) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 },
      );
    }

    try {
      await clearAdminLoginAttempts(email, sessionSecret);
    } catch {
      return NextResponse.json(
        { error: "Admin authentication is temporarily unavailable." },
        { status: 503 },
      );
    }

    const remember = body.remember === true;
    const maxAge = remember ? REMEMBERED_SESSION_SECONDS : SESSION_SECONDS;
    const expiresAt = Date.now() + maxAge * 1000;
    const token = await createAdminSessionToken(
      email,
      sessionSecret,
      expiresAt,
    );
    const response = NextResponse.json({ success: true });

    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: "Invalid login request." },
      { status: 400 },
    );
  }
}
