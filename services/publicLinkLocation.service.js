import State from "../models/state.model.js";

/**
 * For each location rule with selected talukas, replace/merge villages with
 * the full master list for those talukas (so public forms never miss villages).
 */
export async function expandLocationRulesVillages(locationRules = []) {
  if (!Array.isArray(locationRules) || locationRules.length === 0) {
    return locationRules;
  }

  const stateCodes = [
    ...new Set(locationRules.map((r) => r.stateCode).filter(Boolean)),
  ];
  const stateNames = [
    ...new Set(locationRules.map((r) => r.stateName).filter(Boolean)),
  ];

  const states = await State.find({
    $or: [
      ...(stateCodes.length ? [{ code: { $in: stateCodes } }] : []),
      ...(stateNames.length ? [{ name: { $in: stateNames } }] : []),
    ],
  }).lean();

  const stateByKey = new Map();
  for (const s of states) {
    if (s.code) stateByKey.set(String(s.code).toUpperCase(), s);
    if (s.name) stateByKey.set(String(s.name).toLowerCase(), s);
  }

  return locationRules.map((rule) => {
    const state =
      stateByKey.get(String(rule.stateCode || "").toUpperCase()) ||
      stateByKey.get(String(rule.stateName || "").toLowerCase());

    if (!state || !Array.isArray(rule.talukas) || rule.talukas.length === 0) {
      return rule;
    }

    const selectedDistrictNames = new Set(
      (rule.districts || []).map((d) => String(d.districtName || "").toLowerCase())
    );
    const selectedDistrictCodes = new Set(
      (rule.districts || []).map((d) => String(d.districtCode || "").toUpperCase())
    );

    const selectedTalukaKeys = new Set();
    for (const t of rule.talukas) {
      if (t.talukaCode) selectedTalukaKeys.add(`c:${String(t.talukaCode).toUpperCase()}`);
      if (t.talukaName) selectedTalukaKeys.add(`n:${String(t.talukaName).toLowerCase()}`);
    }

    const villages = [];
    const seen = new Set();

    for (const district of state.districts || []) {
      // Prefer district name — MH_NAN is shared by Nanded and Nandurbar in master data
      let districtOk = true;
      if (selectedDistrictNames.size > 0) {
        districtOk = selectedDistrictNames.has(
          String(district.name || "").toLowerCase()
        );
      } else if (selectedDistrictCodes.size > 0) {
        districtOk = selectedDistrictCodes.has(
          String(district.code || "").toUpperCase()
        );
      }
      if (!districtOk) continue;

      for (const taluka of district.talukas || []) {
        const talukaOk =
          selectedTalukaKeys.has(`c:${String(taluka.code || "").toUpperCase()}`) ||
          selectedTalukaKeys.has(`n:${String(taluka.name || "").toLowerCase()}`);
        if (!talukaOk) continue;

        for (const v of taluka.villages || []) {
          const name = String(v.name || "").trim();
          if (!name) continue;
          const key = `${taluka.code}|${name.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          villages.push({
            villageCode: v.code,
            villageName: name,
            talukaCode: taluka.code,
            districtCode: district.code,
          });
        }
      }
    }

    // Prefer full master list; keep any manually added villages not in master
    const masterKeys = new Set(
      villages.map((v) => `${v.talukaCode}|${v.villageName.toLowerCase()}`)
    );
    for (const v of rule.villages || []) {
      const name = String(v.villageName || "").trim();
      if (!name) continue;
      const tCode = v.talukaCode || "";
      const key = `${tCode}|${name.toLowerCase()}`;
      if (masterKeys.has(key)) continue;
      // Keep extras only if they match a selected taluka (or have no talukaCode)
      if (
        tCode &&
        !selectedTalukaKeys.has(`c:${String(tCode).toUpperCase()}`)
      ) {
        continue;
      }
      villages.push({
        villageCode: v.villageCode,
        villageName: name,
        talukaCode: v.talukaCode,
        districtCode: v.districtCode,
      });
      masterKeys.add(key);
    }

    return {
      ...rule,
      villages,
    };
  });
}
