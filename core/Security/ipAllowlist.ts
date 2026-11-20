import net from "node:net";

/**
 * Per-Client IP / CIDR Allowlist & Token Expiration Validator (V2-Phase-02)
 */

export function stripIpv6MappedPrefix(ip: string): string {
  let trimmed = String(ip || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    trimmed = trimmed.slice(1, trimmed.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, trimmed.lastIndexOf(":"));
  }
  const pctIndex = trimmed.indexOf("%");
  if (pctIndex !== -1) {
    trimmed = trimmed.slice(0, pctIndex);
  }
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const candidate = trimmed.slice(7);
    if (net.isIPv4(candidate)) {
      return candidate;
    }
  }
  return trimmed;
}

export function ipv4ToUint32(ip: string): number | null {
  const clean = stripIpv6MappedPrefix(ip);
  if (!net.isIPv4(clean)) return null;
  const parts = clean.split(".").map((octet) => Number(octet));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  return (
    (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0)
  );
}

export function parseAllowedIpsList(raw?: string | null): string[] {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function validateAllowedIpsInput(
  raw: unknown,
): { valid: true; normalized: string } | { valid: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { valid: true, normalized: "" };
  }
  if (typeof raw !== "string") {
    return { valid: false, error: "allowedIps must be a string." };
  }
  if (raw.length > 2048) {
    return {
      valid: false,
      error: "allowedIps cannot exceed 2048 characters.",
    };
  }

  const entries = parseAllowedIpsList(raw);
  if (entries.length === 0) {
    return { valid: true, normalized: "" };
  }
  if (entries.length > 64) {
    return {
      valid: false,
      error: "allowedIps cannot contain more than 64 IP/CIDR entries.",
    };
  }

  const normalizedEntries: string[] = [];
  for (const entry of entries) {
    if (entry === "*") {
      normalizedEntries.push("*");
      continue;
    }

    if (entry.includes("/")) {
      const [ipPart, prefixPart, ...extra] = entry.split("/");
      if (extra.length > 0 || !ipPart || !prefixPart || !/^\d+$/.test(prefixPart)) {
        return {
          valid: false,
          error: `Invalid CIDR entry '${entry}'. Expected format like 203.0.113.0/24.`,
        };
      }
      const prefix = Number(prefixPart);
      const cleanIp = stripIpv6MappedPrefix(ipPart);
      if (net.isIPv4(cleanIp)) {
        if (prefix < 0 || prefix > 32) {
          return {
            valid: false,
            error: `Invalid IPv4 CIDR prefix in '${entry}' (must be 0..32).`,
          };
        }
        normalizedEntries.push(`${cleanIp}/${prefix}`);
        continue;
      }
      if (net.isIPv6(cleanIp)) {
        if (prefix < 0 || prefix > 128) {
          return {
            valid: false,
            error: `Invalid IPv6 CIDR prefix in '${entry}' (must be 0..128).`,
          };
        }
        normalizedEntries.push(`${cleanIp.toLowerCase()}/${prefix}`);
        continue;
      }
      return {
        valid: false,
        error: `Invalid IP address in CIDR entry '${entry}'.`,
      };
    }

    const cleanIp = stripIpv6MappedPrefix(entry);
    const ipVersion = net.isIP(cleanIp);
    if (ipVersion === 4) {
      normalizedEntries.push(cleanIp);
    } else if (ipVersion === 6) {
      normalizedEntries.push(cleanIp.toLowerCase());
    } else {
      return {
        valid: false,
        error: `Invalid IP or CIDR entry '${entry}'.`,
      };
    }
  }

  return {
    valid: true,
    normalized: Array.from(new Set(normalizedEntries)).join(", "),
  };
}

export function isClientIpAllowed(
  clientIp: string,
  allowedIpsRaw?: string | null,
): boolean {
  const entries = parseAllowedIpsList(allowedIpsRaw);
  if (entries.length === 0) {
    return true;
  }

  const cleanClientIp = stripIpv6MappedPrefix(clientIp);
  if (!cleanClientIp || cleanClientIp === "unknown") {
    return entries.includes("*");
  }

  const clientFamily = net.isIP(cleanClientIp);
  const clientIpv4Int = ipv4ToUint32(cleanClientIp);
  const isLoopbackClient =
    cleanClientIp === "127.0.0.1" || cleanClientIp.toLowerCase() === "::1";

  for (const rule of entries) {
    if (rule === "*") return true;

    if (rule.includes("/")) {
      const [ruleIpRaw, prefixRaw] = rule.split("/");
      const ruleIp = stripIpv6MappedPrefix(ruleIpRaw);
      const prefix = Number(prefixRaw);
      const ruleFamily = net.isIP(ruleIp);

      if (
        clientFamily === 4 &&
        ruleFamily === 4 &&
        Number.isInteger(prefix) &&
        prefix >= 0 &&
        prefix <= 32
      ) {
        if (prefix === 0) return true;
        try {
          const bl = new net.BlockList();
          bl.addSubnet(ruleIp, prefix, "ipv4");
          if (bl.check(cleanClientIp, "ipv4")) {
            return true;
          }
        } catch {
          const ruleIpv4Int = ipv4ToUint32(ruleIp);
          if (clientIpv4Int !== null && ruleIpv4Int !== null) {
            const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
            if ((clientIpv4Int & mask) >>> 0 === (ruleIpv4Int & mask) >>> 0) {
              return true;
            }
          }
        }
      } else if (
        clientFamily === 6 &&
        ruleFamily === 6 &&
        Number.isInteger(prefix) &&
        prefix >= 0 &&
        prefix <= 128
      ) {
        if (prefix === 0) return true;
        try {
          const bl = new net.BlockList();
          bl.addSubnet(ruleIp, prefix, "ipv6");
          if (bl.check(cleanClientIp, "ipv6")) {
            return true;
          }
        } catch {
          // ignore malformed IPv6 subnet
        }
      }
      continue;
    }

    const cleanRule = stripIpv6MappedPrefix(rule);
    if (cleanRule.toLowerCase() === cleanClientIp.toLowerCase()) {
      return true;
    }
    if (
      isLoopbackClient &&
      (cleanRule === "127.0.0.1" || cleanRule.toLowerCase() === "::1")
    ) {
      return true;
    }
  }

  return false;
}

export function validateClientExpiresAtInput(
  raw: unknown,
): { valid: true; iso: string | null } | { valid: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { valid: true, iso: null };
  }
  if (typeof raw !== "string") {
    return {
      valid: false,
      error: "expiresAt must be an ISO timestamp string or null.",
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, iso: null };
  }
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) {
    return {
      valid: false,
      error: "expiresAt must be a valid ISO-8601 date or timestamp.",
    };
  }
  return { valid: true, iso: new Date(parsedMs).toISOString() };
}

export function isClientTokenExpired(
  expiresAt?: string | null,
  nowMs = Date.now(),
): boolean {
  if (!expiresAt || typeof expiresAt !== "string") return false;
  const trimmed = expiresAt.trim();
  if (!trimmed) return false;
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return false;
  return nowMs >= parsedMs;
}
