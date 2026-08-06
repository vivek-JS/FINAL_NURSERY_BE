/** Absolute URL for payment receipt / screenshot (Cloudinary or /uploads path). */
export function resolvePaymentMediaUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  const base = (
    process.env.BASE_URL ||
    process.env.API_BASE_URL ||
    "https://api1.rambiotechplants.com"
  )
    .trim()
    .replace(/\/+$/, "");
  return s.startsWith("/") ? `${base}${s}` : `${base}/${s}`;
}

/** Receipt photos on payment row + optional order-level screenshots. */
export function collectPaymentAttachmentUrls(payment, orderScreenshots = []) {
  const fromPayment = Array.isArray(payment?.receiptPhoto) ? payment.receiptPhoto : [];
  const fromOrder = Array.isArray(orderScreenshots) ? orderScreenshots : [];
  const seen = new Set();
  const out = [];
  for (const raw of [...fromPayment, ...fromOrder]) {
    const url = resolvePaymentMediaUrl(raw);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export function formatAttachmentLinksForWhatsApp(urls = [], { max = 3 } = {}) {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, max);
  if (!list.length) return [];
  return list.map((url, i) => `📎 Receipt ${list.length > 1 ? i + 1 : ""}: ${url}`.trim());
}
