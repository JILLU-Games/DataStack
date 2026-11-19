import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { SDKManager } from "@/core/sdk/sdkManager";
import {
  validateAllowedIpsInput,
  validateClientExpiresAtInput,
} from "@/core/Security/ipAllowlist";
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
    const {
      clientId,
      name,
      rateLimit,
      storageQuotaMb,
      allowedIps,
      expiresAt,
    } = body;

    if (typeof clientId !== "string" || typeof name !== "string" || !clientId.trim() || !name.trim()) {
      return NextResponse.json(
        { error: "clientId and name are required strings", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const safeClientId = SDKManager.normalizeClientId(clientId);
    if (!safeClientId) {
      return NextResponse.json(
        { error: "clientId is invalid", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const parsedRateLimit = rateLimit === undefined ? 100 : Number(rateLimit);
    if (!Number.isInteger(parsedRateLimit) || parsedRateLimit < 1 || parsedRateLimit > 100000) {
      return NextResponse.json(
        { error: "rateLimit must be an integer between 1 and 100000.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const parsedQuotaMb = storageQuotaMb === undefined ? 0 : Number(storageQuotaMb);
    if (!Number.isInteger(parsedQuotaMb) || parsedQuotaMb < 0 || parsedQuotaMb > 1048576) {
      return NextResponse.json(
        { error: "storageQuotaMb must be an integer between 0 and 1048576.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    let normalizedAllowedIps = "";
    if (allowedIps !== undefined && allowedIps !== null) {
      if (typeof allowedIps !== "string") {
        return NextResponse.json(
          { error: "allowedIps must be a string.", code: "VALIDATION_ERROR" },
          { status: 400 },
        );
      }
      const ipValidation = validateAllowedIpsInput(allowedIps);
      if (!ipValidation.valid) {
        return NextResponse.json(
          { error: ipValidation.error || "Invalid allowedIps.", code: "VALIDATION_ERROR" },
          { status: 400 },
        );
      }
      normalizedAllowedIps = ipValidation.normalized;
    }

    let normalizedExpiresAt: string | null = null;
    if (expiresAt !== undefined) {
      const expValidation = validateClientExpiresAtInput(expiresAt);
      if (!expValidation.valid) {
        return NextResponse.json(
          { error: expValidation.error || "Invalid expiresAt.", code: "VALIDATION_ERROR" },
          { status: 400 },
        );
      }
      normalizedExpiresAt = expValidation.normalized;
    }

    const existing = await SDKManager.getClientAsync(safeClientId);
    if (existing) {
      return NextResponse.json(
        { error: `Client '${safeClientId}' already exists` },
        { status: 409 },
      );
    }

    const newClient = await SDKManager.registerClientAsync({
      clientId: safeClientId,
      name: name.trim().slice(0, 120),
      rateLimit: parsedRateLimit,
      storageQuotaMb: parsedQuotaMb,
      allowedIps: normalizedAllowedIps,
      expiresAt: normalizedExpiresAt,
    });

    return NextResponse.json({ client: newClient }, { status: 201 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Client creation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
