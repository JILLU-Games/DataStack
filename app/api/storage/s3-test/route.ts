import { SettingsManager } from "@/core/adminSettings/settingsManager";
import {
  decryptSecret,
  SecretVaultError,
} from "@/core/Security/secretVault";
import {
  testS3Connection,
  type S3ArchiveConfig,
} from "@/core/Storage/s3Archive";
import { requireAdminApiSession } from "@/lib/adminAuth";
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
    const draftSecret =
      typeof body.s3SecretAccessKey === "string" &&
      body.s3SecretAccessKey.trim().length > 0
        ? body.s3SecretAccessKey.trim()
        : "";

    let effectiveSecret = draftSecret;
    if (!effectiveSecret && !body.clearS3SecretKey) {
      effectiveSecret = decryptSecret(saved.s3SecretAccessKeyEnc);
    }

    const config: S3ArchiveConfig = {
      endpoint:
        typeof body.s3Endpoint === "string"
          ? body.s3Endpoint.trim()
          : saved.s3Endpoint,
      region:
        typeof body.s3Region === "string" && body.s3Region.trim()
          ? body.s3Region.trim()
          : saved.s3Region || "auto",
      bucket:
        typeof body.s3Bucket === "string"
          ? body.s3Bucket.trim()
          : saved.s3Bucket,
      prefix:
        typeof body.s3Prefix === "string"
          ? body.s3Prefix.trim()
          : saved.s3Prefix,
      accessKeyId:
        typeof body.s3AccessKeyId === "string"
          ? body.s3AccessKeyId.trim()
          : saved.s3AccessKeyId,
      secretAccessKey: effectiveSecret,
    };

    const result = await testS3Connection(config);
    if (!result.ok) {
      const isClientError =
        result.code === "S3_INVALID_CONFIG" ||
        result.code === "SSRF_BLOCKED_HOST" ||
        result.code === "INVALID_URL";
      return NextResponse.json(
        {
          success: false,
          code: result.code || "S3_CONNECTION_FAILED",
          error: result.error || "S3 connectivity check failed.",
          ...(result.status !== undefined ? { s3Status: result.status } : {}),
        },
        { status: isClientError ? 400 : 502 },
      );
    }

    return NextResponse.json({
      success: true,
      endpoint: result.endpoint,
      bucket: result.bucket,
      status: result.status,
    });
  } catch (err: unknown) {
    if (err instanceof SecretVaultError) {
      return NextResponse.json(
        { success: false, code: err.code, error: err.message },
        { status: 400 },
      );
    }
    const message =
      err instanceof Error ? err.message : "S3 connectivity check failed";
    return NextResponse.json(
      { success: false, code: "S3_CONNECTION_FAILED", error: message },
      { status: 500 },
    );
  }
}
