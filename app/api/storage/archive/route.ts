import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { recordAdminAuditLogAsync } from "@/core/auth/auditLog";
import { SecretVaultError } from "@/core/Security/secretVault";
import { CSVStorageManager } from "@/core/Storage/csvStorage";
import {
  buildS3ObjectKey,
  normalizeS3EndpointUrl,
  uploadFileToS3,
} from "@/core/Storage/s3Archive";
import { extractClientIp, requireAdminApiSession } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const auth = await requireAdminApiSession(req, { minRole: "operator" });
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
    const settings = await SettingsManager.getSettingsAsync();
    const s3Config = await SettingsManager.getDecryptedS3ConfigAsync();

    if (!s3Config.bucket.trim() || !s3Config.accessKeyId.trim() || !s3Config.secretAccessKey.trim()) {
      return NextResponse.json(
        {
          success: false,
          code: "S3_INVALID_CONFIG",
          error: "Configure S3 Bucket, Access Key ID, and Secret Access Key before archiving.",
        },
        { status: 400 },
      );
    }

    try {
      normalizeS3EndpointUrl(s3Config.endpoint, s3Config.region);
    } catch (urlErr: unknown) {
      return NextResponse.json(
        {
          success: false,
          code: "S3_INVALID_CONFIG",
          error: urlErr instanceof Error ? urlErr.message : "Invalid S3 endpoint URL.",
        },
        { status: 400 },
      );
    }

    const pruneAfterUpload = body.pruneAfterUpload === true;
    const rawOlderThanDays =
      typeof body.olderThanDays === "number" && Number.isFinite(body.olderThanDays)
        ? Math.max(0, Math.floor(body.olderThanDays))
        : settings.autoPruneDays > 0
          ? settings.autoPruneDays
          : 0;
    const shouldCompressFirst =
      body.compressFirst !== false && settings.compressAfterDays > 0;

    let compressedCount = 0;
    if (shouldCompressFirst) {
      compressedCount = await CSVStorageManager.compressOldPartitionsAsync(
        settings.compressAfterDays,
      );
    }

    const archiveResult =
      await CSVStorageManager.pruneOrArchiveExpiredPartitionsAsync(
        settings.autoPruneDays,
        {
          archiveOnlyWithoutDelete: !pruneAfterUpload,
          maxCutoffDays: rawOlderThanDays,
          beforeDeleteFile: async (file) => {
            const key = buildS3ObjectKey(
              s3Config.prefix,
              file.clientId,
              file.filename,
            );
            const uploadRes = await uploadFileToS3(
              s3Config,
              file.filePath,
              key,
            );
            if (!uploadRes.ok) {
              throw new Error(
                uploadRes.error || `Failed to upload ${file.filename}`,
              );
            }
          },
        },
      );

    if (
      archiveResult.errors.length > 0 &&
      archiveResult.archivedCount === 0
    ) {
      SettingsManager.triggerWebhookAlert({
        event: "S3_ARCHIVE_FAILED",
        severity: "critical",
        title: "S3 Cold Archive Upload Failed",
        message: `Manual S3 archive failed: ${archiveResult.errors[0]}`,
        details: { errorCount: archiveResult.errors.length },
      });
      return NextResponse.json(
        {
          success: false,
          code: "S3_ARCHIVE_FAILED",
          error: archiveResult.errors[0],
          compressedCount,
          ...archiveResult,
        },
        { status: 502 },
      );
    }

    if (archiveResult.errors.length > 0) {
      SettingsManager.triggerWebhookAlert({
        event: "S3_ARCHIVE_FAILED",
        severity: "warning",
        title: "Partial S3 Cold Archive Errors",
        message: `S3 archive encountered ${archiveResult.errors.length} error(s): ${archiveResult.errors[0]}`,
        details: { errorCount: archiveResult.errors.length },
      });
    }

    await recordAdminAuditLogAsync({
      actorEmail: auth.auth.session.email,
      actorRole: auth.auth.session.role || "owner",
      action: "S3_ARCHIVE_TRIGGERED",
      target: s3Config.bucket,
      ipAddress: extractClientIp(req),
      metadata: {
        archivedCount: archiveResult.archivedCount,
        prunedCount: archiveResult.prunedCount,
        compressedCount,
        pruneAfterUpload,
      },
    });

    return NextResponse.json({
      success: archiveResult.errors.length === 0,
      compressedCount,
      ...archiveResult,
    });
  } catch (err: unknown) {
    if (err instanceof SecretVaultError) {
      return NextResponse.json(
        { success: false, code: err.code, error: err.message },
        { status: 400 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Manual S3 archive failed";
    SettingsManager.triggerWebhookAlert({
      event: "S3_ARCHIVE_FAILED",
      severity: "critical",
      title: "S3 Cold Archive Upload Failed",
      message,
    });
    return NextResponse.json(
      { success: false, code: "S3_ARCHIVE_FAILED", error: message },
      { status: 500 },
    );
  }
}
