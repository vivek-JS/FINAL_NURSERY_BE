import mongoose from "mongoose";
import Product from "../models/product.model.js";
import RamAgriInputsProduct from "../models/ramAgriInputsProduct.model.js";
import RamBiotechSeedProduct from "../models/ramBiotechSeedProduct.model.js";
import SubtypeInventoryLink from "../models/subtypeInventoryLink.model.js";
import { buildAgriLinkByProductIdMap } from "./biotechSeedMaster.service.js";
import { enrichLinkRows } from "./subtypeInventoryLink.service.js";

function key(plantId, subtypeId) {
  return `${plantId}:${subtypeId}`;
}

async function batchCountByProduct(productIds) {
  if (!productIds?.length) return new Map();
  const { default: Batch } = await import("../models/batch.model.js");
  const ids = productIds.map((id) =>
    id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))
  );
  const rows = await Batch.aggregate([
    { $match: { product: { $in: ids }, status: { $ne: "blocked" } } },
    { $group: { _id: "$product", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), Number(r.count) || 0]));
}

function mapProduct(p, agriLinkMap, batchMap) {
  const agri = agriLinkMap.get(String(p._id));
  return {
    _id: p._id,
    code: p.code,
    name: p.name,
    currentStock: p.currentStock || 0,
    batchCount: batchMap.get(String(p._id)) || 0,
    plantId: p.plantId,
    subtypeId: p.subtypeId,
    agriLink: agri
      ? {
          linked: true,
          cropId: agri.cropId,
          cropName: agri.cropName,
          varietyId: agri.varietyId,
          varietyName: agri.varietyName,
          agriStock: agri.agriStock,
        }
      : { linked: false },
  };
}

function agriVarietyEntry(crop, v, extra = {}) {
  return {
    cropId: crop._id,
    cropName: crop.cropName,
    varietyId: v._id,
    varietyName: v.name,
    agriStock: v.currentStock || 0,
    linkedProductId: v.linkedInventoryProductId || null,
    sowingPlantId: v.sowingPlantId || null,
    sowingSubtypeId: v.sowingSubtypeId || null,
    ...extra,
  };
}

/** Index Agri master varieties onto plant/subtype rows (sowing map + linked product map). */
function buildAgriByPlantSubtype(agriCrops, productById) {
  const map = new Map();

  const push = (plantId, subtypeId, entry) => {
    if (!plantId || !subtypeId) return;
    const k = key(plantId, subtypeId);
    if (!map.has(k)) map.set(k, []);
    const list = map.get(k);
    if (list.some((x) => String(x.varietyId) === String(entry.varietyId))) return;
    list.push(entry);
  };

  for (const crop of agriCrops) {
    for (const v of crop.varieties || []) {
      if (v.isActive === false) continue;
      const entry = agriVarietyEntry(crop, v, { source: "agri_master" });

      if (v.sowingPlantId && v.sowingSubtypeId) {
        push(v.sowingPlantId, v.sowingSubtypeId, { ...entry, source: "sowing_map" });
      }

      if (v.linkedInventoryProductId) {
        const prod = productById.get(String(v.linkedInventoryProductId));
        if (prod?.plantId && prod?.subtypeId) {
          push(prod.plantId, prod.subtypeId, {
            ...entry,
            source: "linked_product",
            linkedProductCode: prod.code,
            linkedProductName: prod.name,
          });
        }
      }
    }
  }

  return map;
}

function buildBiotechMasterByPlantSubtype(masterPlants) {
  const map = new Map();
  for (const plant of masterPlants) {
    for (const v of plant.varieties || []) {
      if (v.isActive === false) continue;
      if (!v.sowingPlantId || !v.sowingSubtypeId) continue;
      const k = key(v.sowingPlantId, v.sowingSubtypeId);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({
        masterPlantId: plant._id,
        masterPlantName: plant.plantName,
        varietyId: v._id,
        varietyName: v.name,
        linkedProductId: v.linkedInventoryProductId || null,
      });
    }
  }
  return map;
}

function buildAgriMasterList(agriCrops, productById, agriLinkMap) {
  const rows = [];
  for (const crop of agriCrops) {
    for (const v of crop.varieties || []) {
      if (v.isActive === false) continue;

      let biotech = null;
      const productId = v.linkedInventoryProductId
        ? String(v.linkedInventoryProductId)
        : null;

      if (productId && productById.has(productId)) {
        const p = productById.get(productId);
        const agriFromMap = agriLinkMap.get(productId);
        biotech = {
          productId: p._id,
          code: p.code,
          name: p.name,
          currentStock: p.currentStock || 0,
          plantId: p.plantId,
          subtypeId: p.subtypeId,
          linked: Boolean(agriFromMap),
        };
      } else {
        for (const [pid, agri] of agriLinkMap.entries()) {
          if (
            String(agri.cropId) === String(crop._id) &&
            String(agri.varietyId) === String(v._id)
          ) {
            const p = productById.get(pid);
            if (p) {
              biotech = {
                productId: p._id,
                code: p.code,
                name: p.name,
                currentStock: p.currentStock || 0,
                plantId: p.plantId,
                subtypeId: p.subtypeId,
                linked: true,
              };
            }
            break;
          }
        }
      }

      rows.push({
        cropId: crop._id,
        cropName: crop.cropName,
        varietyId: v._id,
        varietyName: v.name,
        agriStock: v.currentStock || 0,
        sowingPlantId: v.sowingPlantId || null,
        sowingSubtypeId: v.sowingSubtypeId || null,
        biotechLink: biotech,
        linkStatus: biotech?.linked ? "linked" : biotech ? "partial" : "unlinked",
      });
    }
  }
  return rows.sort((a, b) =>
    `${a.cropName}:${a.varietyName}`.localeCompare(`${b.cropName}:${b.varietyName}`)
  );
}

function mergeAgriFromProducts(products, agriVarieties) {
  const byVariety = new Map(agriVarieties.map((a) => [String(a.varietyId), a]));
  for (const p of products) {
    if (!p.agriLink?.linked) continue;
    const vid = String(p.agriLink.varietyId);
    if (byVariety.has(vid)) continue;
    byVariety.set(vid, {
      cropId: p.agriLink.cropId,
      cropName: p.agriLink.cropName,
      varietyId: p.agriLink.varietyId,
      varietyName: p.agriLink.varietyName,
      agriStock: p.agriLink.agriStock || 0,
      linkedProductId: p._id,
      source: "product_agri_link",
      linkedProductCode: p.code,
    });
  }
  return Array.from(byVariety.values());
}

function rowLinkStatus(products, agriVarieties = []) {
  const hasSeed = products.length > 0;
  const agriLinked =
    products.some((p) => p.agriLink?.linked) || (agriVarieties?.length || 0) > 0;
  if (hasSeed && agriLinked) return "linked";
  if (hasSeed || agriLinked) return hasSeed ? "seed_only" : "agri_only";
  return "empty";
}

export async function buildSeedDualInventoryLinks({ unlinkedOnly = false, search = "" } = {}) {
  const { default: PlantCms } = await import("../models/plantCms.model.js");

  const [cmsPlants, seedProducts, agriCrops, biotechMaster, agriLinkMap, multiLinks] =
    await Promise.all([
    PlantCms.find({ sowingAllowed: { $ne: false } })
      .select("name subtypes.name subtypes._id subtypes.isActive")
      .sort({ name: 1 })
      .lean(),
    Product.find({ category: { $regex: /^seeds$/i }, isActive: { $ne: false } })
      .select("_id code name plantId subtypeId currentStock")
      .lean(),
    RamAgriInputsProduct.find({ productType: "seed", isActive: { $ne: false } })
      .select("cropName varieties")
      .lean(),
    RamBiotechSeedProduct.find({ isActive: { $ne: false } })
      .select("plantName varieties")
      .lean(),
    buildAgriLinkByProductIdMap(),
    SubtypeInventoryLink.find({ isActive: true })
      .populate("productId", "name code currentStock category")
      .populate("ramAgriCropId", "cropName varieties")
      .lean(),
  ]);

  const enrichedMulti = enrichLinkRows(multiLinks);
  const multiByKey = new Map();
  for (const link of enrichedMulti) {
    const k = key(link.plantId, link.subtypeId);
    if (!multiByKey.has(k)) multiByKey.set(k, []);
    multiByKey.get(k).push(link);
  }

  const productById = new Map(seedProducts.map((p) => [String(p._id), p]));
  const batchMap = await batchCountByProduct(seedProducts.map((p) => p._id));
  const agriByKey = buildAgriByPlantSubtype(agriCrops, productById);
  const biotechMasterByKey = buildBiotechMasterByPlantSubtype(biotechMaster);
  const agriMasterVarieties = buildAgriMasterList(agriCrops, productById, agriLinkMap);

  const productsByKey = new Map();
  const unassigned = [];

  for (const p of seedProducts) {
    const row = mapProduct(p, agriLinkMap, batchMap);
    if (p.plantId && p.subtypeId) {
      const k = key(p.plantId, p.subtypeId);
      if (!productsByKey.has(k)) productsByKey.set(k, []);
      productsByKey.get(k).push(row);
    } else {
      unassigned.push(row);
    }
  }

  const q = String(search || "")
    .trim()
    .toLowerCase();

  const matchesSearch = (plantName, subtypeName, products, agriVarieties, biotechEntries) => {
    if (!q) return true;
    if (plantName.toLowerCase().includes(q) || subtypeName.toLowerCase().includes(q)) return true;
    if (products.some((p) => p.code?.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q)))
      return true;
    if (agriVarieties.some((a) => a.cropName?.toLowerCase().includes(q) || a.varietyName?.toLowerCase().includes(q)))
      return true;
    if (biotechEntries.some((b) => b.masterPlantName?.toLowerCase().includes(q) || b.varietyName?.toLowerCase().includes(q)))
      return true;
    return false;
  };

  let totalRows = 0;
  let linkedRows = 0;
  let unlinkedRows = 0;

  const plants = cmsPlants
    .map((plant) => {
      const subtypes = (plant.subtypes || [])
        .filter((st) => st.isActive !== false)
        .map((st) => {
          const k = key(plant._id, st._id);
          const allProducts = (productsByKey.get(k) || []).sort((a, b) =>
            String(a.code).localeCompare(String(b.code))
          );
          // Multi-link: expose all seed products (no truncate to first)
          const products = allProducts;
          const extraProductCount = 0;
          const agriVarieties = mergeAgriFromProducts(allProducts, agriByKey.get(k) || []);
          const biotechMasterVarieties = biotechMasterByKey.get(k) || [];
          const multiLinksForSubtype = multiByKey.get(k) || [];
          const status = rowLinkStatus(products, agriVarieties);

          totalRows += 1;
          if (status === "linked") linkedRows += 1;
          else unlinkedRows += 1;

          return {
            subtypeId: st._id,
            subtypeName: st.name,
            products,
            agriVarieties,
            biotechMasterVarieties,
            inventoryLinks: multiLinksForSubtype,
            linkStatus: status,
            productCount: products.length,
            extraProductCount,
            agriCount: agriVarieties.length,
            biotechMasterCount: biotechMasterVarieties.length,
          };
        })
        .filter((st) => {
          if (unlinkedOnly && st.linkStatus === "linked") return false;
          return matchesSearch(
            plant.name,
            st.subtypeName,
            st.products,
            st.agriVarieties,
            st.biotechMasterVarieties
          );
        });

      const flatProducts = subtypes.flatMap((s) => s.products);
      return {
        plantId: plant._id,
        plantName: plant.name,
        subtypes,
        productCount: flatProducts.length,
        linkedCount: flatProducts.filter((p) => p.agriLink?.linked).length,
      };
    })
    .filter((pl) => pl.subtypes.length > 0);

  const filteredUnassigned = unassigned.filter((p) => {
    if (unlinkedOnly && p.agriLink?.linked) return false;
    if (!q) return true;
    return (
      p.code?.toLowerCase().includes(q) ||
      p.name?.toLowerCase().includes(q) ||
      p.agriLink?.cropName?.toLowerCase().includes(q)
    );
  });

  const filteredAgriMaster = agriMasterVarieties.filter((a) => {
    if (unlinkedOnly && a.linkStatus === "linked") return false;
    if (!q) return true;
    return (
      a.cropName?.toLowerCase().includes(q) ||
      a.varietyName?.toLowerCase().includes(q) ||
      a.biotechLink?.code?.toLowerCase().includes(q)
    );
  });

  const agriLinkedCount = agriMasterVarieties.filter((a) => a.linkStatus === "linked").length;

  return {
    summary: {
      totalPlants: plants.length,
      totalSubtypeRows: totalRows,
      linkedRows,
      unlinkedRows,
      unassignedProducts: filteredUnassigned.length,
      totalSeedProducts: seedProducts.length,
      agriMasterVarieties: agriMasterVarieties.length,
      agriMasterLinked: agriLinkedCount,
      agriMasterUnlinked: agriMasterVarieties.length - agriLinkedCount,
    },
    plants,
    unassigned: filteredUnassigned,
    agriMasterVarieties: filteredAgriMaster,
  };
}
