import {
  createAdminTeamMemberAsync,
  listAdminTeamMembersAsync,
  TeamMemberValidationError,
} from "@/core/auth/adminUsers";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const auth = await requireAdminApiSession(req, { minRole: "viewer" });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const members = await listAdminTeamMembersAsync();
    return NextResponse.json({
      members,
      currentRole: auth.auth.session.role || "owner",
      currentEmail: auth.auth.session.email,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unable to list team members.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminApiSession(req, { minRole: "owner" });
  if (!auth.valid) {
    return auth.response;
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        {
          error: "Team member payload must be a JSON object.",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload.", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  try {
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = typeof body.role === "string" ? body.role : "viewer";

    const created = await createAdminTeamMemberAsync({
      email,
      password,
      role,
      invitedBy: auth.auth.session.email,
    });

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: "TEAM_MEMBER_CREATED",
      target: created.email,
      ipAddress: extractClientIp(req),
      metadata: {
        memberId: created.id,
        role: created.role,
      },
    });

    return NextResponse.json(
      { success: true, member: created },
      { status: 201 },
    );
  } catch (err: unknown) {
    if (err instanceof TeamMemberValidationError) {
      const status = err.code === "TEAM_MEMBER_EXISTS" ? 409 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message =
      err instanceof Error ? err.message : "Unable to create team member.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
