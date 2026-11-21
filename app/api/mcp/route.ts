import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import {
  MCP_PERMISSION_DEFINITIONS,
  McpSettingsManager,
  type McpPermissionKey,
  type McpSettingsUpdateInput,
} from "@/core/mcp/mcpSettings";
import { SecretVaultError } from "@/core/Security/secretVault";
import { SSRFBlockedError } from "@/core/Security/ssrfGuard";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

const ALLOWED_MCP_FIELDS = new Set([
  "enabled",
  "allowedIps",
  "permissions",
  "rotateToken",
  "revokeToken",
  "coolifyUrl",
  "coolifyToken",
  "clearCoolifyToken",
  "coolifyAppUuid",
]);

const VALID_PERMISSION_KEYS = new Set<string>(
  MCP_PERMISSION_DEFINITIONS.map((def) => def.key),
);

function parseOptionalString(
  raw: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof raw !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function parseOptionalBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return raw;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminApiSession(req, { minRole: "owner" });
    if (!auth.valid) {
      return auth.response;
    }

    const settings = await McpSettingsManager.getPublicSettingsAsync();
    const bridgeSync = McpSettingsManager.getLastBridgeSyncStatus();

    return NextResponse.json({
      settings,
      permissionDefinitions: MCP_PERMISSION_DEFINITIONS,
      bridgeSync,
      runtime: {
        endpointPath: settings.endpointPath,
        permissionCount: MCP_PERMISSION_DEFINITIONS.length,
      },
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to load MCP settings.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminApiSession(req, { minRole: "owner" });
    if (!auth.valid) {
      return auth.response;
    }

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
        {
          error: "MCP settings payload must be a JSON object.",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    const body = rawBody as Record<string, unknown>;
    const unknownFields = Object.keys(body).filter(
      (key) => !ALLOWED_MCP_FIELDS.has(key),
    );
    if (unknownFields.length > 0) {
      return NextResponse.json(
        {
          error: `Unsupported MCP settings field(s): ${unknownFields.join(", ")}`,
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    const validated: McpSettingsUpdateInput = {};
    try {
      if (body.enabled !== undefined) {
        validated.enabled = parseOptionalBoolean(body.enabled, "enabled");
      }
      if (body.rotateToken !== undefined) {
        validated.rotateToken = parseOptionalBoolean(
          body.rotateToken,
          "rotateToken",
        );
      }
      if (body.revokeToken !== undefined) {
        validated.revokeToken = parseOptionalBoolean(
          body.revokeToken,
          "revokeToken",
        );
      }
      if (validated.rotateToken && validated.revokeToken) {
        throw new Error("rotateToken and revokeToken cannot both be true.");
      }
      if (body.allowedIps !== undefined) {
        validated.allowedIps = parseOptionalString(
          body.allowedIps,
          "allowedIps",
          2048,
        );
      }
      if (body.coolifyUrl !== undefined) {
        validated.coolifyUrl = parseOptionalString(
          body.coolifyUrl,
          "coolifyUrl",
          512,
        );
      }
      if (body.coolifyToken !== undefined) {
        validated.coolifyToken = parseOptionalString(
          body.coolifyToken,
          "coolifyToken",
          512,
        );
      }
      if (body.clearCoolifyToken !== undefined) {
        validated.clearCoolifyToken = parseOptionalBoolean(
          body.clearCoolifyToken,
          "clearCoolifyToken",
        );
      }
      if (body.coolifyAppUuid !== undefined) {
        validated.coolifyAppUuid = parseOptionalString(
          body.coolifyAppUuid,
          "coolifyAppUuid",
          128,
        );
      }
      if (body.permissions !== undefined) {
        if (
          !body.permissions ||
          typeof body.permissions !== "object" ||
          Array.isArray(body.permissions)
        ) {
          throw new Error("permissions must be a JSON object.");
        }
        const rawPerms = body.permissions as Record<string, unknown>;
        const unknownPerms = Object.keys(rawPerms).filter(
          (k) => !VALID_PERMISSION_KEYS.has(k),
        );
        if (unknownPerms.length > 0) {
          throw new Error(
            `Unknown MCP permission key(s): ${unknownPerms.join(", ")}`,
          );
        }
        const cleanedPerms: Partial<Record<McpPermissionKey, boolean>> = {};
        for (const [k, v] of Object.entries(rawPerms)) {
          if (typeof v !== "boolean") {
            throw new Error(`Permission '${k}' must be a boolean.`);
          }
          cleanedPerms[k as McpPermissionKey] = v;
        }
        validated.permissions = cleanedPerms;
      }

      if (Object.keys(validated).length === 0) {
        throw new Error("No MCP settings fields supplied.");
      }
    } catch (validationErr: unknown) {
      return NextResponse.json(
        {
          error:
            validationErr instanceof Error
              ? validationErr.message
              : "Invalid MCP settings payload.",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    const result = await McpSettingsManager.updateSettingsAsync(validated);

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: result.tokenRotated ? "MCP_TOKEN_ROTATED" : "MCP_SETTINGS_UPDATED",
      target: "mcp_settings",
      ipAddress: extractClientIp(req),
      metadata: {
        updatedFields: Object.keys(validated),
        enabled: result.settings.enabled,
        tokenRotated: result.tokenRotated,
        revoked: Boolean(validated.revokeToken),
        hasAllowedIps: Boolean(result.settings.allowedIps),
        permissionChanges: validated.permissions
          ? Object.keys(validated.permissions)
          : [],
      },
    });

    return NextResponse.json({
      success: true,
      settings: result.settings,
      ...(result.issuedToken ? { issuedToken: result.issuedToken } : {}),
      tokenRotated: result.tokenRotated,
      bridgeSync: result.bridgeSync,
    });
  } catch (err: unknown) {
    if (err instanceof SSRFBlockedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    if (err instanceof SecretVaultError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 500 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Failed to update MCP settings.";
    const isValidation =
      /invalid|cidr|ip|required|already|must be/i.test(message);
    return NextResponse.json(
      {
        error: message,
        code: isValidation ? "VALIDATION_ERROR" : "MCP_SETTINGS_ERROR",
      },
      { status: isValidation ? 400 : 500 },
    );
  }
}
