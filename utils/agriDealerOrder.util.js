/** Dealer self-order helpers for Ram Agri Input orders. */

export function normalizeAgriRole(user) {
  const jt = String(user?.jobTitle || "").toUpperCase().trim();
  const role = String(user?.role || "").toUpperCase().trim();
  return { jt, role };
}

export function isAgriDealerSelf(user) {
  const { jt, role } = normalizeAgriRole(user);
  return jt === "DEALER" || role === "DEALER" || jt === "AGRI_INPUT_DEALER" || role === "AGRI_INPUT_DEALER";
}

export function isRamAgriSalesRepUser(user) {
  const { jt, role } = normalizeAgriRole(user);
  return jt === "RAM_AGRI_SALES" || role === "RAM_AGRI_SALES" || jt === "SALES" || role === "SALES";
}

/** Customer fields from dealer user profile for self-orders. */
export function dealerProfileToCustomerFields(user) {
  const mobile = String(user?.phoneNumber || user?.mobile || "").replace(/\D/g, "").slice(-10);
  return {
    customerName: String(user?.name || "").trim(),
    customerMobile: mobile,
    customerVillage: String(user?.defaultVillage || user?.village || "").trim(),
    customerTaluka: String(user?.defaultTaluka || user?.taluka || "").trim(),
    customerDistrict: String(user?.defaultDistrict || user?.district || "").trim(),
    customerState: String(user?.defaultState || user?.state || "Maharashtra").trim(),
  };
}

export function mergeDealerCustomerFields(body, user) {
  const fromProfile = dealerProfileToCustomerFields(user);
  return {
    customerName: (body.customerName || fromProfile.customerName || "").trim(),
    customerMobile: (body.customerMobile || fromProfile.customerMobile || "").trim(),
    customerVillage: (body.customerVillage || fromProfile.customerVillage || "").trim(),
    customerTaluka: (body.customerTaluka || fromProfile.customerTaluka || "").trim(),
    customerDistrict: (body.customerDistrict || fromProfile.customerDistrict || "").trim(),
    customerState: (body.customerState || fromProfile.customerState || "Maharashtra").trim(),
  };
}

/** Mongo filter: orders visible to a dealer user (self-booked). */
export function dealerOwnOrdersFilter(userId) {
  const id = userId?.toString?.() || String(userId);
  return { $or: [{ dealer: userId }, { createdBy: userId, isDealerSelfOrder: true }] };
}
