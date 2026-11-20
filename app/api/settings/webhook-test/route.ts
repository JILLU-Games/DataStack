import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { dispatchWebhookAlertAsync } from "@/core/alerts/webhookNotifier";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import {
  decryptSecret,
  SecretVaultError,
} from "@/core/Security/secretVault";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const auth = await requireAdminApiSession(req, { minRole: "owner" });
  if (!auth.valid) {
    return auth.response;
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload.", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  try {
    const saved = await SettingsManager.getSettingsAsync();
    const webhookUrl =
      typeof body.webhookUrl === "string"
        ? body.webhookUrl.trim()
        : saved.webhookUrl.trim();
    const clearWebhookSecret = body.clearWebhookSecret === true;
    const draftSecret =
      typeof body.webhookSecret === "string" && body.webhookSecret.trim()
        ? body.webhookSecret.trim()
        : "";
    let webhookSecret = draftSecret;
    if (!webhookSecret && !clearWebhookSecret && saved.webhookSecretEnc) {
      webhookSecret = decryptSecret(saved.webhookSecretEnc);
    }

    if (!webhookUrl) {
      return NextResponse.json(
        {
          success: false,
          code: "VALIDATION_ERROR",
          error: "Webhook URL is required to send a test alert.",
        },
        { status: 400 },
      );
    }

    try {
      const parsedUrl = new URL(webhookUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Webhook URL must use http:// or https://.");
      }
    } catch {
      return NextResponse.json(
        {
          success: false,
          code: "VALIDATION_ERROR",
          error: "Webhook URL must be a valid http:// or https:// endpoint.",
        },
        { status: 400 },
      );
    }

    const result = await dispatchWebhookAlertAsync(
      {
        event: "TEST_ALERT",
        severity: "info",
        title: "Webhook Verification",
        message: "Test alert dispatched from DataStack Admin Console.",
        details: {
          triggeredBy: auth.auth.session.email || "admin",
        },
      },
      {
        enabled: true,
        webhookUrl,
        webhookSecret,
        cooldownSec: saved.webhookCooldownSec,
      },
      { bypassCooldown: true },
    );

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: "WEBHOOK_TEST_TRIGGERED",
      target: webhookUrl,
      ipAddress: extractClientIp(req),
      metadata: {
        ok: result.ok,
        status: result.status,
      },
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          code: "WEBHOOK_DELIVERY_FAILED",
          error: result.error || "Webhook target failed to accept test alert.",
          status: result.status,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      status: result.status,
      message: `Webhook test alert delivered (HTTP ${result.status ?? 200}).`,
    });
  } catch (err: unknown) {
    if (err instanceof SecretVaultError) {
      return NextResponse.json(
        { success: false, code: err.code, error: err.message },
        { status: 400 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Webhook test alert failed";
    return NextResponse.json(
      { success: false, code: "WEBHOOK_DELIVERY_FAILED", error: message },
      { status: 502 },
    );
  }
}
