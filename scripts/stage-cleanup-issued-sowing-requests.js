import dotenv from "dotenv";
import mongoose from "mongoose";

import SowingRequest from "../models/sowingRequest.model.js";
import InventoryOutward from "../models/inventoryOutward.model.js";
import PlantSlot from "../models/slots.model.js";

dotenv.config();

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);

const dryRun = hasArg("--dry-run");
const execute = hasArg("--execute");
const yes = hasArg("--yes");
const stageDb = hasArg("--stage-db");
const force = hasArg("--force");

if (!dryRun && !execute) {
  console.error("Pass either `--dry-run` or (`--execute --yes --stage-db`).");
  process.exit(1);
}

if (execute && !yes) {
  console.error("Refusing to execute without `--yes`.");
  process.exit(1);
}

if (execute && !stageDb) {
  console.error("Refusing to execute without `--stage-db`.");
  process.exit(1);
}

if (hasArg("--prod-db")) {
  console.error("This script is stage-only. Do not pass `--prod-db`.");
  process.exit(1);
}

const stageMongoUrl = process.env.STAGING_MONGO_URL || process.env.MONGO_URL;
if (!stageMongoUrl) {
  console.error("Missing STAGING_MONGO_URL or MONGO_URL in env.");
  process.exit(1);
}

if (!force && process.env.PROD_MONGO_URL && stageMongoUrl === process.env.PROD_MONGO_URL) {
  console.error("Resolved stage URL matches PROD_MONGO_URL. Aborting for safety. Use `--force` only if intentional.");
  process.exit(1);
}

const TARGET_STATUSES = ["issued", "processing"];
const SAMPLE_LIMIT = 25;

const toObjectIdSet = (values) => {
  const ids = new Set();
  for (const value of values || []) {
    const asString = String(value || "");
    if (mongoose.Types.ObjectId.isValid(asString)) ids.add(asString);
  }
  return ids;
};

const toObjectIds = (idSet) => [...idSet].map((id) => new mongoose.Types.ObjectId(id));

const describeDb = () => {
  const { name, host, port } = mongoose.connection;
  console.log(`DB: ${name}@${host}:${port}`);
};

const buildTargetSet = async () => {
  const requests = await SowingRequest.find({
    status: { $in: TARGET_STATUSES },
  })
    .select("_id requestNumber status outwardId linkedSlotIds requestedDate issuedDate sowingInProgress")
    .sort({ requestedDate: -1 })
    .lean();

  const requestIdSet = toObjectIdSet(requests.map((r) => r._id));
  const requestOutwardIdSet = toObjectIdSet(requests.map((r) => r.outwardId).filter(Boolean));
  const linkedSlotIdSet = toObjectIdSet(
    requests.flatMap((r) => (Array.isArray(r.linkedSlotIds) ? r.linkedSlotIds : []))
  );

  const requestIds = toObjectIds(requestIdSet);
  const requestOutwardIds = toObjectIds(requestOutwardIdSet);

  const linkedOutwards = await InventoryOutward.find({
    purpose: "production",
    $or: [
      { sowingRequestId: { $in: requestIds } },
      { _id: { $in: requestOutwardIds } },
    ],
  })
    .select("_id outwardNumber status purpose sowingRequestId linkedSlotIds")
    .lean();

  const outwardIdSet = toObjectIdSet(linkedOutwards.map((o) => o._id));
  for (const slotId of linkedOutwards.flatMap((o) => o.linkedSlotIds || [])) {
    if (mongoose.Types.ObjectId.isValid(String(slotId))) linkedSlotIdSet.add(String(slotId));
  }

  const outwardIds = toObjectIds(outwardIdSet);
  const slotIds = toObjectIds(linkedSlotIdSet);

  return {
    requests,
    linkedOutwards,
    requestIdSet,
    outwardIdSet,
    linkedSlotIdSet,
    requestIds,
    outwardIds,
    slotIds,
  };
};

const printPreflight = (target) => {
  console.log("\n=== PRE-FLIGHT ===");
  console.log(`Target request statuses: ${TARGET_STATUSES.join(", ")}`);
  console.log(`Requests matched: ${target.requests.length}`);
  console.log(`Production outwards linked: ${target.linkedOutwards.length}`);
  console.log(`Unique linked slots: ${target.linkedSlotIdSet.size}`);

  const sampleRequests = target.requests.slice(0, SAMPLE_LIMIT);
  if (sampleRequests.length > 0) {
    console.log("\nSample requests:");
    for (const req of sampleRequests) {
      console.log(
        `- ${req.requestNumber || "N/A"} id=${req._id} status=${req.status} outwardId=${req.outwardId || "N/A"} linkedSlots=${req.linkedSlotIds?.length || 0}`
      );
    }
  }

  const sampleOutwards = target.linkedOutwards.slice(0, SAMPLE_LIMIT);
  if (sampleOutwards.length > 0) {
    console.log("\nSample outwards:");
    for (const outward of sampleOutwards) {
      console.log(
        `- ${outward.outwardNumber || "N/A"} id=${outward._id} status=${outward.status} purpose=${outward.purpose} sowingRequestId=${outward.sowingRequestId || "N/A"}`
      );
    }
  }
};

const cleanupSlotReferences = async ({ requestIdSet, outwardIdSet, dryRunMode }) => {
  const requestIds = toObjectIds(requestIdSet);
  const outwardIds = toObjectIds(outwardIdSet);

  const slotDocs = await PlantSlot.find({
    $or: [
      { "subtypeSlots.slots.linkedSowingRequests": { $in: requestIds } },
      { "subtypeSlots.slots.sowingInProgress.sowingRequestId": { $in: requestIds } },
      { "subtypeSlots.slots.sowingInProgress.outwardId": { $in: outwardIds } },
    ],
  }).select("_id subtypeSlots");

  let docsTouched = 0;
  let slotsTouched = 0;
  let linkedRequestRefsRemoved = 0;
  let inProgressEntriesRemoved = 0;

  for (const doc of slotDocs) {
    let docChanged = false;

    for (const subtypeSlot of doc.subtypeSlots || []) {
      for (const slot of subtypeSlot.slots || []) {
        let slotChanged = false;

        if (Array.isArray(slot.linkedSowingRequests) && slot.linkedSowingRequests.length > 0) {
          const before = slot.linkedSowingRequests.length;
          slot.linkedSowingRequests = slot.linkedSowingRequests.filter(
            (id) => !requestIdSet.has(String(id))
          );
          const removed = before - slot.linkedSowingRequests.length;
          if (removed > 0) {
            linkedRequestRefsRemoved += removed;
            slotChanged = true;
          }
        }

        if (Array.isArray(slot.sowingInProgress) && slot.sowingInProgress.length > 0) {
          const before = slot.sowingInProgress.length;
          slot.sowingInProgress = slot.sowingInProgress.filter((entry) => {
            const requestRef = entry?.sowingRequestId ? String(entry.sowingRequestId) : null;
            const outwardRef = entry?.outwardId ? String(entry.outwardId) : null;
            if (requestRef && requestIdSet.has(requestRef)) return false;
            if (outwardRef && outwardIdSet.has(outwardRef)) return false;
            return true;
          });
          const removed = before - slot.sowingInProgress.length;
          if (removed > 0) {
            inProgressEntriesRemoved += removed;
            slotChanged = true;
          }
        }

        if (slotChanged) {
          if (Array.isArray(slot.sowingInProgress) && slot.sowingInProgress.length === 0) {
            slot.sowingCompleted = false;
            slot.sowingCompletedDate = null;
          }
          slotsTouched += 1;
          docChanged = true;
        }
      }
    }

    if (docChanged) {
      docsTouched += 1;
      if (!dryRunMode) {
        doc.markModified("subtypeSlots");
        await doc.save();
      }
    }
  }

  return {
    docsMatched: slotDocs.length,
    docsTouched,
    slotsTouched,
    linkedRequestRefsRemoved,
    inProgressEntriesRemoved,
  };
};

const verifyCleanup = async ({ requestIdSet, outwardIdSet }) => {
  const requestIds = toObjectIds(requestIdSet);
  const outwardIds = toObjectIds(outwardIdSet);

  const remainingRequests = await SowingRequest.countDocuments({
    status: { $in: TARGET_STATUSES },
    _id: { $in: requestIds },
  });

  const remainingOutwards = await InventoryOutward.countDocuments({
    purpose: "production",
    $or: [
      { _id: { $in: outwardIds } },
      { sowingRequestId: { $in: requestIds } },
    ],
  });

  const staleSlotDocs = await PlantSlot.countDocuments({
    $or: [
      { "subtypeSlots.slots.linkedSowingRequests": { $in: requestIds } },
      { "subtypeSlots.slots.sowingInProgress.sowingRequestId": { $in: requestIds } },
      { "subtypeSlots.slots.sowingInProgress.outwardId": { $in: outwardIds } },
    ],
  });

  return {
    remainingRequests,
    remainingOutwards,
    staleSlotDocs,
  };
};

async function main() {
  await mongoose.connect(stageMongoUrl, {
    serverSelectionTimeoutMS: 20_000,
  });

  describeDb();
  console.log(`Mode: ${dryRun ? "DRY RUN" : "EXECUTE"}`);

  const target = await buildTargetSet();
  printPreflight(target);

  if (target.requests.length === 0) {
    console.log("\nNo issued/processing sowing requests found. Nothing to clean.");
    await mongoose.disconnect();
    return;
  }

  const slotCleanupPreview = await cleanupSlotReferences({
    requestIdSet: target.requestIdSet,
    outwardIdSet: target.outwardIdSet,
    dryRunMode: true,
  });

  console.log("\nSlot cleanup impact:");
  console.log(`- PlantSlot docs matched: ${slotCleanupPreview.docsMatched}`);
  console.log(`- PlantSlot docs touched: ${slotCleanupPreview.docsTouched}`);
  console.log(`- Nested slots touched: ${slotCleanupPreview.slotsTouched}`);
  console.log(`- linkedSowingRequests refs removed: ${slotCleanupPreview.linkedRequestRefsRemoved}`);
  console.log(`- sowingInProgress entries removed: ${slotCleanupPreview.inProgressEntriesRemoved}`);

  if (dryRun) {
    const verify = await verifyCleanup({
      requestIdSet: target.requestIdSet,
      outwardIdSet: target.outwardIdSet,
    });
    console.log("\nVerification snapshot (expected non-zero in dry-run):");
    console.log(`- Remaining targeted requests: ${verify.remainingRequests}`);
    console.log(`- Remaining linked production outwards: ${verify.remainingOutwards}`);
    console.log(`- PlantSlot docs with stale refs: ${verify.staleSlotDocs}`);
    console.log("\nDRY RUN: no data modified.");
    console.log(
      "To execute on stage: node scripts/stage-cleanup-issued-sowing-requests.js --stage-db --execute --yes"
    );
    await mongoose.disconnect();
    return;
  }

  const outwardDeleteResult = await InventoryOutward.deleteMany({
    purpose: "production",
    $or: [
      { _id: { $in: target.outwardIds } },
      { sowingRequestId: { $in: target.requestIds } },
    ],
  });
  console.log(`\nDeleted production outwards: ${outwardDeleteResult.deletedCount}`);

  const requestDeleteResult = await SowingRequest.deleteMany({
    _id: { $in: target.requestIds },
    status: { $in: TARGET_STATUSES },
  });
  console.log(`Deleted sowing requests: ${requestDeleteResult.deletedCount}`);

  const slotCleanupResult = await cleanupSlotReferences({
    requestIdSet: target.requestIdSet,
    outwardIdSet: target.outwardIdSet,
    dryRunMode: false,
  });
  console.log(`PlantSlot docs touched: ${slotCleanupResult.docsTouched}`);
  console.log(`Nested slots touched: ${slotCleanupResult.slotsTouched}`);
  console.log(`linkedSowingRequests refs removed: ${slotCleanupResult.linkedRequestRefsRemoved}`);
  console.log(`sowingInProgress entries removed: ${slotCleanupResult.inProgressEntriesRemoved}`);

  const verify = await verifyCleanup({
    requestIdSet: target.requestIdSet,
    outwardIdSet: target.outwardIdSet,
  });
  console.log("\nVerification:");
  console.log(`- Remaining targeted requests: ${verify.remainingRequests}`);
  console.log(`- Remaining linked production outwards: ${verify.remainingOutwards}`);
  console.log(`- PlantSlot docs with stale refs: ${verify.staleSlotDocs}`);

  if (verify.remainingRequests > 0 || verify.remainingOutwards > 0 || verify.staleSlotDocs > 0) {
    throw new Error("Cleanup verification failed. Some targeted records or references still remain.");
  }

  console.log("\nCleanup completed successfully.");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Script failed:", error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect failure
  }
  process.exit(1);
});

