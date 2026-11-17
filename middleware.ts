import { verifyAdminSessionToken } from "@/core/auth/adminSession";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isProtectedApi(pathname: string, method: string) {
  if (pathname === "/api/auth/login") return false;
  if (pathname === "/api/auth/setup/status" && method === "GET") return false;
  if (pathname === "/api/auth/setup" && method === "POST") return false;
  if (pathname === "/api/events" && method === "POST") return false;
  if (pathname === "/api/health" && method === "GET") return false;
  return pathname.startsWith("/api/");
}

function isSameOriginRequest(request: NextRequest) {
  const originHeader = request.headers.get("origin");
  const requestHost = request.headers.get("host");
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (!originHeader || (!requestHost && !forwardedHost)) return false;

  try {
    const origin = new URL(originHeader);
    const originHost = origin.host.toLowerCase();
    const matchesHost =
      (requestHost && originHost === requestHost.toLowerCase()) ||
      (forwardedHost && originHost === forwardedHost.toLowerCase());

    return Boolean(matchesHost);
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === "/vcon/login";
  const isSetupPage = pathname === "/vcon/setup";
  const isConsolePage =
    (pathname === "/vcon" || pathname.startsWith("/vcon/")) &&
    !isLoginPage &&
    !isSetupPage;
  const isAdminApi = isProtectedApi(pathname, request.method);
  const hasBearerAuth = Boolean(
    request.headers.get("authorization")?.toLowerCase().startsWith("bearer "),
  );
  const isStateChangingApi =
    pathname.startsWith("/api/") &&
    !SAFE_METHODS.has(request.method) &&
    !(pathname === "/api/events" && hasBearerAuth);

  if (isSetupPage) return NextResponse.next();
  if (
    !isConsolePage &&
    !isAdminApi &&
    !isLoginPage &&
    !(pathname === "/api/events" && request.method === "POST")
  ) {
    return NextResponse.next();
  }

  if (isStateChangingApi && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  if (pathname === "/api/events" && request.method === "POST") {
    return NextResponse.next();
  }

  const sessionSecret =
    process.env.DATASTACK_ADMIN_SESSION_SECRET ||
    "datastack-admin-session-default-secret-32-chars";
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = Boolean(
    sessionSecret &&
    token &&
    (await verifyAdminSessionToken(token, sessionSecret)),
  );

  if (isLoginPage) {
    if (authenticated)
      return NextResponse.redirect(new URL("/vcon/dashboard", request.url));
    return NextResponse.next();
  }

  if (authenticated) return NextResponse.next();

  if (isAdminApi) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/vcon/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/vcon", "/vcon/:path*", "/api/:path*"],
};
