import crypto from "node:crypto";
import fs from "node:fs";

export interface S3ArchiveConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3OperationResult {
  ok: boolean;
  status?: number;
  endpoint?: string;
  bucket?: string;
  key?: string;
  etag?: string;
  code?: "S3_INVALID_CONFIG" | "S3_CONNECTION_FAILED" | "S3_ARCHIVE_FAILED";
  error?: string;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3Path(rawPath: string): string {
  return rawPath
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

export function buildS3ObjectKey(
  prefix: string,
  clientId: string,
  filename: string,
): string {
  const cleanPrefix = String(prefix || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const cleanClient = String(clientId || "unknown")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const cleanFile = String(filename || "")
    .trim()
    .replace(/^\/+/, "");
  return [cleanPrefix, cleanClient, cleanFile].filter(Boolean).join("/");
}

export function normalizeS3EndpointUrl(
  endpoint: string,
  region: string,
): { url: URL; region: string } {
  const trimmedRegion = String(region || "").trim() || "auto";
  const trimmedEndpoint = String(endpoint || "").trim().replace(/\/+$/, "");

  if (trimmedEndpoint) {
    const withProtocol = /^https?:\/\//i.test(trimmedEndpoint)
      ? trimmedEndpoint
      : `https://${trimmedEndpoint}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("S3 endpoint must use http:// or https://");
    }
    return { url: parsed, region: trimmedRegion };
  }

  if (trimmedRegion === "auto") {
    throw new Error(
      "S3 Endpoint URL is required when Region is set to 'auto' (e.g. Cloudflare R2 or MinIO).",
    );
  }
  return {
    url: new URL(`https://s3.${trimmedRegion}.amazonaws.com`),
    region: trimmedRegion,
  };
}

export function signS3Request(params: {
  method: "GET" | "HEAD" | "PUT";
  endpointUrl: URL;
  bucket: string;
  objectKey?: string;
  queryParams?: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHashHex: string;
  contentType?: string;
  now?: Date;
}): { targetUrl: string; headers: Record<string, string> } {
  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const basePath = params.endpointUrl.pathname.replace(/\/+$/, "");
  const bucketPart = encodeRfc3986(params.bucket.trim());
  const keyPart = params.objectKey ? `/${encodeS3Path(params.objectKey)}` : "";
  const canonicalUri = `${basePath}/${bucketPart}${keyPart}`.replace(
    /\/{2,}/g,
    "/",
  );

  const queryEntries = Object.entries(params.queryParams ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const canonicalQueryString = queryEntries
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const hostHeader = params.endpointUrl.host;
  const headerMap: Record<string, string> = {
    host: hostHeader,
    "x-amz-content-sha256": params.payloadHashHex,
    "x-amz-date": amzDate,
  };
  if (params.contentType) {
    headerMap["content-type"] = params.contentType;
  }

  const sortedHeaderKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((key) => `${key}:${headerMap[key].trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    params.payloadHashHex,
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const targetUrl = `${params.endpointUrl.origin}${canonicalUri}${
    canonicalQueryString ? `?${canonicalQueryString}` : ""
  }`;

  return {
    targetUrl,
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": params.payloadHashHex,
      ...(params.contentType ? { "content-type": params.contentType } : {}),
      Authorization: authorization,
    },
  };
}

function validateS3Config(config: S3ArchiveConfig): string | null {
  if (!config.bucket?.trim()) return "S3 Bucket name is required.";
  if (!config.accessKeyId?.trim()) return "S3 Access Key ID is required.";
  if (!config.secretAccessKey?.trim()) return "S3 Secret Access Key is required.";
  return null;
}

export async function testS3Connection(
  config: S3ArchiveConfig,
): Promise<S3OperationResult> {
  const validationError = validateS3Config(config);
  if (validationError) {
    return {
      ok: false,
      code: "S3_INVALID_CONFIG",
      error: validationError,
    };
  }

  try {
    const { url, region } = normalizeS3EndpointUrl(
      config.endpoint,
      config.region,
    );
    const signed = signS3Request({
      method: "GET",
      endpointUrl: url,
      bucket: config.bucket.trim(),
      queryParams: { "list-type": "2", "max-keys": "1" },
      region,
      accessKeyId: config.accessKeyId.trim(),
      secretAccessKey: config.secretAccessKey,
      payloadHashHex: sha256Hex(""),
    });

    const response = await fetch(signed.targetUrl, {
      method: "GET",
      headers: signed.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const bodyPreview = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        endpoint: url.origin,
        bucket: config.bucket.trim(),
        code: "S3_CONNECTION_FAILED",
        error: `S3 endpoint returned HTTP ${response.status}${
          bodyPreview ? `: ${bodyPreview.slice(0, 180)}` : ""
        }`,
      };
    }

    return {
      ok: true,
      status: response.status,
      endpoint: url.origin,
      bucket: config.bucket.trim(),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      code: "S3_CONNECTION_FAILED",
      error:
        err instanceof Error ? err.message : "Unable to reach S3 endpoint",
    };
  }
}

export async function uploadFileToS3(
  config: S3ArchiveConfig,
  localFilePath: string,
  objectKey: string,
): Promise<S3OperationResult> {
  const validationError = validateS3Config(config);
  if (validationError) {
    return {
      ok: false,
      code: "S3_INVALID_CONFIG",
      error: validationError,
      key: objectKey,
    };
  }

  try {
    const { url, region } = normalizeS3EndpointUrl(
      config.endpoint,
      config.region,
    );
    const bodyBuffer = await fs.promises.readFile(localFilePath);
    const payloadHashHex = sha256Hex(bodyBuffer);
    const contentType = localFilePath.endsWith(".gz")
      ? "application/gzip"
      : "text/csv; charset=utf-8";

    const signed = signS3Request({
      method: "PUT",
      endpointUrl: url,
      bucket: config.bucket.trim(),
      objectKey,
      region,
      accessKeyId: config.accessKeyId.trim(),
      secretAccessKey: config.secretAccessKey,
      payloadHashHex,
      contentType,
    });

    const response = await fetch(signed.targetUrl, {
      method: "PUT",
      headers: {
        ...signed.headers,
        "content-length": String(bodyBuffer.byteLength),
      },
      body: new Uint8Array(bodyBuffer),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const bodyPreview = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        endpoint: url.origin,
        bucket: config.bucket.trim(),
        key: objectKey,
        code: "S3_ARCHIVE_FAILED",
        error: `S3 upload failed with HTTP ${response.status}${
          bodyPreview ? `: ${bodyPreview.slice(0, 180)}` : ""
        }`,
      };
    }

    return {
      ok: true,
      status: response.status,
      endpoint: url.origin,
      bucket: config.bucket.trim(),
      key: objectKey,
      etag: response.headers.get("etag") ?? undefined,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      key: objectKey,
      code: "S3_ARCHIVE_FAILED",
      error: err instanceof Error ? err.message : "S3 upload request failed",
    };
  }
}
