/**
 * Coerce orderFor location fields to strings (LocationSelector may send { state, stateName } objects).
 */

function locationFieldLabel(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return String(
      value.stateName ?? value.state ?? value.label ?? value.name ?? ""
    ).trim();
  }
  return String(value).trim();
}

/**
 * @param {Record<string, unknown>|null|undefined} orderFor
 * @returns {Record<string, unknown>|null|undefined}
 */
export function normalizeOrderForLocationFields(orderFor) {
  if (orderFor == null) return orderFor;
  if (typeof orderFor !== "object" || Array.isArray(orderFor)) return orderFor;

  const o = { ...orderFor };
  const pairs = [
    ["state", "stateName"],
    ["district", "districtName"],
    ["taluka", "talukaName"],
  ];

  for (const [idKey, nameKey] of pairs) {
    if (o[idKey] != null && typeof o[idKey] === "object") {
      const label = locationFieldLabel(o[idKey]);
      o[idKey] = label;
      if (!o[nameKey]) o[nameKey] = label;
    }
    if (o[nameKey] != null && typeof o[nameKey] === "object") {
      const label = locationFieldLabel(o[nameKey]);
      o[nameKey] = label;
      if (!o[idKey]) o[idKey] = label;
    }
  }

  if (o.village != null && typeof o.village === "object") {
    o.village = locationFieldLabel(o.village);
  }

  return o;
}
