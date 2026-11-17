import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { SDKManager } from "@/core/sdk/sdkManager";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

export async function GET(req: NextRequest) {
  const auth = await verifyRequestAdminSession(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!auth.valid) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    );
  }

  try {
    const allClients = await SDKManager.listClientsAsync();
    const clients = allClients.map(({ secret, token, ...client }) => {
      void secret;
      return {
        ...client,
        tokenPreview: token ? `${token.slice(0, 12)}...` : "",
      };
    });
    return NextResponse.json({ clients, count: clients.length });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to list clients";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyRequestAdminSession(
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!auth.valid) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload." },
      { status: 400 },
    );
  }

  try {
    const { clientId, name, rateLimit } = body;

    if (!clientId || !name) {
      return NextResponse.json(
        { error: "clientId and name are required" },
        { status: 400 },
      );
    }

    const safeClientId = String(clientId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    const existing = await SDKManager.getClientAsync(safeClientId);
    if (existing) {
      return NextResponse.json(
        { error: `Client '${safeClientId}' already exists` },
        { status: 409 },
      );
    }

    const newClient = await SDKManager.registerClientAsync({
      clientId: safeClientId,
      name: String(name),
      rateLimit: rateLimit ? Number(rateLimit) : 100,
    });

    return NextResponse.json({ client: newClient }, { status: 201 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Client creation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
