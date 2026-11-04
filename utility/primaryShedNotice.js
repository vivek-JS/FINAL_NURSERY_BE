import AppError from "./appError.js";
import { traySplit } from "./primaryLedgerMath.js";

export function normalizeJob(value) {
  return String(value || "").toUpperCase().replace(/[\s_-]+/g, "");
}

export function isSecondaryStaff(user) {
  const job = normalizeJob(user?.jobTitle);
  const role = normalizeJob(user?.role);
  return job === "SECONDARY" || job.startsWith("SECONDARY") || role === "SECONDARY";
}

/** Primary job only. Used for the notice and WhatsApp, not for who may open the shed. */
export function isPrimaryStaff(user) {
  if (isSecondaryStaff(user)) return false;
  const job = normalizeJob(user?.jobTitle);
  const role = normalizeJob(user?.role);
  return job === "PRIMARY" || job.startsWith("PRIMARY") || role === "PRIMARY";
}

export function isSuperAdmin(user) {
  const job = normalizeJob(user?.jobTitle);
  const role = normalizeJob(user?.role);
  return job === "SUPERADMIN" || role === "SUPERADMIN";
}

/** Primary job and Super Admin can open the shed. Secondary cannot. */
export function canUsePrimaryShed(user) {
  return isPrimaryStaff(user) || isSuperAdmin(user);
}

export function requirePrimaryJob(req, res, next) {
  if (canUsePrimaryShed(req.user)) return next();
  return next(new AppError("Primary shed is only for the Primary job", 403));
}

function fmtDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function batchLabel(row) {
  return [row.batchNumber, row.plant].filter(Boolean).join(" · ") || "Batch";
}

function section(title, lines) {
  const body = lines.length ? lines.slice(0, 8).map((line) => `• ${line}`).join("\n") : "None";
  const more = lines.length > 8 ? `\n• and ${lines.length - 8} more` : "";
  return `${title}\n${body}${more}`;
}

/**
 * One Primary message: lab lines still to receive, ready dates, and bottles not sown.
 */
export function formatPrimaryShedNotice({ toReceive = [], batches = [] } = {}) {
  const labLines = toReceive.map((line) => {
    const split = traySplit(line.bottles);
    const trays =
      split.incompleteBottles > 0
        ? `${split.completeTrays} complete trays + incomplete tray of ${split.incompleteBottles}`
        : `${split.completeTrays} complete trays`;
    return `${batchLabel(line)} · ${line.size || "R1"} · ${split.bottles} bottles · ${trays}`;
  });

  const ready = [];
  const bottles = [];
  for (const batch of batches) {
    for (const sow of batch.sows || []) {
      if ((sow.plantsNotSent || 0) < 1) continue;
      ready.push(
        `${batchLabel(batch)} · ${sow.size || "R1"} · ready ${fmtDay(sow.readyDate)} · ${sow.plantsNotSent} plants not sent`
      );
    }
    for (const size of batch.sizes || []) {
      if ((size.bottlesLeft || 0) < 1) continue;
      const split = traySplit(size.bottlesLeft);
      bottles.push(`${batchLabel(batch)} · ${size.size} · ${split.bottles} bottles not sown`);
    }
  }

  return [
    "Primary shed",
    section("Lab outward", labLines),
    section("Ready date", ready),
    section("Bottles not sown", bottles),
  ].join("\n\n");
}

export function formatSecondaryReceiveNotice({ batchNumber, plant, size, plants } = {}) {
  const who = [batchNumber, plant].filter(Boolean).join(" · ") || "Batch";
  return ["Primary sent plants", who, `${size || "R1"} · ${Math.floor(Number(plants) || 0)} plants`, "Receive them in Secondary."].join(
    "\n"
  );
}

/** Same rule the secondary dashboard uses for an incoming primary send. */
export function secondaryCanReceive(line) {
  if (!line) return false;
  const avail = Math.floor(Number(line.availableQuantity ?? line.totalQuantity) || 0);
  return avail > 0 && (line.transferStatus || "available") !== "fully_transferred";
}
