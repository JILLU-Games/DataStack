import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { SDKManager } from "@/core/sdk/sdkManager";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";
const ALLOWED_PATCH_KEYS = new Set(["action", "name", "rateLimit", "status"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyRequestAdminSession(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!auth.valid) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    );
  }

  const { id } = await params;
  const normalizedId = SDKManager.normalizeClientId(id);
  try {
    const client = await SDKManager.getClientAsync(normalizedId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }
    const { secret, token, ...clientSummary } = client;
    void secret;
    const includeToken = req.nextUrl.searchParams.get("includeToken") === "true";
    return NextResponse.json({
      client: {
        ...clientSummary,
        tokenPreview: token ? `${token.slice(0, 12)}...` : "",
        ...(includeToken ? { token } : {}),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load client";
    const isDbError = message.includes("DATABASE_");
    return NextResponse.json(
      {
        error: message,
        code: isDbError ? "DATABASE_READ_FAILED" : "CLIENT_FETCH_FAILED",
      },
      { status: isDbError ? 503 : 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyRequestAdminSession(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!auth.valid) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    );
  }

  const { id } = await params;
  const normalizedId = SDKManager.normalizeClientId(id);

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload.", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json(
      { error: "Update payload must be a JSON object.", code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  const body = rawBody as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter(
    (key) => !ALLOWED_PATCH_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      {
        error: `Unsupported client field(s): ${unknownKeys.join(", ")}`,
        code: "VALIDATION_ERROR",
      },
      { status: 400 },
    );
  }

  // Special action: regenerate token
  if (body.action !== undefined) {
    if (body.action !== "regenerate_token") {
      return NextResponse.json(
        { error: "Unsupported client action.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    try {
      const refreshed = await SDKManager.regenerateTokenAsync(normalizedId);
      if (!refreshed) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 });
      }
      return NextResponse.json({ client: refreshed });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Token regeneration failed";
      const isDbWrite = message.includes("DATABASE_WRITE_FAILED");
      return NextResponse.json(
        {
          error: message,
          code: isDbWrite ? "DATABASE_WRITE_FAILED" : "TOKEN_REGENERATION_FAILED",
        },
        { status: isDbWrite ? 503 : 500 },
      );
    }
  }

  const updates: { name?: string; rateLimit?: number; status?: "active" | "revoked" } = {};
  if (body.name !== undefined) {
    if (
      typeof body.name !== "string" ||
      body.name.trim().length < 1 ||
      body.name.trim().length > 120
    ) {
      return NextResponse.json(
        { error: "Client name must be a non-empty string (max 120 characters).", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    updates.name = body.name.trim();
  }
  if (body.rateLimit !== undefined) {
    if (
      typeof body.rateLimit !== "number" ||
      !Number.isInteger(body.rateLimit) ||
      body.rateLimit < 1 ||
      body.rateLimit > 100000
    ) {
      return NextResponse.json(
        { error: "rateLimit must be an integer between 1 and 100000.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    updates.rateLimit = body.rateLimit;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "revoked") {
      return NextResponse.json(
        { error: "status must be 'active' or 'revoked'.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields provided for update.", code: "VALIDATION_ERROR" },
      { status: 400 },
    );
  }

  try {
    const updated = await SDKManager.updateClientAsync(normalizedId, updates);
    if (!updated) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }
    return NextResponse.json({ client: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    const isDbWrite = message.includes("DATABASE_WRITE_FAILED");
    return NextResponse.json(
      {
        error: message,
        code: isDbWrite ? "DATABASE_WRITE_FAILED" : "CLIENT_UPDATE_FAILED",
      },
      { status: isDbWrite ? 503 : 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyRequestAdminSession(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!auth.valid) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    );
  }

  const { id } = await params;
  const normalizedId = SDKManager.normalizeClientId(id);
  const purgeFiles = req.nextUrl.searchParams.get("purgeFiles") === "true";
  try {
    const result = await SDKManager.deleteClientWithStatsAsync(normalizedId, {
      purgeFiles,
    });
    if (!result.deleted) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      message: `Client ${normalizedId} deleted`,
      purgedFiles: result.purgedFiles,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Client deletion failed";
    const isDbWrite = message.includes("DATABASE_WRITE_FAILED");
    return NextResponse.json(
      {
        error: message,
        code: isDbWrite ? "DATABASE_WRITE_FAILED" : "CLIENT_DELETE_FAILED",
      },
      { status: isDbWrite ? 503 : 500 },
    );
  }
}
