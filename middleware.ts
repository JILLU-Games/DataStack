import {
  getAdminSessionSecret,
  verifyAdminSessionToken,
} from "@/core/auth/adminSession";
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

function matchesRequestHost(candidateUrl: string, request: NextRequest) {
  const requestHost = request.headers.get("host");
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (!requestHost && !forwardedHost) return false;

  try {
    const parsedHost = new URL(candidateUrl).host.toLowerCase();
    return Boolean(
      (requestHost && parsedHost === requestHost.toLowerCase()) ||
        (forwardedHost && parsedHost === forwardedHost.toLowerCase()),
    );
  } catch {
    return false;
  }
}

export function isSameOriginRequest(request: NextRequest) {
  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return false;
  }
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    return matchesRequestHost(originHeader, request);
  }
  const refererHeader = request.headers.get("referer");
  if (refererHeader) {
    return matchesRequestHost(refererHeader, request);
  }
  if (secFetchSite === "same-origin") {
    return true;
  }
  return false;
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
    !SAFE_METHODS.has(request.method.toUpperCase()) &&
    !(pathname === "/api/events" && hasBearerAuth);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-datastack-pathname", pathname);
  const nextWithPathname = () =>
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

  if (isSetupPage) return nextWithPathname();

  if (isStateChangingApi && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  if (!isConsolePage && !isAdminApi && !isLoginPage) {
    return nextWithPathname();
  }

  const sessionSecret = getAdminSessionSecret();
  if (!sessionSecret && isAdminApi) {
    return NextResponse.json(
      { error: "Admin authentication is not configured." },
      { status: 503 },
    );
  }

  if (isLoginPage) {
    return nextWithPathname();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = Boolean(
    sessionSecret &&
      token &&
      (await verifyAdminSessionToken(token, sessionSecret)),
  );

  if (authenticated) return nextWithPathname();

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
