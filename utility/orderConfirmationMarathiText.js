/**
 * Free-text Marathi rebuild of WATI order_placed / payment templates,
 * using the same fields as buildOrderConfirmationTemplateParameters.
 * For Baileys linked-device send — not a Meta template drop-in.
 */

import moment from "moment";

const fmt = (n) =>
  Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const rupee = (n) => `₹${fmt(Math.round(Number(n) || 0))}`;

function istDateLabel(value) {
  if (value == null || value === "") return "नंतर कळेल";
  const m = moment(value);
  if (!m.isValid()) {
    const asStr = String(value).trim();
    return asStr || "नंतर कळेल";
  }
  return m.utcOffset(330).format("DD-MM-YYYY");
}

function pick(...vals) {
  for (const v of vals) {
    const s = v == null ? "" : String(v).trim();
    if (s) return s;
  }
  return "";
}

/**
 * @param {"placed"|"payment"} kind
 * @param {object} sendTo — farmer (or dealer recipient): name, mobile, village/taluka/district
 * @param {object} orderDetails — same shape used for WATI order confirmation
 * @returns {string}
 */
export function formatOrderConfirmationMarathiText(kind, sendTo, orderDetails = {}) {
  const name = pick(sendTo?.name, "शेतकरी") || "शेतकरी";
  const orderId = pick(
    orderDetails.publicOrderCode,
    orderDetails.orderId != null ? String(orderDetails.orderId) : "",
    "—"
  );
  const village = pick(sendTo?.village, orderDetails.village, "—");
  const taluka = pick(
    sendTo?.talukaName,
    sendTo?.taluka,
    orderDetails.taluka,
    "—"
  );
  const district = pick(
    sendTo?.districtName,
    sendTo?.district,
    orderDetails.district,
    "—"
  );
  const mobile = pick(sendTo?.mobileNumber, sendTo?.phoneNumber, "—");
  const plant = pick(orderDetails.plantName, "—");
  const subtype = pick(orderDetails.plantSubtype, "—");
  const plants = fmt(orderDetails.numberOfPlants);
  const rate = rupee(orderDetails.rate);
  const total = rupee(orderDetails.totalAmount);
  const advance = rupee(orderDetails.advanceAmount);
  const remaining = rupee(orderDetails.remainingAmount);
  const booking = istDateLabel(
    orderDetails.orderBookingDate || orderDetails.createdAt
  );
  const delivery = istDateLabel(orderDetails.deliveryDate);

  const title =
    kind === "payment"
      ? "✅ *पेमेंट स्वीकारले — ऑर्डर अपडेट*"
      : "🌱 *ऑर्डर बुकिंग कन्फर्म*";

  const intro =
    kind === "payment"
      ? `नमस्कार ${name},\nआपल्या ऑर्डरसाठी पेमेंट स्वीकारण्यात आले आहे.`
      : `नमस्कार ${name},\nआपली रोपे बुकिंग यशस्वी झाली आहे.`;

  return [
    title,
    "",
    intro,
    "",
    `🧾 *ऑर्डर क्र.:* ${orderId}`,
    `📍 *गाव:* ${village}`,
    `🗺 *तालुका:* ${taluka}`,
    `🏛 *जिल्हा:* ${district}`,
    `📞 *मोबाइल:* ${mobile}`,
    "",
    `🌿 *पीक / व्हॅरायटी:* ${plant} / ${subtype}`,
    `📦 *एकूण रोपे:* ${plants}`,
    `💰 *दर:* ${rate}`,
    `🧮 *एकूण रक्कम:* ${total}`,
    `✅ *आगाऊ / भरलेले:* ${advance}`,
    `⏳ *बाकी:* ${remaining}`,
    "",
    `📅 *बुकिंग दिनांक:* ${booking}`,
    `🚚 *डिलिव्हरी दिनांक:* ${delivery}`,
    "",
    "_राम बायोटेक प्लांट्स_",
  ].join("\n");
}

/** Payment-accepted variant (same body fields as placed). */
export function formatPaymentAcceptedMarathiText(sendTo, orderDetails) {
  return formatOrderConfirmationMarathiText("payment", sendTo, orderDetails);
}

/** Order-placed variant. */
export function formatOrderPlacedMarathiText(sendTo, orderDetails) {
  return formatOrderConfirmationMarathiText("placed", sendTo, orderDetails);
}

/**
 * Admin big-order alert (create or qty update). Same facts as English sendBigOrderAlert.
 * @param {object} order
 * @param {{ qty?: number, threshold?: number, isUpdate?: boolean, plantSubtype?: string }} [opts]
 */
export function formatBigOrderMarathiText(order = {}, opts = {}) {
  const plants = Number(opts.qty ?? order.numberOfPlants ?? 0) || 0;
  const extra = Number(order.additionalPlants) || 0;
  const totalPlants =
    Number(order.totalPlants) > 0 ? Number(order.totalPlants) : plants + extra;
  const qty = Number(opts.qty ?? totalPlants) || 0;
  const threshold =
    opts.threshold ??
    parseInt(process.env.WHATSAPP_ALERT_BIG_ORDER_QTY || "10000", 10);
  const farmerName = pick(order?.farmer?.name, order?.orderFor?.name, "—");
  const village = pick(order?.farmer?.village, order?.orderFor?.village, "—");
  const salesPersonName = pick(order?.salesPerson?.name, "—");
  const plantSubtype = pick(opts.plantSubtype, "—");
  const orderNo = pick(
    order?.publicOrderCode,
    order?.orderId != null ? String(order.orderId) : "",
    "—"
  );
  const rate = Number(order?.rate) || 0;
  const amount =
    order?.totalAmount != null
      ? Number(order.totalAmount)
      : qty && rate
        ? qty * rate
        : 0;
  const delivery = istDateLabel(order?.deliveryDate);
  const title = opts.isUpdate
    ? "🔥 *मोठी ऑर्डर अपडेट*"
    : "🔥 *मोठी ऑर्डर अलर्ट*";

  return [
    title,
    `_रोपे संख्या ≥ ${fmt(threshold)}_`,
    "",
    `🧾 *ऑर्डर क्र.:* ${orderNo}`,
    `👤 *शेतकरी:* ${farmerName}`,
    `📍 *गाव:* ${village}`,
    `🌿 *पीक / व्हॅरायटी:* ${plantSubtype}`,
    `📦 *रोपे:* *${fmt(qty)}*`,
    `🧮 *रक्कम:* ${rupee(amount)}`,
    `🚚 *डिलिव्हरी:* ${delivery}`,
    `👔 *सेल्स:* ${salesPersonName}`,
    "",
    "_राम बायोटेक प्लांट्स — Admin_",
  ].join("\n");
}

/**
 * Admin order-updated alert (Marathi header + change lines).
 * @param {object} order
 * @param {string} changedBy
 * @param {string[]} changeLines
 * @param {object} [existingDoc]
 */
export function formatOrderUpdatedMarathiText(
  order = {},
  changedBy = "Unknown",
  changeLines = [],
  existingDoc = null
) {
  const src = existingDoc || order;
  const farmerName = pick(
    src?.farmer?.name,
    src?.orderFor?.name,
    order?.farmer?.name,
    "—"
  );
  const village = pick(
    src?.farmer?.village,
    src?.orderFor?.village,
    order?.orderFor?.village,
    "—"
  );
  const taluka = pick(
    src?.farmer?.talukaName,
    src?.farmer?.taluka,
    src?.orderFor?.taluka,
    "—"
  );
  const orderNo = pick(
    order?.publicOrderCode,
    order?.orderId != null ? String(order.orderId) : "",
    existingDoc?.orderId != null ? String(existingDoc.orderId) : "",
    "—"
  );

  return [
    "🟡 *ऑर्डर अपडेट*",
    `🧾 *ऑर्डर क्र.:* ${orderNo}`,
    `👤 *शेतकरी:* ${farmerName}`,
    `📍 *गाव:* ${village} | *तालुका:* ${taluka}`,
    `✏️ *अपडेट करणारे:* ${changedBy}`,
    "*बदल:*",
    ...(changeLines.length ? changeLines : ["  • अपडेट"]),
    "",
    "_राम बायोटेक प्लांट्स — Admin_",
  ].join("\n");
}
