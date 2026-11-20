import { getSessionCookieOptions } from "@/core/auth/adminSession";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import {
  revokeAdminSessions,
  verifyRequestAdminSession,
} from "@/core/auth/adminUsers";
import { extractClientIp } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      const check = await verifyRequestAdminSession(token);
      if (check.valid) {
        await revokeAdminSessions({
          memberId: check.session.memberId,
          email: check.session.email,
        });
        await recordAdminAuditLogAsync({
          actorEmail: check.session.email,
          actorRole: check.session.role || "owner",
          action: "ADMIN_LOGOUT",
          target: check.session.email,
          ipAddress: extractClientIp(request),
          metadata: {
            memberId: check.session.memberId || "owner-1",
          },
        });
      }
    } catch {
      // Still clear client cookie even if server revocation encounters transient DB error
    }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...getSessionCookieOptions(request, 0),
    expires: new Date(0),
  });
  return response;
}
