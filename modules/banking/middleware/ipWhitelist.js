import { getIciciCorporateConfig } from "../config/iciciCorporate.config.js";
import { getBankingLogger } from "../utils/logger.js";

/**
 * Optional IP whitelist for banking endpoints.
 * Set ICICI_IP_WHITELIST=203.0.113.0/24,198.51.100.5 in production.
 * ICICI callback IPs should be added per bank documentation.
 */
export function bankingIpWhitelist(req, res, next) {
  const cfg = getIciciCorporateConfig();
  if (!cfg.ipWhitelist.length) return next();

  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "";

  const allowed = cfg.ipWhitelist.some((entry) => {
    if (entry.includes("/")) {
      return ipInCidr(clientIp, entry);
    }
    return clientIp === entry || clientIp.endsWith(entry);
  });

  if (!allowed) {
    getBankingLogger().warn("Banking IP whitelist rejected", { clientIp });
    return res.status(403).json({ success: false, message: "IP not allowed" });
  }

  return next();
}

function ipInCidr(ip, cidr) {
  try {
    const [range, bits] = cidr.split("/");
    const mask = ~(2 ** (32 - Number(bits)) - 1);
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
  } catch {
    return false;
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}
