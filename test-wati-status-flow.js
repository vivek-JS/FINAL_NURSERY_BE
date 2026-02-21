import fetch from "node-fetch";

const API_BASE = process.env.API_BASE || "http://localhost:8000";
const phoneWaId = "917588686452"; // full waId
const phoneLocal = "7588686452"; // mobileNumber stored in DB

async function run() {
  console.log("1) Fetching farmer by phone:", phoneLocal);
  const farmerRes = await fetch(`${API_BASE}/api/v1/farmer/getfarmer/${phoneLocal}`);
  if (!farmerRes.ok) {
    console.error("Could not find farmer:", await farmerRes.text());
    return;
  }
  const farmerJson = await farmerRes.json();
  const farmer = farmerJson.data;
  console.log("Found farmer:", farmer._id, farmer.name || "");

  console.log("\n2) Recording pending whatsapp history (will create pending activity)");
  const historyRes = await fetch(`${API_BASE}/api/v1/farmer/whatsapp-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      farmerIds: [farmer._id],
      message: "Test message for webhook flow",
      templateName: "TestTemplate",
      broadcastName: `TestBroadcast_${Date.now()}`,
      timestamp: new Date().toISOString()
    }),
  });
  console.log("recordWhatsappHistory -> status:", historyRes.status);
  console.log("body:", JSON.stringify(await historyRes.json(), null, 2));

  const localMessageId = `lm-test-${Date.now()}`;
  const whatsappMessageId = `wm-test-${Date.now()}`;

  console.log("\n3) Sending templateMessageSent_v2 webhook (simulate WATI sent)");
  let res = await fetch(`${API_BASE}/api/v1/whatsapp-status/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Wati-webhook/1.0" },
    body: JSON.stringify({
      eventType: "templateMessageSent_v2",
      statusString: "SENT",
      localMessageId,
      whatsappMessageId,
      waId: phoneWaId,
      timestamp: Math.floor(Date.now() / 1000).toString()
    })
  });
  console.log("sent webhook ->", res.status, await res.text());

  console.log("\n4) Sending delivered webhook");
  res = await fetch(`${API_BASE}/api/v1/whatsapp-status/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Wati-webhook/1.0" },
    body: JSON.stringify({
      eventType: "sentMessageDELIVERED_v2",
      statusString: "Delivered",
      localMessageId,
      waId: phoneWaId,
      timestamp: Math.floor(Date.now() / 1000).toString()
    })
  });
  console.log("delivered webhook ->", res.status, await res.text());

  console.log("\n5) Sending read webhook");
  res = await fetch(`${API_BASE}/api/v1/whatsapp-status/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Wati-webhook/1.0" },
    body: JSON.stringify({
      eventType: "sentMessageREAD_v2",
      statusString: "Read",
      localMessageId,
      waId: phoneWaId,
      timestamp: Math.floor(Date.now() / 1000).toString()
    })
  });
  console.log("read webhook ->", res.status, await res.text());

  console.log("\n6) Fetch farmer again to inspect whatsappAutomationActivities (last entry)");
  const farmerAfter = await fetch(`${API_BASE}/api/v1/farmer/getfarmer/${phoneLocal}`);
  const fj = await farmerAfter.json();
  const updated = fj.data;
  const activities = updated.whatsappAutomationActivities || [];
  console.log("Total activities:", activities.length);
  console.log("Last activity:", JSON.stringify(activities[activities.length - 1], null, 2));
}

run().catch((e) => { console.error("Test script error:", e); process.exit(1); });

