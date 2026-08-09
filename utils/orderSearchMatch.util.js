import escapeRegex from "../utility/escapeRegex.js";

/** $addFields stage: string forms of booking + book-for mobiles for search. */
export function orderSearchMobileAddFieldsStage() {
  const mobileToStr = (fieldPath) => ({
    $let: {
      vars: { raw: fieldPath },
      in: {
        $cond: [
          {
            $or: [
              { $eq: ["$$raw", null] },
              { $eq: ["$$raw", ""] },
              { $eq: ["$$raw", 0] },
            ],
          },
          "",
          { $toString: "$$raw" },
        ],
      },
    },
  });

  return {
    $addFields: {
      "farmer.mobileNumberStr": {
        $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
      },
      orderForMobileStr: mobileToStr("$orderFor.mobileNumber"),
      whatsappBookingMobileStr: mobileToStr("$whatsappBookingMobile"),
    },
  };
}

/**
 * Build $or match clauses for order list search.
 * Matches booking farmer mobile, book-for mobile, and optional WhatsApp booking mobile.
 */
export function buildOrderSearchOrConditions(searchTrimmed) {
  const trimmed = String(searchTrimmed || "").trim();
  if (!trimmed) return [];

  const searchRegex = new RegExp(escapeRegex(trimmed), "i");
  const isNumeric = /^\d+$/.test(trimmed);
  const searchAsNumber = isNumeric ? Number(trimmed) : NaN;

  const nameLocationOr = [
    { "farmer.name": searchRegex },
    { "orderFor.name": searchRegex },
    { "orderFor.village": searchRegex },
    { "orderFor.talukaName": searchRegex },
    { "orderFor.districtName": searchRegex },
    { "orderFor.district": searchRegex },
  ];

  const mobileFields = [
    "farmer.mobileNumberStr",
    "orderForMobileStr",
    "whatsappBookingMobileStr",
  ];

  if (isNumeric) {
    const searchOr = [{ orderId: searchAsNumber }];

    if (trimmed.length >= 4) {
      for (const field of mobileFields) {
        searchOr.push({ [field]: searchRegex });
      }
    }
    if (trimmed.length >= 10) {
      for (const field of mobileFields) {
        searchOr.push({ [field]: trimmed });
      }
    }

    return searchOr;
  }

  const searchOr = [
    ...nameLocationOr,
    ...mobileFields.map((field) => ({ [field]: searchRegex })),
  ];

  return searchOr;
}

/** Farmer lookup + mobile fields stages before $match search. */
export function appendOrderSearchPipelineStages(pipeline, searchTrimmed) {
  const trimmed = String(searchTrimmed || "").trim();
  if (!trimmed) return;

  pipeline.push({
    $lookup: {
      from: "farmers",
      localField: "farmer",
      foreignField: "_id",
      as: "farmer",
    },
  });
  pipeline.push(orderSearchMobileAddFieldsStage());
  pipeline.push({
    $match: {
      $or: buildOrderSearchOrConditions(trimmed),
    },
  });
}
