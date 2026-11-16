import { getSessionCookieOptions } from "@/core/auth/adminSession";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...getSessionCookieOptions(request, 0),
    expires: new Date(0),
  });
  return response;
}
