import {
  deleteAdminTeamMemberAsync,
  PrimaryOwnerProtectedError,
  TeamMemberValidationError,
  updateAdminTeamMemberAsync,
} from "@/core/auth/adminUsers";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
          error: "Team member update payload must be a JSON object.",
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
    const { id } = await params;
    const updated = await updateAdminTeamMemberAsync(id, {
      role: typeof body.role === "string" ? body.role : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      password: typeof body.password === "string" ? body.password : undefined,
      revokeSessions: body.revokeSessions === true,
    });

    const action =
      body.status === "disabled" || body.revokeSessions === true
        ? "TEAM_MEMBER_REVOKED"
        : "TEAM_MEMBER_UPDATED";

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action,
      target: updated.email,
      ipAddress: extractClientIp(req),
      metadata: {
        memberId: updated.id,
        role: updated.role,
        status: updated.status,
        passwordReset: Boolean(body.password),
      },
    });

    return NextResponse.json({ success: true, member: updated });
  } catch (err: unknown) {
    if (err instanceof PrimaryOwnerProtectedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    if (err instanceof TeamMemberValidationError) {
      const status = err.code === "TEAM_MEMBER_NOT_FOUND" ? 404 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message =
      err instanceof Error ? err.message : "Unable to update team member.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminApiSession(req, { minRole: "owner" });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const { id } = await params;
    const deleted = await deleteAdminTeamMemberAsync(id);

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: "TEAM_MEMBER_DELETED",
      target: deleted.email,
      ipAddress: extractClientIp(req),
      metadata: {
        memberId: deleted.id,
      },
    });

    return NextResponse.json({
      success: true,
      deletedId: deleted.id,
      email: deleted.email,
    });
  } catch (err: unknown) {
    if (err instanceof PrimaryOwnerProtectedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    if (err instanceof TeamMemberValidationError) {
      const status = err.code === "TEAM_MEMBER_NOT_FOUND" ? 404 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message =
      err instanceof Error ? err.message : "Unable to delete team member.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
