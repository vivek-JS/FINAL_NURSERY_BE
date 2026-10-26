import User from "../models/user.model.js";
import { persistInboxOnce } from "./notificationInbox.js";
import { sendCustomNotification } from "./pushNotification.js";

/** Super Admin plus anyone with canManageTrips (e.g. Neha — SALES with trips). */
const DISPATCH_ALERT_ROLES = ["SUPER_ADMIN", "SUPERADMIN"];
/** Shed loaders who must see "load more plants" after office +qty. */
const SHED_LOAD_ROLES = ["SECONDARY", "SECONDARY_ADMIN", "SHED", "SHED_OPS"];

function displaySlipNumber(raw) {
  return String(raw || "").replace(/^FS-/i, "").trim();
}

function vehicleLine(d = {}) {
  return [d.vehicleNumber, d.vehicleName, d.driverName].filter(Boolean).join(" · ");
}

async function tripManagers() {
  return User.find({
    isDisabled: { $ne: true },
    $or: [
      { role: { $in: DISPATCH_ALERT_ROLES } },
      { jobTitle: { $in: DISPATCH_ALERT_ROLES } },
      { canManageTrips: true },
    ],
  })
    .select("_id expoPushToken name")
    .lean();
}

async function shedLoadRecipients() {
  return User.find({
    isDisabled: { $ne: true },
    $or: [
      { role: { $in: SHED_LOAD_ROLES } },
      { jobTitle: { $in: SHED_LOAD_ROLES } },
    ],
  })
    .select("_id expoPushToken name role jobTitle")
    .lean();
}

async function notifyUsers(users, { title, body, type, data, dedupeKey }) {
  for (const user of users || []) {
    await persistInboxOnce({
      userId: user._id,
      title,
      body,
      type,
      data,
      dedupeKey,
    });
    if (user.expoPushToken) {
      await sendCustomNotification(user.expoPushToken, title, body, { type, ...data, dedupeKey });
    } else {
      console.log("[dispatchFleetNotify] inbox only (no Expo token)", String(user._id), user.name || "");
    }
  }
}

async function notifyTripManagers({ title, body, type, data, dedupeKey }) {
  await notifyUsers(await tripManagers(), { title, body, type, data, dedupeKey });
}

/** Trip managers + secondary shed so Flutter inbox shows load-more immediately. */
async function notifyTripManagersAndShed({ title, body, type, data, dedupeKey }) {
  const [managers, shed] = await Promise.all([tripManagers(), shedLoadRecipients()]);
  const seen = new Set();
  const merged = [];
  for (const u of [...managers, ...shed]) {
    const id = String(u._id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(u);
  }
  await notifyUsers(merged, { title, body, type, data, dedupeKey });
}

/** After a vehicle dispatch is committed. Also fires the slip notice when a slip was saved with it. */
export function notifyDispatchCreated(dispatch, slip) {
  void (async () => {
    try {
      if (!dispatch?._id) return;
      const tid = dispatch.transportId || "";
      const where = vehicleLine(dispatch);
      await notifyTripManagers({
        title: "नवीन डिस्पॅच · New dispatch",
        body: `#${tid}${where ? ` · ${where}` : ""}${slip ? "" : " · freight slip pending"}`,
        type: "dispatch",
        data: {
          dispatchId: String(dispatch._id),
          transportId: String(tid),
          kind: "dispatch_created",
        },
        dedupeKey: `dispatch:${dispatch._id}:created`,
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

/**
 * Office changed dispatch qty / orders after the vehicle already had shed load —
 * shed must load (or adjust) more crates.
 */
export function notifyDispatchLoadEdited(
  dispatch,
  { qtyDeltas = [], changedBy = "", editedAt = null } = {}
) {
  void (async () => {
    try {
      if (!dispatch?._id) return;
      const tid = dispatch.transportId || "";
      const where = vehicleLine(dispatch);
      const by = changedBy ? ` · ${changedBy}` : "";
      const parts = (qtyDeltas || [])
        .filter((d) => d && Number(d.delta) !== 0)
        .slice(0, 4)
        .map((d) => {
          const code = d.orderCode || d.orderId || "order";
          const sign = Number(d.delta) > 0 ? "+" : "";
          return `#${code} ${sign}${Number(d.delta).toLocaleString("en-IN")}`;
        });
      const plantsExtra = (qtyDeltas || []).reduce(
        (s, d) => s + Math.max(0, Number(d.delta) || 0),
        0
      );
      const detail = parts.length ? ` · ${parts.join(", ")}` : "";
      const plantsBit =
        plantsExtra > 0
          ? ` · +${plantsExtra.toLocaleString("en-IN")} plants`
          : "";
      const stamp = editedAt ? new Date(editedAt).getTime() : Date.now();
      await notifyTripManagersAndShed({
        title: "अधिक रोपे लोड करा · Load more plants",
        body: `#${tid}${where ? ` · ${where}` : ""}${detail}${plantsBit} — open Loaded tab → Load remaining${by}`,
        type: "dispatch",
        data: {
          dispatchId: String(dispatch._id),
          transportId: String(tid),
          kind: "load_edited",
          plantsExtra,
        },
        dedupeKey: `dispatch:${dispatch._id}:load-edited:${stamp}`,
      });
    } catch (err) {
      console.error("[dispatchFleetNotify] load edited:", err?.message || err);
    }
  })();
}
