import { SDKManager } from "@/core/sdk/sdkManager";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const client = SDKManager.getClient(id);
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  const { secret, token, ...clientSummary } = client;
  return NextResponse.json({ client: clientSummary });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json();

    // Special action: regenerate token
    if (body.action === "regenerate_token") {
      const refreshed = SDKManager.regenerateToken(id);
      if (!refreshed) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ client: refreshed });
    }

    const updated = SDKManager.updateClient(id, body);
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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const deleted = SDKManager.deleteClient(id);
  if (!deleted) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, message: `Client ${id} deleted` });
}
