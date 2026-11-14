import User from "../models/user.model.js";
import { sendFcmNotification } from "./fcmPush.js";
import { persistInboxOnce } from "./notificationInbox.js";
import { sendCustomNotification } from "./pushNotification.js";

/** Super Admin plus anyone with canManageTrips (e.g. Neha — SALES with trips). */
const DISPATCH_ALERT_ROLES = ["SUPER_ADMIN", "SUPERADMIN"];

function displaySlipNumber(raw) {
  return String(raw || "").replace(/^FS-/i, "").trim();
}

function vehicleLine(d = {}) {
  return [d.vehicleNumber, d.vehicleName, d.driverName].filter(Boolean).join(" · ");
}

function crateTotal(plant) {
  const crates = Array.isArray(plant?.crates) ? plant.crates : [];
  let n = 0;
  for (const crate of crates) {
    const direct = Number(crate?.crateCount || 0);
    if (direct > 0) {
      n += direct;
      continue;
    }
    for (const detail of crate?.crateDetails || []) {
      n += Number(detail?.crateCount || 0);
    }
  }
  return n;
}

function plainVariety(name) {
  return String(name || "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s*->\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line per variety, with the office crate count. */
export function varietyLines(dispatch) {
  const plants = Array.isArray(dispatch?.plantsDetails) ? dispatch.plantsDetails : [];
  const lines = [];
  for (const plant of plants) {
    const name = plainVariety(plant?.name);
    if (!name) continue;
    const crates = crateTotal(plant);
    const qty = Number(plant?.totalPlants || plant?.quantity || 0);
    const bits = [name];
    if (crates > 0) bits.push(`${crates} crate${crates === 1 ? "" : "s"}`);
    if (qty > 0) bits.push(`${qty} plants`);
    lines.push(bits.join(" · "));
  }
  return lines;
}

export function dispatchNoticeBody(dispatch, { slipPending = false } = {}) {
  const head = [`#${dispatch?.transportId || ""}`, vehicleLine(dispatch)]
    .filter((part) => part && part !== "#")
    .join(" · ");
  return [head, ...varietyLines(dispatch), slipPending ? "freight slip pending" : ""]
    .filter(Boolean)
    .join("\n");
}

async function tripManagers({ includeSecondary = false } = {}) {
  const roles = includeSecondary
    ? [...DISPATCH_ALERT_ROLES, "SECONDARY"]
    : DISPATCH_ALERT_ROLES;
  return User.find({
    isDisabled: { $ne: true },
    $or: [
      { role: { $in: roles } },
      { jobTitle: { $in: roles } },
      { canManageTrips: true },
    ],
  })
    .select("_id expoPushToken fcmToken name")
    .lean();
}

async function notifyTripManagers({ title, body, type, data, dedupeKey, includeSecondary = false }) {
  const users = await tripManagers({ includeSecondary });
  for (const user of users) {
    await persistInboxOnce({
      userId: user._id,
      title,
      body,
      type,
      data,
      dedupeKey,
    });
    const pushData = { type, ...data, dedupeKey };
    let sent = false;
    if (type !== "freight_slip" && user.fcmToken) {
      try {
        sent = await sendFcmNotification({ token: user.fcmToken, title, body, data: pushData });
      } catch (err) {
        console.error("[dispatchFleetNotify] fcm failed:", err?.message || err);
      }
    }
    if (user.expoPushToken) {
      try {
        await sendCustomNotification(user.expoPushToken, title, body, pushData);
        sent = true;
      } catch (err) {
        console.error("[dispatchFleetNotify] expo failed:", err?.message || err);
      }
    }
    if (!sent) {
      console.log("[dispatchFleetNotify] inbox only (no phone token)", String(user._id), user.name || "");
    }
  }
}

/** After a vehicle dispatch is committed. Also fires the slip notice when a slip was saved with it. */
export function notifyDispatchCreated(dispatch, slip) {
  void (async () => {
    try {
      if (!dispatch?._id) return;
      const tid = dispatch.transportId || "";
      await notifyTripManagers({
        title: "नवीन डिस्पॅच · New dispatch",
        body: dispatchNoticeBody(dispatch, { slipPending: !slip }),
        type: "dispatch",
        data: {
          dispatchId: String(dispatch._id),
          transportId: String(tid),
          kind: "dispatch_created",
        },
        dedupeKey: `dispatch:${dispatch._id}:created`,
        includeSecondary: true,
      });
      if (slip) await notifyFreightSlipCreated(slip, dispatch);
    } catch (err) {
      console.error("[dispatchFleetNotify] dispatch created:", err?.message || err);
    }
  })();
}

/** First tentative driver slip for a dispatch. */
export function notifyFreightSlipCreated(slip, dispatch = {}) {
  void (async () => {
    try {
      if (!slip?._id) return;
      const number = displaySlipNumber(slip.slipNumber) || "slip";
      const tid = slip.transportId || dispatch.transportId || "";
      const where = vehicleLine({ ...dispatch, ...slip });
      await notifyTripManagers({
        title: "भाडे पावती · Driver slip",
        body: `${number}${tid ? ` · #${tid}` : ""}${where ? ` · ${where}` : ""}`,
        type: "freight_slip",
        data: {
          dispatchId: String(slip.dispatchId || dispatch._id || ""),
          slipId: String(slip._id),
          slipNumber: number,
          kind: "slip_created",
        },
        dedupeKey: `freight-slip:${slip._id}:created`,
      });
    } catch (err) {
      console.error("[dispatchFleetNotify] slip created:", err?.message || err);
    }
  })();
}

export function isNewFreightSlip(slip) {
  const history = Array.isArray(slip?.history) ? slip.history : [];
  return history.length === 1 && history[0]?.action === "TENTATIVE_CREATED";
}

/**
 * Shed loaded more crates onto a vehicle that already had plants on board.
 * (First load stays silent here — create + DISPATCHED alerts already cover that.)
 */
export function notifyVehicleLoadMore(dispatch, { plantsAdded = 0, loadedTotal = 0, changedBy = "" } = {}) {
  void (async () => {
    try {
      if (!dispatch?._id || plantsAdded < 1) return;
      const tid = dispatch.transportId || "";
      const where = vehicleLine(dispatch);
      const by = changedBy ? ` · ${changedBy}` : "";
      await notifyTripManagers({
        title: "अधिक लोड · More crates loaded",
        body: `#${tid}${where ? ` · ${where}` : ""} · +${Number(plantsAdded).toLocaleString("en-IN")} plants${
          loadedTotal > 0 ? ` (total ${Number(loadedTotal).toLocaleString("en-IN")})` : ""
        }${by}`,
        type: "dispatch",
        data: {
          dispatchId: String(dispatch._id),
          transportId: String(tid),
          kind: "load_more",
          plantsAdded: Number(plantsAdded) || 0,
          loadedTotal: Number(loadedTotal) || 0,
        },
        dedupeKey: `dispatch:${dispatch._id}:load-more:${Number(loadedTotal) || plantsAdded}`,
      });
    } catch (err) {
      console.error("[dispatchFleetNotify] load more:", err?.message || err);
    }
  })();
}

function plantChangePhrase(qtyDeltas) {
  let up = 0;
  let down = 0;
  for (const row of qtyDeltas || []) {
    const n = Math.round(Number(row?.delta) || 0);
    if (n > 0) up += n;
    else if (n < 0) down += Math.abs(n);
  }
  const fmt = (n) => n.toLocaleString("en-IN");
  if (up > 0 && down > 0) return `${fmt(up)} रोपे वाढवा · ${fmt(down)} रोपे कमी करा`;
  if (up > 0) return `${fmt(up)} रोपे वाढवा`;
  if (down > 0) return `${fmt(down)} रोपे कमी करा`;
  return "";
}

/**
 * Office changed the plant count on a vehicle the shed already has.
 * The full-screen card says how many plants to add or remove.
 */
export function notifyDispatchLoadEdited(
  dispatch,
  { qtyDeltas = [], changedBy = "", editedAt = null } = {}
) {
  void (async () => {
    try {
      if (!dispatch?._id) return;
      const tid = dispatch.transportId || "";
      const phrase = plantChangePhrase(qtyDeltas);
      const title = phrase || "लोड संपादित";
      const by = changedBy ? ` · ${changedBy}` : "";
      const stamp = editedAt ? new Date(editedAt).getTime() : Date.now();
      const net = (qtyDeltas || []).reduce((s, d) => s + (Number(d?.delta) || 0), 0);
      await notifyTripManagers({
        title,
        body: [dispatchNoticeBody(dispatch), phrase].filter(Boolean).join("\n") + by,
        type: "dispatch",
        data: {
          dispatchId: String(dispatch._id),
          transportId: String(tid),
          kind: "load_edited",
          plantsDelta: String(net),
        },
        dedupeKey: `dispatch:${dispatch._id}:load-edited:${stamp}`,
        includeSecondary: true,
      });
    } catch (err) {
      console.error("[dispatchFleetNotify] load edited:", err?.message || err);
    }
  })();
}
