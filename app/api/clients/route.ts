import { SDKManager } from "@/core/sdk/sdkManager";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    const allClients = await SDKManager.listClientsAsync();
    const clients = allClients.map(({ secret, ...client }) => {
      void secret;
      return client;
    });
    return NextResponse.json({ clients, count: clients.length });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to list clients";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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
