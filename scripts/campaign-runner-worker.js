#!/usr/bin/env node
/**
 * Campaign Runner Worker - Runs on user's computer (with display).
 * Polls the API for queued campaigns and runs them locally (Chrome opens).
 *
 * Setup:
 * 1. Set in .env or environment:
 *    - API_URL=https://api1.rambiotechplants.com (your production API)
 *    - CAMPAIGN_WORKER_SECRET=your-secret (same as on server)
 *    - MONGO_URL=your-production-mongodb-url (for the script to read campaigns)
 *
 * 2. Run: node scripts/campaign-runner-worker.js
 *
 * 3. Keep this window open. When user clicks "Send All" in the app, this will
 *    pick it up within ~15 seconds and Chrome will open.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_URL = (process.env.API_URL || "https://api1.rambiotechplants.com").replace(/\/+$/, "");
const WORKER_SECRET = process.env.CAMPAIGN_WORKER_SECRET;
const POLL_INTERVAL_MS = 15000;

if (!WORKER_SECRET) {
  console.error("Error: CAMPAIGN_WORKER_SECRET is required. Set it in .env (same value as on the server).");
  process.exit(1);
}

async function claimJob() {
  try {
    const res = await fetch(`${API_URL}/api/v1/campaign-worker/claim`, {
      headers: { "X-Campaign-Worker-Key": WORKER_SECRET, "X-Worker-Id": "local" },
    });
    const data = await res.json();
    if (data.success && data.job) return data.job;
    return null;
  } catch (e) {
    console.error("Claim error:", e.message);
    return null;
  }
}

async function completeJob(jobId, status = "completed", error = null) {
  try {
    await fetch(`${API_URL}/api/v1/campaign-worker/complete/${jobId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Campaign-Worker-Key": WORKER_SECRET,
      },
      body: JSON.stringify({ status, error }),
    });
  } catch (e) {
    console.error("Complete error:", e.message);
  }
}

async function runCampaign(job) {
  const scriptPath = path.join(__dirname, "run-campaign-now.js");
  const campaignId = job.campaignId?._id || job.campaignId;
  const args = [`--campaignId=${campaignId}`, `--delaySeconds=${job.delaySeconds || 10}`];
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath, ...args], {
      stdio: "inherit",
      env: process.env,
      cwd: path.join(__dirname, ".."),
    });
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => resolve(err ? 1 : 0));
  });
}

async function poll() {
  const job = await claimJob();
  if (!job) return;

  console.log("\n📬 Campaign received:", job.campaignId?.name || job.campaignId);
  console.log("   Opening Chrome...\n");

  const code = await runCampaign(job);
  await completeJob(job.id, code === 0 ? "completed" : "failed", code !== 0 ? `Exit code ${code}` : null);

  console.log("\n✅ Campaign finished. Waiting for next...\n");
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Campaign Runner - Keep this window open");
  console.log("  API:", API_URL);
  console.log("  When you click Send All in the app, Chrome will open here.");
  console.log("═══════════════════════════════════════════════════════\n");

  for (;;) {
    await poll();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
