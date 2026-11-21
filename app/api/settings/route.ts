import {
  SettingsManager,
  type AdminSettingsUpdateInput,
} from "@/core/adminSettings/settingsManager";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { SecretVaultError } from "@/core/Security/secretVault";
import {
  SSRFBlockedError,
  validateOutboundUrlSync,
} from "@/core/Security/ssrfGuard";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

const ALLOWED_SETTING_KEYS = new Set([
  "maxEventsPerSec",
  "maxPayloadSizeKb",
  "batchFlushThreshold",
  "batchFlushIntervalMs",
  "fileRotationMb",
  "enableIdempotency",
  "autoPruneDays",
  "jwtSecret",
  "compressAfterDays",
  "enableS3Backup",
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3Prefix",
  "s3AccessKeyId",
  "s3SecretAccessKey",
  "clearS3SecretKey",
  "diskPauseThresholdPct",
  "enableWebhookAlerts",
  "webhookUrl",
  "webhookSecret",
  "clearWebhookSecret",
  "webhookCooldownSec",
  "enablePrometheusMetrics",
  "prometheusMetricsToken",
  "clearPrometheusToken",
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

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminApiSession(req, { minRole: "viewer" });
    if (!auth.valid) {
      return auth.response;
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

    const validated: AdminSettingsUpdateInput = {};
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
      if (body.compressAfterDays !== undefined) {
        validated.compressAfterDays = parseBoundedInt(
          body.compressAfterDays,
          "compressAfterDays",
          0,
          3650,
        );
      }
      if (body.diskPauseThresholdPct !== undefined) {
        const pct = parseBoundedInt(
          body.diskPauseThresholdPct,
          "diskPauseThresholdPct",
          0,
          99,
        );
        if (pct !== 0 && pct < 50) {
          throw new Error(
            "diskPauseThresholdPct must be 0 (disabled) or between 50 and 99.",
          );
        }
        validated.diskPauseThresholdPct = pct;
      }
      if (body.enableIdempotency !== undefined) {
        if (typeof body.enableIdempotency !== "boolean") {
          throw new Error("enableIdempotency must be a boolean.");
        }
        validated.enableIdempotency = body.enableIdempotency;
      }
      if (body.enableS3Backup !== undefined) {
        if (typeof body.enableS3Backup !== "boolean") {
          throw new Error("enableS3Backup must be a boolean.");
        }
        validated.enableS3Backup = body.enableS3Backup;
      }
      if (body.s3Endpoint !== undefined) {
        const ep = parseOptionalString(body.s3Endpoint, "s3Endpoint", 512);
        if (ep) {
          const normalizedEp = /^https?:\/\//i.test(ep) ? ep : `https://${ep}`;
          const check = validateOutboundUrlSync(normalizedEp, {
            fieldName: "s3Endpoint",
          });
          if (!check.allowed) {
            if (check.code === "SSRF_BLOCKED_HOST") {
              throw new SSRFBlockedError(
                check.error || "s3Endpoint target host is blocked.",
                check.hostname || "",
              );
            }
            throw new Error(
              check.error || "s3Endpoint must be a valid http(s) URL.",
            );
          }
        }
        validated.s3Endpoint = ep;
      }
      if (body.s3Region !== undefined) {
        validated.s3Region =
          parseOptionalString(body.s3Region, "s3Region", 64) || "auto";
      }
      if (body.s3Bucket !== undefined) {
        validated.s3Bucket = parseOptionalString(
          body.s3Bucket,
          "s3Bucket",
          128,
        );
      }
      if (body.s3Prefix !== undefined) {
        validated.s3Prefix = parseOptionalString(
          body.s3Prefix,
          "s3Prefix",
          256,
        );
      }
      if (body.s3AccessKeyId !== undefined) {
        validated.s3AccessKeyId = parseOptionalString(
          body.s3AccessKeyId,
          "s3AccessKeyId",
          256,
        );
      }
      if (body.s3SecretAccessKey !== undefined) {
        validated.s3SecretAccessKey = parseOptionalString(
          body.s3SecretAccessKey,
          "s3SecretAccessKey",
          512,
        );
      }
      if (body.clearS3SecretKey !== undefined) {
        if (typeof body.clearS3SecretKey !== "boolean") {
          throw new Error("clearS3SecretKey must be a boolean.");
        }
        validated.clearS3SecretKey = body.clearS3SecretKey;
      }
      if (body.enableWebhookAlerts !== undefined) {
        if (typeof body.enableWebhookAlerts !== "boolean") {
          throw new Error("enableWebhookAlerts must be a boolean.");
        }
        validated.enableWebhookAlerts = body.enableWebhookAlerts;
      }
      if (body.webhookUrl !== undefined) {
        const wh = parseOptionalString(body.webhookUrl, "webhookUrl", 1024);
        if (wh) {
          const check = validateOutboundUrlSync(wh, {
            fieldName: "webhookUrl",
          });
          if (!check.allowed) {
            if (check.code === "SSRF_BLOCKED_HOST") {
              throw new SSRFBlockedError(
                check.error || "webhookUrl target host is blocked.",
                check.hostname || "",
              );
            }
            throw new Error(
              check.error || "webhookUrl must be a valid http(s) URL.",
            );
          }
        }
        validated.webhookUrl = wh;
      }
      if (body.webhookSecret !== undefined) {
        validated.webhookSecret = parseOptionalString(
          body.webhookSecret,
          "webhookSecret",
          512,
        );
      }
      if (body.clearWebhookSecret !== undefined) {
        if (typeof body.clearWebhookSecret !== "boolean") {
          throw new Error("clearWebhookSecret must be a boolean.");
        }
        validated.clearWebhookSecret = body.clearWebhookSecret;
      }
      if (body.webhookCooldownSec !== undefined) {
        validated.webhookCooldownSec = parseBoundedInt(
          body.webhookCooldownSec,
          "webhookCooldownSec",
          10,
          86400,
        );
      }
      if (body.enablePrometheusMetrics !== undefined) {
        if (typeof body.enablePrometheusMetrics !== "boolean") {
          throw new Error("enablePrometheusMetrics must be a boolean.");
        }
        validated.enablePrometheusMetrics = body.enablePrometheusMetrics;
      }
      if (body.prometheusMetricsToken !== undefined) {
        validated.prometheusMetricsToken = parseOptionalString(
          body.prometheusMetricsToken,
          "prometheusMetricsToken",
          512,
        );
      }
      if (body.clearPrometheusToken !== undefined) {
        if (typeof body.clearPrometheusToken !== "boolean") {
          throw new Error("clearPrometheusToken must be a boolean.");
        }
        validated.clearPrometheusToken = body.clearPrometheusToken;
      }
      if (body.jwtSecret !== undefined) {
        if (
          typeof body.jwtSecret !== "string" ||
          body.jwtSecret.trim().length < 32
        ) {
          throw new Error(
            "jwtSecret must be a string with at least 32 characters.",
          );
        }
        validated.jwtSecret = body.jwtSecret.trim();
      }
    } catch (validationErr: unknown) {
      if (validationErr instanceof SSRFBlockedError) {
        return NextResponse.json(
          {
            error: validationErr.message,
            code: validationErr.code,
          },
          { status: 400 },
        );
      }
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
    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: "SETTINGS_UPDATED",
      target: "admin_settings",
      ipAddress: extractClientIp(req),
      metadata: {
        updatedFields: Object.keys(validated),
      },
    });
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
    if (err instanceof SecretVaultError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 500 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Settings update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
