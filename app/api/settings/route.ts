import {
  SettingsManager,
  type AdminSettings,
} from "@/core/adminSettings/settingsManager";
import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "datastack_admin_session";

const ALLOWED_SETTING_KEYS = new Set([
  "maxEventsPerSec",
  "maxPayloadSizeKb",
  "batchFlushThreshold",
  "batchFlushIntervalMs",
  "fileRotationMb",
  "enableIdempotency",
  "autoPruneDays",
  "jwtSecret",
]);

function parseBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  if (raw < min || raw > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return raw;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await verifyRequestAdminSession(
      req.cookies.get(SESSION_COOKIE)?.value,
    );
    if (!auth.valid) {
      return NextResponse.json(
        {
          error:
            auth.reason === "UNAUTHORIZED"
              ? "Authentication required."
              : "Admin authentication is temporarily unavailable.",
        },
        { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
      );
    }

    const settings = await SettingsManager.getPublicSettingsAsync();
    return NextResponse.json({ settings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Settings read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyRequestAdminSession(
      req.cookies.get(SESSION_COOKIE)?.value,
    );
    if (!auth.valid) {
      return NextResponse.json(
        {
          error:
            auth.reason === "UNAUTHORIZED"
              ? "Authentication required."
              : "Admin authentication is temporarily unavailable.",
        },
        { status: auth.reason === "UNAUTHORIZED" ? 401 : 503 },
      );
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
          error: "Settings payload must be a JSON object.",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    const body = rawBody as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter(
      (key) => !ALLOWED_SETTING_KEYS.has(key),
    );
    if (unknownKeys.length > 0) {
      return NextResponse.json(
        {
          error: `Unsupported settings field(s): ${unknownKeys.join(", ")}`,
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    const validated: Partial<AdminSettings> = {};
    try {
      if (body.maxEventsPerSec !== undefined) {
        validated.maxEventsPerSec = parseBoundedInt(
          body.maxEventsPerSec,
          "maxEventsPerSec",
          1,
          100000,
        );
      }
      if (body.maxPayloadSizeKb !== undefined) {
        validated.maxPayloadSizeKb = parseBoundedInt(
          body.maxPayloadSizeKb,
          "maxPayloadSizeKb",
          1,
          10240,
        );
      }
      if (body.batchFlushThreshold !== undefined) {
        validated.batchFlushThreshold = parseBoundedInt(
          body.batchFlushThreshold,
          "batchFlushThreshold",
          1,
          50000,
        );
      }
      if (body.batchFlushIntervalMs !== undefined) {
        validated.batchFlushIntervalMs = parseBoundedInt(
          body.batchFlushIntervalMs,
          "batchFlushIntervalMs",
          100,
          60000,
        );
      }
      if (body.fileRotationMb !== undefined) {
        validated.fileRotationMb = parseBoundedInt(
          body.fileRotationMb,
          "fileRotationMb",
          1,
          2048,
        );
      }
      if (body.autoPruneDays !== undefined) {
        validated.autoPruneDays = parseBoundedInt(
          body.autoPruneDays,
          "autoPruneDays",
          0,
          3650,
        );
      }
      if (body.enableIdempotency !== undefined) {
        if (typeof body.enableIdempotency !== "boolean") {
          throw new Error("enableIdempotency must be a boolean.");
        }
        validated.enableIdempotency = body.enableIdempotency;
      }
      if (body.jwtSecret !== undefined) {
        if (typeof body.jwtSecret !== "string" || body.jwtSecret.trim().length < 32) {
          throw new Error(
            "jwtSecret must be a string with at least 32 characters.",
          );
        }
        validated.jwtSecret = body.jwtSecret.trim();
      }
    } catch (validationErr: unknown) {
      return NextResponse.json(
        {
          error:
            validationErr instanceof Error
              ? validationErr.message
              : "Invalid settings value.",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }

    await SettingsManager.updateSettingsAsync(validated);
    const settings = await SettingsManager.getPublicSettingsAsync();
    const bridgeSync = SettingsManager.getLastBridgeSyncStatus();
    return NextResponse.json({
      settings,
      success: true,
      ...(bridgeSync
        ? {
            bridgeSync: {
              attempted: bridgeSync.attempted ?? true,
              ok: bridgeSync.ok ?? bridgeSync.synced,
              synced: bridgeSync.synced,
              ...(bridgeSync.status !== undefined
                ? { status: bridgeSync.status }
                : {}),
              ...(bridgeSync.error ? { error: bridgeSync.error } : {}),
              checkedAt: bridgeSync.checkedAt,
            },
          }
        : {}),
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Settings update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
