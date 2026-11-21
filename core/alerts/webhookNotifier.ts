import crypto from "node:crypto";
import { validateOutboundUrlAsync } from "@/core/Security/ssrfGuard";

export type WebhookAlertEventType =
  | "DISK_SPACE_LOW"
  | "STORAGE_QUOTA_EXCEEDED"
  | "S3_ARCHIVE_FAILED"
  | "CLIENT_IP_FORBIDDEN"
  | "CLIENT_TOKEN_EXPIRED"
  | "ADMIN_LOGIN_LOCKOUT"
  | "TEST_ALERT";

export interface WebhookAlertPayload {
  event: WebhookAlertEventType;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  clientId?: string;
  details?: Record<string, unknown>;
  timestamp?: string;
}

export interface WebhookRuntimeConfig {
  enabled: boolean;
  webhookUrl: string;
  webhookSecret: string;
  cooldownSec: number;
}

export interface WebhookDispatchResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  code?: string;
  status?: number;
  error?: string;
}

type WebhookGlobals = typeof globalThis & {
  __dataStackWebhookCooldownMap?: Map<string, number>;
};

const globals = globalThis as WebhookGlobals;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

function getCooldownMap(): Map<string, number> {
  if (!globals.__dataStackWebhookCooldownMap) {
    globals.__dataStackWebhookCooldownMap = new Map<string, number>();
  }
  return globals.__dataStackWebhookCooldownMap;
}

export function clearWebhookCooldownCacheForTests(): void {
  getCooldownMap().clear();
}

export function buildWebhookSignature(
  rawBody: string,
  secret: string,
): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return `sha256=${hmac}`;
}

export function formatOutboundWebhookBody(payload: WebhookAlertPayload): string {
  const timestamp = payload.timestamp || new Date().toISOString();
  const prefix =
    payload.severity === "critical"
      ? "[CRITICAL]"
      : payload.severity === "warning"
        ? "[WARNING]"
        : "[INFO]";
  const clientTag = payload.clientId ? ` (client: ${payload.clientId})` : "";
  const summaryLine = `${prefix} DataStack ${payload.event}${clientTag} — ${payload.title}: ${payload.message}`;

  return JSON.stringify({
    instance: "DataStack",
    event: payload.event,
    severity: payload.severity,
    title: payload.title,
    message: payload.message,
    ...(payload.clientId ? { clientId: payload.clientId } : {}),
    ...(payload.details ? { details: payload.details } : {}),
    timestamp,
    // Slack & Discord compatible top-level fields
    text: summaryLine,
    content: summaryLine,
  });
}

export async function dispatchWebhookAlertAsync(
  payload: WebhookAlertPayload,
  config: WebhookRuntimeConfig,
  options?: { bypassCooldown?: boolean; timeoutMs?: number },
): Promise<WebhookDispatchResult> {
  const webhookUrl = String(config.webhookUrl || "").trim();
  if (!options?.bypassCooldown && !config.enabled) {
    return { ok: false, skipped: true, reason: "WEBHOOK_DISABLED" };
  }
  if (!webhookUrl) {
    return {
      ok: false,
      skipped: !options?.bypassCooldown,
      error: "Webhook URL is not configured.",
    };
  }

  const ssrfCheck = await validateOutboundUrlAsync(webhookUrl, {
    fieldName: "Webhook URL",
  });
  if (!ssrfCheck.allowed || !ssrfCheck.url) {
    return {
      ok: false,
      code: ssrfCheck.code || "SSRF_BLOCKED_HOST",
      error: ssrfCheck.error || "Webhook URL is not allowed.",
    };
  }
  const parsedUrl = ssrfCheck.url;

  const dedupeKey = `${payload.event}:${payload.clientId || "global"}`;
  const cooldownMs = Math.max(0, (Number(config.cooldownSec) || 300) * 1000);
  const now = Date.now();
  const cooldownMap = getCooldownMap();

  if (!options?.bypassCooldown && cooldownMs > 0) {
    const lastSentAt = cooldownMap.get(dedupeKey);
    if (lastSentAt !== undefined && now - lastSentAt < cooldownMs) {
      return { ok: true, skipped: true, reason: "COOLDOWN_ACTIVE" };
    }
    cooldownMap.set(dedupeKey, now);
  }

  const timestamp = payload.timestamp || new Date(now).toISOString();
  const bodyStr = formatOutboundWebhookBody({ ...payload, timestamp });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "DataStack-Webhook-Notifier/2.0",
    "X-DataStack-Event": payload.event,
    "X-DataStack-Timestamp": timestamp,
  };

  const secret = String(config.webhookSecret || "").trim();
  if (secret) {
    headers["X-DataStack-Signature"] = buildWebhookSignature(bodyStr, secret);
  }

  const timeoutMs = Math.max(500, options?.timeoutMs || DEFAULT_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers,
      body: bodyStr,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        code: "SSRF_BLOCKED_HOST",
        status: res.status,
        error: `Webhook endpoint attempted an unsupported HTTP ${res.status} redirect.`,
      };
    }

    if (!res.ok) {
      if (!options?.bypassCooldown) {
        // Keep cooldown entry so failing webhooks don't DDOS a broken upstream endpoint
      }
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `Webhook endpoint returned HTTP ${res.status}${errText ? `: ${errText.slice(0, 160)}` : ""}`,
      };
    }

    return { ok: true, status: res.status };
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Webhook delivery failed";
    return {
      ok: false,
      error: `Webhook delivery failed: ${msg}`,
    };
  }
}
