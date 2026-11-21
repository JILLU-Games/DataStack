import dns from "node:dns/promises";
import net from "node:net";

export class SSRFBlockedError extends Error {
  public readonly code = "SSRF_BLOCKED_HOST" as const;
  public readonly hostname: string;

  constructor(message: string, hostname: string) {
    super(message);
    this.name = "SSRFBlockedError";
    this.hostname = hostname;
  }
}

export interface OutboundUrlValidationOptions {
  allowPrivate?: boolean;
  env?: NodeJS.ProcessEnv;
  dnsLookup?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  fieldName?: string;
}

export interface OutboundUrlValidationResult {
  allowed: boolean;
  url?: URL;
  code?: "SSRF_BLOCKED_HOST" | "INVALID_URL";
  error?: string;
  hostname?: string;
}

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

function buildAlwaysBlockedBlockList(): net.BlockList {
  const list = new net.BlockList();
  // Unspecified / zero network
  list.addSubnet("0.0.0.0", 8, "ipv4");
  // Link-local & cloud metadata (AWS/GCP/Azure/Oracle 169.254.169.254)
  list.addSubnet("169.254.0.0", 16, "ipv4");
  // Multicast & reserved
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("240.0.0.0", 4, "ipv4");
  // IPv6 unspecified, link-local, multicast
  list.addAddress("::", "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  return list;
}

function buildPrivateBlockList(): net.BlockList {
  const list = new net.BlockList();
  // Loopback
  list.addSubnet("127.0.0.0", 8, "ipv4");
  // RFC 1918 private networks
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  // Carrier-grade NAT (RFC 6598)
  list.addSubnet("100.64.0.0", 10, "ipv4");
  // Benchmarking / documentation
  list.addSubnet("198.18.0.0", 15, "ipv4");
  // IPv6 loopback & Unique Local Addresses (ULA)
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  return list;
}

const ALWAYS_BLOCKED_IPS = buildAlwaysBlockedBlockList();
const PRIVATE_IPS = buildPrivateBlockList();

export function isPrivateOutboundUrlAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(env.DATASTACK_ALLOW_PRIVATE_URLS || "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function stripBracketsAndZone(rawHost: string): string {
  let host = String(rawHost || "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf("%");
  if (zoneIdx >= 0) {
    host = host.slice(0, zoneIdx);
  }
  // Remove trailing FQDN dot (e.g. "localhost.")
  return host.replace(/\.+$/, "");
}

function normalizeIpForCheck(rawIp: string): { ip: string; family: 4 | 6 } | null {
  const clean = stripBracketsAndZone(rawIp);
  if (!clean) return null;

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (clean.startsWith("::ffff:")) {
    const mapped = clean.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) {
      return { ip: mapped, family: 4 };
    }
    const hexParts = mapped.split(":");
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16);
      const lo = Number.parseInt(hexParts[1], 16);
      if (
        Number.isInteger(hi) &&
        Number.isInteger(lo) &&
        hi >= 0 &&
        hi <= 0xffff &&
        lo >= 0 &&
        lo <= 0xffff
      ) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        if (net.isIP(ipv4) === 4) {
          return { ip: ipv4, family: 4 };
        }
      }
    }
  }

  const family = net.isIP(clean);
  if (family === 4 || family === 6) {
    return { ip: clean, family };
  }
  return null;
}

export function checkIpAddressAllowed(
  rawIp: string,
  allowPrivate: boolean,
): { allowed: boolean; reason?: string } {
  const parsed = normalizeIpForCheck(rawIp);
  if (!parsed) {
    return { allowed: false, reason: `Invalid IP address '${rawIp}'.` };
  }
  const ipType = parsed.family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS_BLOCKED_IPS.check(parsed.ip, ipType)) {
    return {
      allowed: false,
      reason: `Address '${parsed.ip}' is in a restricted link-local/metadata/reserved network range.`,
    };
  }
  if (!allowPrivate && PRIVATE_IPS.check(parsed.ip, ipType)) {
    return {
      allowed: false,
      reason: `Address '${parsed.ip}' is a private or loopback network address (set DATASTACK_ALLOW_PRIVATE_URLS=true only if intentionally targeting a private host).`,
    };
  }
  return { allowed: true };
}

export function validateOutboundUrlSync(
  rawUrl: string,
  options: OutboundUrlValidationOptions = {},
): OutboundUrlValidationResult {
  const fieldName = options.fieldName || "URL";
  const allowPrivate =
    options.allowPrivate !== undefined
      ? options.allowPrivate
      : isPrivateOutboundUrlAllowed(options.env);

  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    return {
      allowed: false,
      code: "INVALID_URL",
      error: `${fieldName} is required.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      allowed: false,
      code: "INVALID_URL",
      error: `${fieldName} must be a valid http:// or https:// URL.`,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      allowed: false,
      code: "SSRF_BLOCKED_HOST",
      hostname: parsed.hostname,
      error: `${fieldName} must use http:// or https://.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      code: "SSRF_BLOCKED_HOST",
      hostname: parsed.hostname,
      error: `${fieldName} must not embed URL credentials.`,
    };
  }

  const host = stripBracketsAndZone(parsed.hostname);
  if (!host) {
    return {
      allowed: false,
      code: "INVALID_URL",
      error: `${fieldName} must include a valid hostname.`,
    };
  }

  if (ALWAYS_BLOCKED_HOSTNAMES.has(host)) {
    return {
      allowed: false,
      code: "SSRF_BLOCKED_HOST",
      hostname: host,
      error: `${fieldName} target '${host}' is blocked (cloud metadata/internal endpoint).`,
    };
  }

  // Literal IP check (covers IPv4, IPv6, and IPv4-mapped IPv6)
  const ipParsed = normalizeIpForCheck(host);
  if (ipParsed) {
    const ipCheck = checkIpAddressAllowed(host, allowPrivate);
    if (!ipCheck.allowed) {
      return {
        allowed: false,
        code: "SSRF_BLOCKED_HOST",
        hostname: host,
        error: `${fieldName} blocked: ${ipCheck.reason}`,
      };
    }
    return { allowed: true, url: parsed, hostname: host };
  }

  // Non-IP hostname checks
  if (!allowPrivate) {
    if (
      PRIVATE_HOSTNAMES.has(host) ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      !host.includes(".")
    ) {
      return {
        allowed: false,
        code: "SSRF_BLOCKED_HOST",
        hostname: host,
        error: `${fieldName} target '${host}' is a private/internal hostname (set DATASTACK_ALLOW_PRIVATE_URLS=true only for trusted private hosts).`,
      };
    }
  }

  return { allowed: true, url: parsed, hostname: host };
}

export async function validateOutboundUrlAsync(
  rawUrl: string,
  options: OutboundUrlValidationOptions = {},
): Promise<OutboundUrlValidationResult> {
  const syncResult = validateOutboundUrlSync(rawUrl, options);
  if (!syncResult.allowed || !syncResult.url || !syncResult.hostname) {
    return syncResult;
  }

  const host = syncResult.hostname;
  const fieldName = options.fieldName || "URL";
  const allowPrivate =
    options.allowPrivate !== undefined
      ? options.allowPrivate
      : isPrivateOutboundUrlAllowed(options.env);

  // Skip DNS resolution if already validated as a literal IP
  if (normalizeIpForCheck(host)) {
    return syncResult;
  }

  try {
    const lookupFn =
      options.dnsLookup ||
      ((h: string) => dns.lookup(h, { all: true, verbatim: true }));
    const records = await lookupFn(host);
    for (const rec of records) {
      const check = checkIpAddressAllowed(rec.address, allowPrivate);
      if (!check.allowed) {
        return {
          allowed: false,
          code: "SSRF_BLOCKED_HOST",
          hostname: host,
          error: `${fieldName} hostname '${host}' resolved to a blocked address: ${check.reason}`,
        };
      }
    }
  } catch {
    // DNS resolution failure (e.g. ENOTFOUND/EAI_AGAIN) will be handled cleanly by the caller or fetch()
  }

  return syncResult;
}
