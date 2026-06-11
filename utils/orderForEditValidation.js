/**
 * Validation for split-child orderFor (book-for beneficiary) edits.
 */

import { normalizeOrderForLocationFields } from "./orderForNormalize.js";

function normalizeMobile(m) {
  if (m == null || m === "") return "";
  const d = String(m).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

function trimStr(v) {
  return v == null ? "" : String(v).trim();
}

function hasLocationField(orderFor, key, nameKey) {
  return Boolean(trimStr(orderFor?.[key]) || trimStr(orderFor?.[nameKey]));
}

export function classifyOrderForChange(prevRaw, nextRaw) {
  const prev = prevRaw && typeof prevRaw === "object" ? prevRaw : {};
  const next = nextRaw && typeof nextRaw === "object" ? nextRaw : {};

  const nameChanged = trimStr(prev.name) !== trimStr(next.name);
  const mobileChanged = normalizeMobile(prev.mobileNumber) !== normalizeMobile(next.mobileNumber);
  const locationChanged =
    trimStr(prev.village) !== trimStr(next.village) ||
    trimStr(prev.taluka) !== trimStr(next.taluka) ||
    trimStr(prev.talukaName) !== trimStr(next.talukaName) ||
    trimStr(prev.district) !== trimStr(next.district) ||
    trimStr(prev.districtName) !== trimStr(next.districtName) ||
    trimStr(prev.state) !== trimStr(next.state) ||
    trimStr(prev.stateName) !== trimStr(next.stateName) ||
    trimStr(prev.address) !== trimStr(next.address);

  return { nameChanged, mobileChanged, locationChanged };
}

function hasFullLocation(orderFor) {
  if (!orderFor || typeof orderFor !== "object") return false;
  return (
    Boolean(trimStr(orderFor.name)) &&
    Boolean(trimStr(orderFor.village)) &&
    hasLocationField(orderFor, "taluka", "talukaName") &&
    hasLocationField(orderFor, "district", "districtName") &&
    hasLocationField(orderFor, "state", "stateName")
  );
}

function hasUsableMobile(orderFor) {
  return normalizeMobile(orderFor?.mobileNumber).length === 10;
}

/**
 * @param {object|null|undefined} prevRaw
 * @param {object|null|undefined} nextRaw
 * @param {{ mode?: 'existing'|'new' }} [options]
 */
export function validateOrderForBeneficiaryEdit(prevRaw, nextRaw, options = {}) {
  const prev = prevRaw && typeof prevRaw === "object" ? prevRaw : {};
  const next = nextRaw && typeof nextRaw === "object" ? nextRaw : {};
  const { mode = "new" } = options;

  const change = classifyOrderForChange(prev, next);
  if (!change.nameChanged && !change.mobileChanged && !change.locationChanged) {
    return { ok: false, noChanges: true, message: "No beneficiary changes to save" };
  }

  if (mode === "existing" || hasFullLocation(next)) {
    if (!hasFullLocation(next)) {
      return {
        ok: false,
        message:
          "Farmer record is incomplete. Use New farmer mode to enter name, village, taluka, district, and state.",
      };
    }
    return { ok: true, editType: "existing_farmer" };
  }

  const nextMobile = normalizeMobile(next.mobileNumber);
  const prevMobile = normalizeMobile(prev.mobileNumber);
  const mobileEnteredOrChanged =
    nextMobile.length === 10 && (nextMobile !== prevMobile || !prevMobile);

  if (mobileEnteredOrChanged) {
    if (!hasFullLocation(next)) {
      return {
        ok: false,
        message:
          "When mobile number is set, beneficiary name, village, taluka, district, and state are required.",
      };
    }
    return { ok: true, editType: "new_farmer_full" };
  }

  if (!trimStr(next.name)) {
    return { ok: false, message: "Beneficiary name is required." };
  }

  return { ok: true, editType: "name_only" };
}

/**
 * Human-readable orderEditHistory note for split child orderFor updates.
 */
export function splitBeneficiaryEditHistoryNote(prevRaw, nextRaw, options = {}) {
  const result = validateOrderForBeneficiaryEdit(prevRaw, nextRaw, options);
  if (!result.ok || result.noChanges) return undefined;

  switch (result.editType) {
    case "existing_farmer":
      return "Split order beneficiary: existing farmer lookup";
    case "name_only":
      return "Split order beneficiary: name only (booking farmer unchanged)";
    case "new_farmer_full":
      return "Split order beneficiary: new farmer — mobile + location";
    default:
      return "Split order beneficiary updated";
  }
}

/** Book-for assign at split — name required; location, mobile, address optional. */
export function resolveSplitBookForAssign(bodyOrderFor) {
  if (
    bodyOrderFor == null ||
    typeof bodyOrderFor !== "object" ||
    Array.isArray(bodyOrderFor)
  ) {
    return { ok: false, message: "Please enter name for the person the order is for." };
  }

  const normalized = normalizeOrderForLocationFields(bodyOrderFor);
  const name = trimStr(normalized.name);
  if (!name) {
    return { ok: false, message: "Please enter name for the person the order is for." };
  }

  const mob = normalizeMobile(normalized.mobileNumber);
  if (mob.length > 0 && mob.length !== 10) {
    return { ok: false, message: "If entered, book-for mobile must be exactly 10 digits." };
  }

  const orderFor = { name };
  const optionalFields = [
    "village",
    "taluka",
    "talukaName",
    "district",
    "districtName",
    "state",
    "stateName",
    "address",
  ];
  for (const key of optionalFields) {
    const v = trimStr(normalized[key]);
    if (v) orderFor[key] = v;
  }
  if (mob.length === 10) {
    orderFor.mobileNumber = mob;
  }

  return { ok: true, orderFor, applied: true };
}

/** New farmer assign at split: full location + 10-digit mobile required. */
export function validateSplitNewFarmerDetails(bodyOrderFor) {
  if (
    bodyOrderFor == null ||
    typeof bodyOrderFor !== "object" ||
    Array.isArray(bodyOrderFor)
  ) {
    return {
      ok: false,
      message: "New farmer requires name, village, taluka, district, state, and mobile.",
    };
  }

  const normalized = normalizeOrderForLocationFields(bodyOrderFor);
  if (!hasFullLocation(normalized)) {
    return {
      ok: false,
      message: "New farmer requires name, village, taluka, district, and state.",
    };
  }
  if (!hasUsableMobile(normalized)) {
    return {
      ok: false,
      message: "New farmer requires a 10-digit mobile number.",
    };
  }

  return { ok: true, farmerDetails: normalized };
}
