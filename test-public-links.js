import axios from "axios";

const BASE_URL = process.env.BASE_URL || "http://localhost:8000/api/v1";
const TOKEN = process.env.TEST_TOKEN || "";

const authHeaders = TOKEN
  ? {
      Authorization: `Bearer ${TOKEN}`
    }
  : {};

async function run() {
  try {
    console.log("1) Creating public farmer link (admin)...");
    const createRes = await axios.post(
      `${BASE_URL}/public-links/links`,
      {
        name: "Test MH Nashik Campaign",
        slug: "test-mh-nashik",
        description: "Test link for MH Nashik",
        isActive: true,
        locationRules: [
          {
            stateCode: "MH",
            stateName: "Maharashtra",
            districts: [{ districtCode: "Nashik", districtName: "Nashik" }],
            talukas: [{ talukaCode: "Nashik", talukaName: "Nashik" }],
            villages: [{ villageName: "TestVillage" }]
          }
        ]
      },
      { headers: authHeaders }
    );

    console.log("Created link:", createRes.data?.data?.link?.slug);

    console.log("2) Fetching public config (no auth)...");
    const configRes = await axios.get(
      `${BASE_URL}/public-links/config/test-mh-nashik`
    );
    console.log("Config OK, name:", configRes.data?.data?.link?.name);

    console.log("3) Creating public farmer lead (no auth)...");
    const leadRes = await axios.post(`${BASE_URL}/public-links/leads`, {
      slug: "test-mh-nashik",
      name: "Test Farmer",
      mobileNumber: "9999999999",
      stateCode: "MH",
      stateName: "Maharashtra",
      districtCode: "Nashik",
      districtName: "Nashik",
      talukaCode: "Nashik",
      talukaName: "Nashik",
      villageName: "TestVillage"
    });

    console.log("Lead created with id:", leadRes.data?.data?.leadId);
    console.log("✅ Public link flow test completed");
  } catch (err) {
    console.error("❌ Test failed");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Body:", err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

run();




