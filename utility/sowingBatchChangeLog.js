const intQty = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function pushBatchChangeLog(batch, entry) {
  if (!batch) return;
  if (!Array.isArray(batch.changeLog)) batch.changeLog = [];
  batch.changeLog.push({
    at: entry.at || new Date(),
    by: entry.by || undefined,
    kind: entry.kind || "CHANGE",
    plants: Math.floor(Number(entry.plants) || 0),
    coverBefore: intQty(entry.coverBefore),
    coverAfter: intQty(entry.coverAfter),
    excessBefore: intQty(entry.excessBefore),
    excessAfter: intQty(entry.excessAfter),
    orderId: entry.orderId || undefined,
    orderCode: entry.orderCode || "",
    dispatchId: entry.dispatchId || undefined,
    reason: entry.reason || "",
  });
  if (batch.changeLog.length > 80) batch.changeLog.splice(0, batch.changeLog.length - 80);
}

function row(at, kind, plants, reason, extra = {}) {
  return {
    at: at || null,
    kind,
    plants: Math.floor(Number(plants) || 0),
    reason: reason || "",
    coverBefore: extra.coverBefore ?? null,
    coverAfter: extra.coverAfter ?? null,
    excessBefore: extra.excessBefore ?? null,
    excessAfter: extra.excessAfter ?? null,
    orderId: extra.orderId ? String(extra.orderId) : "",
    orderCode: extra.orderCode || "",
    dispatchId: extra.dispatchId ? String(extra.dispatchId) : "",
    by: extra.by ? String(extra.by) : "",
  };
}

/** Newest first. Dedicated changeLog merged with dispatch / history / destroy rows. */
export function listBatchChangeLog(batch) {
  if (!batch) return [];
  const out = [];
  for (const e of batch.changeLog || []) {
    out.push(
      row(e.at, e.kind, e.plants, e.reason, {
        coverBefore: e.coverBefore,
        coverAfter: e.coverAfter,
        excessBefore: e.excessBefore,
        excessAfter: e.excessAfter,
        orderId: e.orderId,
        orderCode: e.orderCode,
        dispatchId: e.dispatchId,
        by: e.by,
      })
    );
  }
  // Always include dispatchLog so RETURN / FREE rows stay visible after DISPATCH_TAKE changeLog exists.
  const changeKinds = new Set(
    (batch.changeLog || []).map((e) => `${e.kind}|${String(e.at || "")}|${Number(e.plants) || 0}`)
  );
  for (const d of batch.dispatchLog || []) {
    const bucket = d.bucket || "DISPATCH";
    const isReturn = bucket === "RETURN";
    const plantsAbs = Math.abs(Number(d.plants) || 0);
    // Skip duplicates already mirrored into changeLog (RETURN / DISPATCH_TAKE).
    const mirrorKey = `${isReturn ? "RETURN" : bucket}|${String(d.at || "")}|${
      isReturn ? plantsAbs : Number(d.plants) || 0
    }`;
    if (changeKinds.has(mirrorKey) || changeKinds.has(`DISPATCH_TAKE|${String(d.at || "")}|${Number(d.plants) || 0}`)) {
      continue;
    }
    // RETURN restores excess — show as +plants with a clear default reason.
    const plants = isReturn ? plantsAbs : Number(d.plants) || 0;
    const reason =
      String(d.reason || "").trim() ||
      (isReturn ? "Return from order" : bucket === "UNLOAD" ? "Vehicle unload" : "");
    out.push(
      row(d.at, bucket, plants, reason, {
        orderId: d.orderId,
        dispatchId: d.dispatchId,
        by: d.by,
      })
    );
  }
  if (!(batch.changeLog || []).length) {
    for (const h of batch.slotHistory || []) {
      out.push(row(h.at, "SLOT", h.plantsSowed, h.reason, { by: h.by }));
    }
    for (const x of batch.destroyLog || []) {
      out.push(row(x.at, "DESTROY", -(Number(x.plants) || 0), x.reason, { by: x.by }));
    }
    for (const a of batch.excessAllocations || []) {
      if (!(Number(a.plants) > 0)) continue;
      out.push(
        row(a.at, "ALLOC", -(Number(a.plants) || 0), "Excess allocated to order", {
          orderId: a.orderId,
          by: a.by,
        })
      );
    }
  }
  out.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return out;
}
