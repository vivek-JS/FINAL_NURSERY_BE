import { isOfficeOrSuper } from "../../controllers/orderSowFromExcess.controller.js";
import { leftoverPreview, markSellable, transferRemaining } from "./leftoverSowing.service.js";

function denied(res) {
  return res.status(403).json({
    success: false,
    message: "Only office or a super admin can change leftover plants",
  });
}

function fail(res, err) {
  const code = Number(err?.statusCode) || 500;
  return res.status(code >= 400 && code < 600 ? code : 500).json({
    success: false,
    message: err?.message || "Could not save",
  });
}

/** GET /sowing/entries/:id/leftover — remaining, the next sowing, and the slot batch for destroy. */
export async function getLeftoverSowing(req, res) {
  try {
    if (!isOfficeOrSuper(req.user)) return denied(res);
    const data = await leftoverPreview(req.params.id);
    return res.json({ success: true, ...data });
  } catch (err) {
    return fail(res, err);
  }
}

/** POST /sowing/entries/:id/transfer-remaining — { plants } */
export async function postTransferRemaining(req, res) {
  try {
    if (!isOfficeOrSuper(req.user)) return denied(res);
    const data = await transferRemaining(req.params.id, req.body?.plants, req.user?._id || req.user?.id);
    return res.json({
      success: true,
      message: `Transferred ${data.plants} plants to ${data.targetRequestNumber || "the next sowing"}`,
      ...data,
    });
  } catch (err) {
    return fail(res, err);
  }
}

/** POST /sowing/entries/:id/mark-sellable — { plants } */
export async function postMarkSellable(req, res) {
  try {
    if (!isOfficeOrSuper(req.user)) return denied(res);
    const data = await markSellable(req.params.id, req.body?.plants, req.user?._id || req.user?.id);
    return res.json({
      success: true,
      message: `Marked ${data.plants} plants sellable`,
      ...data,
    });
  } catch (err) {
    return fail(res, err);
  }
}
