import { verifyAdminSessionToken } from "@/core/auth/adminSession";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

function isProtectedApi(pathname: string, method: string) {
  if (pathname === "/api/auth/login") return false;
  if (pathname === "/api/auth/setup/status" && method === "GET") return false;
  if (pathname === "/api/auth/setup" && method === "POST") return false;
  if (pathname === "/api/events" && method === "POST") return false;
  return pathname.startsWith("/api/");
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

  if (isSetupPage) return NextResponse.next();
  if (!isConsolePage && !isAdminApi && !isLoginPage) return NextResponse.next();

  const sessionSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;
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
