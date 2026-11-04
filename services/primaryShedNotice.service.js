import User from "../models/user.model.js";
import { persistInboxOnce } from "../utility/notificationInbox.js";
import {
  formatPrimaryShedNotice,
  formatSecondaryReceiveNotice,
  isPrimaryStaff,
  isSecondaryStaff,
} from "../utility/primaryShedNotice.js";

function queueError(scope, err) {
  console.error(`[${scope}]`, err?.message || err);
}

async function phonesOf(users, message) {
  if (process.env.WHATSAPP_ALERTS_ENABLED !== "true") return;
  const { sendWhatsAppMessage } = await import("./whatsappAlertService.js");
  for (const user of users) {
    if (!user.phoneNumber) continue;
    await sendWhatsAppMessage(user.phoneNumber, message);
  }
}

async function staff(jobTitle, keep) {
  const users = await User.find({ jobTitle, isDisabled: { $ne: true } })
    .select("phoneNumber jobTitle role")
    .lean();
  return users.filter(keep);
}

/**
 * One inbox row and one WhatsApp per Primary user.
 * Secondary users are not queried and cannot match isPrimaryStaff.
 */
export async function notifyPrimaryShed(reason = "primary") {
  if (process.env.PRIMARY_SHED_NOTICE === "false") return { skipped: true };
  try {
    const { listPrimaryBoard } = await import("./primaryBatchLedger.service.js");
    const board = await listPrimaryBoard();
    const body = formatPrimaryShedNotice(board);
    const users = await staff("PRIMARY", isPrimaryStaff);
    const dedupeKey = `primary-shed:${reason}:${new Date().toISOString().slice(0, 16)}`;
    for (const user of users) {
      await persistInboxOnce({
        userId: user._id,
        title: "Primary shed",
        body,
        type: "primary_shed",
        data: { audience: "PRIMARY", reason },
        dedupeKey,
      });
    }
    await phonesOf(users, body);
    return { recipients: users.length };
  } catch (err) {
    queueError("primary notice", err);
    return { ok: false };
  }
}

/** Secondary learns about plants only after Primary sends them. */
export async function notifySecondaryReceive({ batchId, batchNumber, plant, size, plants, primaryOutwardId }) {
  if (process.env.PRIMARY_SHED_NOTICE === "false") return { skipped: true };
  try {
    const body = formatSecondaryReceiveNotice({ batchNumber, plant, size, plants });
    const users = await staff("SECONDARY", (user) => isSecondaryStaff(user) && !isPrimaryStaff(user));
    const dedupeKey = `secondary-receive:${primaryOutwardId || batchId}`;
    for (const user of users) {
      await persistInboxOnce({
        userId: user._id,
        title: "Plants from primary",
        body,
        type: "secondary_receive",
        data: { audience: "SECONDARY", batchId: batchId ? String(batchId) : "", primaryOutwardId: primaryOutwardId ? String(primaryOutwardId) : "" },
        dedupeKey,
      });
    }
    await phonesOf(users, body);
    return { recipients: users.length };
  } catch (err) {
    queueError("secondary receive notice", err);
    return { ok: false };
  }
}
