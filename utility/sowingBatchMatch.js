import mongoose from "mongoose";

/** Strip non-digits from a batch label (e.g. "BATCH-100" → "100"). */
export const digitsOnly = (s) => String(s ?? "").replace(/\D/g, "");

/** Integer parsed from digits-only part, or null if none / invalid. */
export const batchNumericValue = (s) => {
  const d = digitsOnly(s);
  if (!d) return null;
  const n = parseInt(d, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Match Sowing rows for a single dispatch batch: by dispatchBatchId, exact trim,
 * case-insensitive trim, or same numeric value as digits in batchNumber (e.g. 100 vs 0100 vs BATCH-100).
 */
export const buildSowingMatchForSingleBatch = (batchId, bn) => {
  const or = [];
  if (batchId && mongoose.Types.ObjectId.isValid(String(batchId))) {
    or.push({ dispatchBatchId: new mongoose.Types.ObjectId(String(batchId)) });
  }
  if (bn) {
    or.push({
      $expr: {
        $eq: [
          {
            $trim: {
              input: { $toString: { $ifNull: ["$batchNumber", ""] } },
            },
          },
          bn,
        ],
      },
    });
    or.push({
      $expr: {
        $eq: [
          {
            $toLower: {
              $trim: {
                input: { $toString: { $ifNull: ["$batchNumber", ""] } },
              },
            },
          },
          bn.toLowerCase(),
        ],
      },
    });
    const n = batchNumericValue(bn);
    if (n != null) {
      or.push({
        $expr: {
          $and: [
            {
              $regexMatch: {
                input: { $toString: { $ifNull: ["$batchNumber", ""] } },
                regex: "[0-9]",
              },
            },
            {
              $eq: [
                {
                  $toInt: {
                    $regexReplace: {
                      input: { $toString: { $ifNull: ["$batchNumber", ""] } },
                      regex: "[^0-9]",
                      replacement: "",
                    },
                  },
                },
                n,
              ],
            },
          ],
        },
      });
    }
  }
  return or.length ? { $or: or } : null;
};

/**
 * Match Sowing rows for many batches at once (dashboard): dispatchBatchId $in,
 * trim / lower trim in batch number list, or numeric equality on digit-only form.
 */
export const buildSowingMatchForBatchList = (batchObjectIds, batchNumberStrings) => {
  const or = [];
  const ids = (batchObjectIds || []).filter(
    (id) => id && mongoose.Types.ObjectId.isValid(String(id))
  );
  if (ids.length) {
    or.push({
      dispatchBatchId: {
        $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))),
      },
    });
  }

  const bnList = [...new Set((batchNumberStrings || []).map((x) => String(x).trim()).filter(Boolean))];
  if (bnList.length) {
    or.push({
      $expr: {
        $in: [
          {
            $trim: {
              input: { $toString: { $ifNull: ["$batchNumber", ""] } },
            },
          },
          bnList,
        ],
      },
    });
    const lower = [...new Set(bnList.map((x) => x.toLowerCase()))];
    or.push({
      $expr: {
        $in: [
          {
            $toLower: {
              $trim: {
                input: { $toString: { $ifNull: ["$batchNumber", ""] } },
              },
            },
          },
          lower,
        ],
      },
    });
  }

  const numericIds = [
    ...new Set(
      bnList
        .map((bn) => batchNumericValue(bn))
        .filter((n) => n != null)
    ),
  ];
  if (numericIds.length) {
    or.push({
      $expr: {
        $and: [
          {
            $regexMatch: {
              input: { $toString: { $ifNull: ["$batchNumber", ""] } },
              regex: "[0-9]",
            },
          },
          {
            $in: [
              {
                $toInt: {
                  $regexReplace: {
                    input: { $toString: { $ifNull: ["$batchNumber", ""] } },
                    regex: "[^0-9]",
                    replacement: "",
                  },
                },
              },
              numericIds,
            ],
          },
        ],
      },
    });
  }

  return or.length ? { $or: or } : null;
};
