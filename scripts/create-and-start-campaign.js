#!/usr/bin/env node
import fs from "fs";
import path from "path";
import axios from "axios";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.replace(/^--/, "");
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args[k] = v;
  }
}

const API = args.api || process.env.API_URL || "http://localhost:8000";
const TOKEN = args.token || process.env.API_TOKEN;
if (!TOKEN) {
  console.error("Provide --token or set API_TOKEN");
  process.exit(2);
}

async function main() {
  const name = args.name || "CLI Campaign";
  const message = args.message || "Hello from CLI";
  const farmerListIds = args.farmerListIds ? args.farmerListIds.split(",") : [];
  const profileId = args.profileId || null;
  const mediaIds = args.mediaIds ? args.mediaIds.split(",") : [];
  const excelPath = args.excel || null;

  // preview
  console.log("Previewing campaign dedupe...");
  let previewRes;
  if (excelPath) {
    // preview via upload endpoint
    const form = new FormData();
    form.append("file", fs.createReadStream(path.resolve(excelPath)));
    form.append("name", name);
    form.append("message", message);
    form.append("profileId", profileId);
    previewRes = await axios.post(`${API}/api/v1/campaigns/upload-and-create?preview=true`, form, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...form.getHeaders() },
    });
  } else {
    previewRes = await axios.post(`${API}/api/v1/campaigns?preview=true`, {
      name,
      message,
      farmerListIds,
      mediaIds,
      profileId,
    }, { headers: { Authorization: `Bearer ${TOKEN}` } });
  }
  console.log("Preview:", previewRes.data);

  console.log("Creating campaign...");
  let createRes;
  if (excelPath) {
    const form = new FormData();
    form.append("file", fs.createReadStream(path.resolve(excelPath)));
    form.append("name", name);
    form.append("message", message);
    form.append("profileId", profileId);
    createRes = await axios.post(`${API}/api/v1/campaigns/upload-and-create`, form, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...form.getHeaders() },
    });
  } else {
    createRes = await axios.post(`${API}/api/v1/campaigns`, { name, message, farmerListIds, mediaIds, profileId }, { headers: { Authorization: `Bearer ${TOKEN}` } });
  }
  const campaignId = createRes.data.campaignId;
  console.log("Campaign created:", campaignId);

  console.log("Starting campaign...");
  await axios.post(`${API}/api/v1/campaigns/${campaignId}/start`, {}, { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log("Campaign started.");
}

main().catch((e) => {
  console.error("Error:", e.response?.data || e.message || e);
  process.exit(1);
});

