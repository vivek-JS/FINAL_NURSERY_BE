import Farmer from "../models/farmer.model.js";
import FarmerLead from "../models/farmerLead.model.js";
import OldSalesData from "../models/oldSalesData.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";

const normalizePhone = (value) => {
  if (value == null) return "";
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
};

const includesText = (haystack, needle) => {
  if (!needle) return true;
  return String(haystack || "")
    .toLowerCase()
    .includes(String(needle).toLowerCase());
};

const parseSources = (raw) => {
  const allowed = new Set(["farmer", "oldSales", "publicLink"]);
  const list = String(raw || "farmer,oldSales,publicLink")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.has(s));
  return list.length ? list : ["farmer", "oldSales", "publicLink"];
};

const createContact = (phone, source, sourceId, fields) => ({
  phone,
  mobileNumber: phone,
  name: fields.name || "",
  alternateNumber: fields.alternateNumber || null,
  village: fields.village || "",
  taluka: fields.taluka || "",
  district: fields.district || "",
  stateName: fields.stateName || "",
  opt_in: fields.opt_in ?? null,
  sources: [source],
  sourceIds: { [source]: sourceId },
});

const mergeContact = (existing, incoming, source) => {
  if (!existing.sources.includes(source)) {
    existing.sources.push(source);
  }
  existing.sourceIds[source] = incoming.sourceIds[source];

  const fillIfEmpty = (key) => {
    if (!existing[key] && incoming[key]) {
      existing[key] = incoming[key];
    }
  };

  fillIfEmpty("name");
  fillIfEmpty("village");
  fillIfEmpty("taluka");
  fillIfEmpty("district");
  fillIfEmpty("stateName");
  fillIfEmpty("alternateNumber");

  if (incoming.opt_in != null) {
    if (existing.opt_in == null) existing.opt_in = incoming.opt_in;
    if (source === "farmer") existing.opt_in = incoming.opt_in;
  }

  if (source === "farmer") {
    existing.name = incoming.name || existing.name;
    existing.village = incoming.village || existing.village;
    existing.taluka = incoming.taluka || existing.taluka;
    existing.district = incoming.district || existing.district;
    existing.stateName = incoming.stateName || existing.stateName;
    existing.alternateNumber = incoming.alternateNumber || existing.alternateNumber;
  } else if (source === "publicLink") {
    existing.name = existing.name || incoming.name;
    existing.village = existing.village || incoming.village;
    existing.taluka = existing.taluka || incoming.taluka;
    existing.district = existing.district || incoming.district;
    existing.stateName = existing.stateName || incoming.stateName;
  }
};

const upsertContact = (map, phone, source, sourceId, fields) => {
  if (!phone || phone.length < 10) return;
  const incoming = createContact(phone, source, sourceId, fields);
  const existing = map.get(phone);
  if (!existing) {
    map.set(phone, incoming);
    return;
  }
  mergeContact(existing, incoming, source);
};

const matchesFilters = (item, { search, district, taluka, village, stateName, opt_in }) => {
  if (search) {
    const q = search.toLowerCase();
    const haystack = [
      item.name,
      item.mobileNumber,
      item.alternateNumber,
      item.village,
      item.taluka,
      item.district,
      item.stateName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  if (!includesText(item.district, district)) return false;
  if (!includesText(item.taluka, taluka)) return false;
  if (!includesText(item.village, village)) return false;
  if (!includesText(item.stateName, stateName)) return false;

  if (opt_in === "true" || opt_in === true) {
    if (item.opt_in !== true) return false;
  } else if (opt_in === "false" || opt_in === false) {
    if (item.opt_in === true) return false;
  }

  return true;
};

/** GET /farmer/all-contacts — farmers + old sales + public link leads, deduped by phone */
export const getAllFarmerContacts = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const search = String(req.query.q || req.query.search || "").trim();
  const { district, taluka, village, stateName, opt_in, linkId } = req.query;
  const sources = parseSources(req.query.sources);

  const includeFarmer = sources.includes("farmer");
  const includeOldSales = sources.includes("oldSales");
  const includePublicLink = sources.includes("publicLink");

  const map = new Map();
  const breakdown = { farmer: 0, oldSales: 0, publicLink: 0 };

  if (includeFarmer) {
    const farmerQuery = { mobileNumber: { $exists: true, $ne: null } };
    if (opt_in === "true" || opt_in === true) farmerQuery.opt_in = true;
    else if (opt_in === "false" || opt_in === false) farmerQuery.opt_in = false;

    const farmers = await Farmer.find(farmerQuery)
      .select("name mobileNumber alternateNumber village talukaName districtName stateName opt_in")
      .lean();

    for (const farmer of farmers) {
      const phone = normalizePhone(farmer.mobileNumber);
      if (phone.length < 10) continue;
      breakdown.farmer += 1;
      upsertContact(map, phone, "farmer", String(farmer._id), {
        name: farmer.name || "",
        alternateNumber: normalizePhone(farmer.alternateNumber) || null,
        village: farmer.village || "",
        taluka: farmer.talukaName || "",
        district: farmer.districtName || "",
        stateName: farmer.stateName || "",
        opt_in: farmer.opt_in ?? null,
      });
    }
  }

  if (includePublicLink) {
    const leadQuery = {};
    if (linkId) leadQuery.publicLinkId = linkId;
    if (opt_in === "true" || opt_in === true) leadQuery.opt_in = true;
    else if (opt_in === "false" || opt_in === false) leadQuery.opt_in = false;

    const leads = await FarmerLead.find(leadQuery)
      .select("name mobileNumber villageName talukaName districtName stateName opt_in publicLinkId")
      .lean();

    for (const lead of leads) {
      const phone = normalizePhone(lead.mobileNumber);
      if (phone.length < 10) continue;
      breakdown.publicLink += 1;
      upsertContact(map, phone, "publicLink", String(lead._id), {
        name: lead.name || "",
        village: lead.villageName || "",
        taluka: lead.talukaName || "",
        district: lead.districtName || "",
        stateName: lead.stateName || "",
        opt_in: lead.opt_in ?? null,
      });
    }
  }

  if (includeOldSales) {
    const oldSalesRows = await OldSalesData.aggregate([
      {
        $match: {
          mobileNo: { $nin: [null, ""] },
          $expr: { $gte: [{ $strLenCP: { $ifNull: ["$mobileNo", ""] } }, 10] },
        },
      },
      {
        $group: {
          _id: "$mobileNo",
          customerName: { $first: "$customerName" },
          village: { $first: "$village" },
          taluka: { $first: "$taluka" },
          district: { $first: "$district" },
          state: { $first: "$state" },
        },
      },
    ]);

    for (const row of oldSalesRows) {
      const phone = normalizePhone(row._id);
      if (phone.length < 10) continue;
      breakdown.oldSales += 1;
      upsertContact(map, phone, "oldSales", phone, {
        name: row.customerName || "",
        village: row.village || "",
        taluka: row.taluka || "",
        district: row.district || "",
        stateName: row.state || "Maharashtra",
        opt_in: null,
      });
    }
  }

  let items = Array.from(map.values()).filter((item) =>
    matchesFilters(item, { search, district, taluka, village, stateName, opt_in })
  );

  items.sort((a, b) => {
    const nameCmp = (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" });
    if (nameCmp !== 0) return nameCmp;
    return (a.phone || "").localeCompare(b.phone || "");
  });

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const skip = (page - 1) * limit;
  const pageItems = items.slice(skip, skip + limit);

  return res.status(200).json(
    generateResponse("Success", "All farmer contacts fetched", {
      items: pageItems,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        nextPage: page < totalPages ? page + 1 : null,
        hasPrevPage: page > 1,
        prevPage: page > 1 ? page - 1 : null,
      },
      breakdown: {
        ...breakdown,
        unique: total,
      },
    })
  );
});
