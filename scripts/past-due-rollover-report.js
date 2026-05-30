/**
 * Stage vs prod — all orders on expired slots vs orders to move (by status).
 *   node scripts/past-due-rollover-report.js
 *   node scripts/past-due-rollover-report.js --open
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { execSync } from "child_process";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(beRoot, ".env") });

const shouldOpen = process.argv.includes("--open");
const planScript = path.join(__dirname, "past-due-rollover-plan-json.js");

const STATUS_ORDER = [
  "PENDING",
  "PROCESSING",
  "ACCEPTED",
  "ASSIGNED",
  "FARM_READY",
  "READY_FOR_DISPATCH",
  "DISPATCH_PROCESS",
  "PARTIALLY_COMPLETED",
  "DISPATCHED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
];

async function fetchPlan(flag) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [planScript, flag],
    { cwd: beRoot, maxBuffer: 64 * 1024 * 1024, env: process.env }
  );
  return JSON.parse(stdout);
}

function mergeStatuses(stage, prod) {
  const set = new Set();
  for (const r of stage.breakdown.allOnExpiredByStatus || []) set.add(r.status);
  for (const r of prod.breakdown.allOnExpiredByStatus || []) set.add(r.status);
  for (const r of stage.breakdown.toMoveByStatus || []) set.add(r.status);
  for (const r of prod.breakdown.toMoveByStatus || []) set.add(r.status);
  return [...set].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function rowMap(rows) {
  return new Map((rows || []).map((r) => [r.status, r]));
}

function buildHtml(stage, prod) {
  const statuses = mergeStatuses(stage, prod);
  const stageAll = rowMap(stage.breakdown.allOnExpiredByStatus);
  const prodAll = rowMap(prod.breakdown.allOnExpiredByStatus);
  const stageMove = rowMap(stage.breakdown.toMoveByStatus);
  const prodMove = rowMap(prod.breakdown.toMoveByStatus);

  const D = {
    asOf: stage.asOf,
    statuses,
    allOrdersStage: statuses.map((s) => stageAll.get(s)?.orders || 0),
    allOrdersProd: statuses.map((s) => prodAll.get(s)?.orders || 0),
    moveOrdersStage: statuses.map((s) => stageMove.get(s)?.orders || 0),
    moveOrdersProd: statuses.map((s) => prodMove.get(s)?.orders || 0),
    stage: {
      allOnExpired: stage.allOrdersOnExpiredSlots,
      eligible: stage.ordersLoaded,
      toMove: stage.ordersToMove,
      plantsToMove: stage.plantsToMove,
    },
    prod: {
      allOnExpired: prod.allOrdersOnExpiredSlots,
      eligible: prod.ordersLoaded,
      toMove: prod.ordersToMove,
      plantsToMove: prod.plantsToMove,
    },
    stageRows: stage.ordersToMoveList,
    prodRows: prod.ordersToMoveList,
  };

  const summaryTable = statuses
    .map((s) => {
      const sa = stageAll.get(s)?.orders || 0;
      const pa = prodAll.get(s)?.orders || 0;
      const sm = stageMove.get(s)?.orders || 0;
      const pm = prodMove.get(s)?.orders || 0;
      if (!sa && !pa && !sm && !pm) return "";
      return `<tr><td>${s}</td><td>${sa}</td><td>${sm}</td><td>${pa}</td><td>${pm}</td></tr>`;
    })
    .join("");

  const tableRows = (rows) =>
    rows
      .map(
        (r) =>
          `<tr><td>${r.publicOrderId ?? r.orderId}</td><td>${r.orderStatus}</td><td>${r.plants}</td><td>${r.fromSlot}</td><td>${r.toSlot}</td></tr>`
      )
      .join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Past-due rollover — all vs to move</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#111;color:#eee;padding:1.25rem 1.5rem 2rem}
h1{font-size:1.35rem;margin:0 0 .25rem}.sub{color:#888;font-size:.85rem;margin-bottom:1rem}
.note{background:#1a2a1a;border:1px solid #2a4a2a;border-radius:8px;padding:.6rem .9rem;font-size:.8rem;margin-bottom:1rem;color:#b8d4b8}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:1.25rem}
.kpi{background:#1c1c1c;border-radius:8px;padding:.75rem 1rem}
.kpi label{font-size:.7rem;color:#888;text-transform:uppercase;display:block;margin-bottom:.35rem}
.kpi .row{font-size:.85rem;line-height:1.6}.n{font-weight:700}.stage{color:#3b82f6}.prod{color:#f59e0b}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem}
@media(max-width:800px){.charts{grid-template-columns:1fr}}
.card{background:#1c1c1c;border-radius:8px;padding:.75rem;margin-bottom:1rem}.card h2{font-size:.9rem;margin:0 0 .5rem}
.wrap{height:280px;position:relative}
table{width:100%;border-collapse:collapse;font-size:.78rem}
th,td{padding:.4rem .5rem;border-bottom:1px solid #333;text-align:left}
th{color:#888}td.num{text-align:right}
.tabs{margin:.5rem 0}.tab{background:#333;border:0;color:#fff;padding:.35rem .75rem;border-radius:6px;margin-right:.4rem;cursor:pointer}
.tab.on{background:#3b82f6}.tab.p.on{background:#f59e0b;color:#111}.hid{display:none}
</style></head><body>
<h1>Past-due slot orders — all vs to move</h1>
<p class="sub">As of ${D.asOf}</p>
<p class="note"><strong>All on expired</strong> = every order still booked on a past-due slot (any status). <strong>To move</strong> = open pipeline, non-dealer, has a next slot (rollover will run). Table below lists every order <em>to move</em>.</p>
<div class="kpis">
  <div class="kpi"><label>All orders on expired slots</label>
    <div class="row"><span class="stage n">${D.stage.allOnExpired}</span> stage · <span class="prod n">${D.prod.allOnExpired}</span> prod</div></div>
  <div class="kpi"><label>Eligible (open pipeline, non-dealer)</label>
    <div class="row"><span class="stage n">${D.stage.eligible}</span> stage · <span class="prod n">${D.prod.eligible}</span> prod</div></div>
  <div class="kpi"><label>Will move (rollover)</label>
    <div class="row"><span class="stage n">${D.stage.toMove}</span> stage · <span class="prod n">${D.prod.toMove}</span> prod</div></div>
</div>
<div class="charts">
  <div class="card"><h2>Stage — all on expired vs to move</h2><div class="wrap"><canvas id="c1"></canvas></div></div>
  <div class="card"><h2>Prod — all on expired vs to move</h2><div class="wrap"><canvas id="c2"></canvas></div></div>
</div>
<div class="card">
  <h2>By status (orders count)</h2>
  <table>
    <thead><tr><th>Status</th><th class="num">Stage all</th><th class="num">Stage move</th><th class="num">Prod all</th><th class="num">Prod move</th></tr></thead>
    <tbody>${summaryTable}</tbody>
    <tfoot><tr><th>Total</th><td class="num">${D.stage.allOnExpired}</td><td class="num">${D.stage.toMove}</td><td class="num">${D.prod.allOnExpired}</td><td class="num">${D.prod.toMove}</td></tr></tfoot>
  </table>
</div>
<div class="card">
  <h2>All orders to move (full list)</h2>
  <div class="tabs">
    <button class="tab on" data-t="s">Stage (${D.stage.toMove})</button>
    <button class="tab p" data-t="p">Prod (${D.prod.toMove})</button>
  </div>
  <div id="ts"><table><thead><tr><th>Order #</th><th>Status</th><th>Plants</th><th>From</th><th>To</th></tr></thead><tbody>${tableRows(D.stageRows)}</tbody></table></div>
  <div id="tp" class="hid"><table><thead><tr><th>Order #</th><th>Status</th><th>Plants</th><th>From</th><th>To</th></tr></thead><tbody>${tableRows(D.prodRows)}</tbody></table></div>
</div>
<script>
const D=${JSON.stringify(D)};
const opt={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#aaa'}}},scales:{x:{ticks:{color:'#aaa',maxRotation:45}},y:{ticks:{color:'#aaa'},beginAtZero:true}}};
const mk=(id,labels,allData,moveData)=>new Chart(document.getElementById(id),{type:'bar',data:{labels,datasets:[
  {label:'All on expired slot',data:allData,backgroundColor:'#64748b'},
  {label:'To move',data:moveData,backgroundColor:id==='c1'?'#3b82f6':'#f59e0b'}
]},options:opt});
mk('c1',D.statuses,D.allOrdersStage,D.moveOrdersStage);
mk('c2',D.statuses,D.allOrdersProd,D.moveOrdersProd);
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');const p=b.dataset.t==='p';document.getElementById('ts').classList.toggle('hid',p);document.getElementById('tp').classList.toggle('hid',!p);});
</script></body></html>`;
}

async function main() {
  const t0 = Date.now();
  console.log("[report] fetching stage + prod in parallel...");
  const [stage, prod] = await Promise.all([
    fetchPlan("--stage"),
    fetchPlan("--prod"),
  ]);
  console.log(`[report] fetched in ${Date.now() - t0}ms\n`);

  const outDir = path.join(beRoot, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "past-due-rollover-stage-vs-prod.html");
  fs.writeFileSync(htmlPath, buildHtml(stage, prod));

  console.log(`Stage: ${stage.allOrdersOnExpiredSlots} all on expired | ${stage.ordersLoaded} eligible | ${stage.ordersToMove} to move`);
  console.log(`Prod:  ${prod.allOrdersOnExpiredSlots} all on expired | ${prod.ordersLoaded} eligible | ${prod.ordersToMove} to move`);
  console.log(`\nHTML: ${htmlPath}`);
  console.log("\nProd by status (all → to move):");
  const prodAll = rowMap(prod.breakdown.allOnExpiredByStatus);
  const prodMove = rowMap(prod.breakdown.toMoveByStatus);
  for (const s of mergeStatuses(stage, prod)) {
    const a = prodAll.get(s)?.orders || 0;
    const m = prodMove.get(s)?.orders || 0;
    if (a || m) console.log(`  ${s}: ${a} all → ${m} to move`);
  }

  if (shouldOpen) {
    try {
      execSync(`open "${htmlPath}"`);
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
