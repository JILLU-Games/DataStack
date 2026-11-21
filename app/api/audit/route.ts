import { listAdminAuditLogsWithStatusAsync } from "@/core/auth/auditLog";
import { requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const auth = await requireAdminApiSession(req, { minRole: "viewer" });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(req.url);
    const rawLimit = Number(searchParams.get("limit") || "100");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 500)
      : 100;
    const action = searchParams.get("action") || undefined;
    const actorEmail =
      searchParams.get("actor") ||
      searchParams.get("actorEmail") ||
      undefined;
    const search =
      searchParams.get("q") || searchParams.get("search") || undefined;

    const result = await listAdminAuditLogsWithStatusAsync({
      limit,
      action,
      actorEmail,
      search,
    });

    const response = NextResponse.json({
      logs: result.logs,
      total: result.logs.length,
      storageMode: result.storageMode,
      degraded: result.degraded,
      ...(result.code ? { code: result.code } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    });
    if (result.degraded) {
      response.headers.set("X-DataStack-Audit-Degraded", "1");
    }
    return response;
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to fetch audit logs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
