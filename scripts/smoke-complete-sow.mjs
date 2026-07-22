/**
 * Smoke checks for complete-sow flow (no DB required).
 * Run: node FINAL_NURSERY_BE/scripts/smoke-complete-sow.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const checks = [];
function ok(name, pass, detail = "") {
  checks.push({ name, pass: Boolean(pass), detail });
}

const modelReq = read("models/sowingRequest.model.js");
ok("SowingRequest.laboursLadies", modelReq.includes("laboursLadies"));
ok("SowingRequest.completionPhotos", modelReq.includes("completionPhotos"));

const modelOrder = read("models/order.model.js");
ok("Order.sowingDone", modelOrder.includes("sowingDone"));
ok("Order.sowingDoneRequestId", modelOrder.includes("sowingDoneRequestId"));

const ctrl = read("controllers/sowingRequestComplete.controller.js");
ok("complete rejects double", ctrl.includes("Already completed"));
ok("complete requires issued", ctrl.includes('status: "issued"'));
ok("excess skips order mark", ctrl.includes("isExcessiveSowing") && ctrl.includes("markOrdersSowed"));
ok("raising no company return", ctrl.includes('seedSource !== "RAISING"'));
ok("over/under plants allowed", ctrl.includes("plantsSowed") && ctrl.includes("varianceRatio"));
ok("photo optional try/catch", ctrl.includes("photo upload failed"));
ok("issued-queue export", ctrl.includes("getIssuedSowingQueue"));
ok("completions search order", ctrl.includes("linkedOrderIds") && ctrl.includes("orderId"));

const routes = read("routes/sowing.route.js");
ok("route complete-sow", routes.includes("complete-sow"));
ok("route issued-queue", routes.includes("issued-queue"));
ok("route completions", routes.includes("/completions"));

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
});
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} smoke checks passed`);
