import { createAdminSessionToken } from "@/core/auth/adminSession";
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
  const adminEmail = process.env.DATASTACK_ADMIN_EMAIL;
  const adminPassword = process.env.DATASTACK_ADMIN_PASSWORD;
  const sessionSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;

  if (
    !adminEmail ||
    !adminPassword ||
    !sessionSecret ||
    sessionSecret.length < 32
  ) {
    return NextResponse.json(
      {
        error:
          "Admin login is not configured. Set the required server environment variables.",
      },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (
      !constantTimeEqual(email, adminEmail.trim().toLowerCase()) ||
      !constantTimeEqual(password, adminPassword)
    ) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 },
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
