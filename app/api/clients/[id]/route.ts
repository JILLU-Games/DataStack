import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { SDKManager } from "@/core/sdk/sdkManager";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

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
  const client = await SDKManager.getClientAsync(id);
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
  try {
    const body = await req.json();

    // Special action: regenerate token
    if (body.action === "regenerate_token") {
      const refreshed = await SDKManager.regenerateTokenAsync(id);
      if (!refreshed) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ client: refreshed });
    }

    const updated = await SDKManager.updateClientAsync(id, body);
    if (!updated) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }
    return NextResponse.json({ client: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
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
  const purgeFiles = req.nextUrl.searchParams.get("purgeFiles") === "true";
  const deleted = await SDKManager.deleteClientAsync(id, { purgeFiles });
  if (!deleted) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, message: `Client ${id} deleted` });
}
