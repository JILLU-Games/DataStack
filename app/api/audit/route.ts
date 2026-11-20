import { listAdminAuditLogsAsync } from "@/core/auth/auditLog";
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

    const logs = await listAdminAuditLogsAsync({
      limit,
      action,
      actorEmail,
      search,
    });

    return NextResponse.json({
      logs,
      total: logs.length,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to fetch audit logs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
