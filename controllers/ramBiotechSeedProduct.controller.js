import mongoose from 'mongoose';
import RamBiotechSeedProduct from '../models/ramBiotechSeedProduct.model.js';
import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import generateResponse from '../utility/responseFormat.js';
import { syncProductForBiotechVariety } from '../services/biotechSeedProductSync.service.js';
import { enrichBiotechSeedPlants } from '../services/biotechSeedProductEnrichment.service.js';

const parseDisplayOrder = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

const effectiveOrder = (v) => (!v || v === 0 ? Infinity : v);

function sortVarieties(varieties) {
  if (!Array.isArray(varieties) || varieties.length <= 1) return;
  varieties.sort((a, b) => {
    const ao = effectiveOrder(a.displayOrder);
    const bo = effectiveOrder(b.displayOrder);
    if (ao !== bo) return ao - bo;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
}

function sortPlants(plants) {
  if (!Array.isArray(plants) || plants.length <= 1) {
    if (plants?.length === 1) sortVarieties(plants[0].varieties);
    return plants;
  }
  const sorted = [...plants].sort((a, b) => {
    const ao = effectiveOrder(a.displayOrder);
    const bo = effectiveOrder(b.displayOrder);
    if (ao !== bo) return ao - bo;
    return String(a.plantName || '').localeCompare(String(b.plantName || ''), undefined, {
      sensitivity: 'base',
    });
  });
  sorted.forEach((p) => sortVarieties(p.varieties));
  return sorted;
}

function buildVarietyPayload(body, { requireName = true } = {}) {
  const {
    name,
    description,
    primaryUnit,
    secondaryUnit,
    conversionFactor,
    isActive,
    displayOrder,
    sowingPlantId,
    sowingSubtypeId,
    tentativePlantsPerPacket,
  } = body;

  if (requireName && (!name || !String(name).trim())) {
    throw new AppError('Variety name is required', 400);
  }
  if (requireName && !primaryUnit) {
    throw new AppError('Primary unit is required', 400);
  }

  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (description !== undefined) data.description = String(description || '').trim();
  if (primaryUnit !== undefined) data.primaryUnit = primaryUnit;
  if (secondaryUnit !== undefined) data.secondaryUnit = secondaryUnit || undefined;
  if (conversionFactor !== undefined) data.conversionFactor = Number(conversionFactor) || 1;
  if (isActive !== undefined) data.isActive = isActive;
  if (sowingPlantId !== undefined) data.sowingPlantId = sowingPlantId || undefined;
  if (sowingSubtypeId !== undefined) data.sowingSubtypeId = sowingSubtypeId || undefined;

  const parsedOrder = parseDisplayOrder(displayOrder);
  if (displayOrder !== undefined && parsedOrder === null) {
    throw new AppError('displayOrder must be a non-negative integer', 400);
  }
  if (parsedOrder !== undefined) data.displayOrder = parsedOrder;

  if (tentativePlantsPerPacket !== undefined && tentativePlantsPerPacket !== null && tentativePlantsPerPacket !== '') {
    const tpp = Number(tentativePlantsPerPacket);
    if (!Number.isFinite(tpp) || tpp <= 0) {
      throw new AppError('Tentative plants per packet must be greater than 0', 400);
    }
    data.tentativePlantsPerPacket = tpp;
  }

  return data;
}

export const createBiotechPlant = catchAsync(async (req, res, next) => {
  const { plantName, description, displayOrder } = req.body;
  if (!plantName?.trim()) return next(new AppError('Plant name is required', 400));

  const parsedOrder = parseDisplayOrder(displayOrder);
  if (displayOrder !== undefined && parsedOrder === null) {
    return next(new AppError('displayOrder must be a non-negative integer', 400));
  }

  const exists = await RamBiotechSeedProduct.findOne({ plantName: plantName.trim() });
  if (exists) return next(new AppError('Plant with this name already exists', 409));

  const doc = await RamBiotechSeedProduct.create({
    plantName: plantName.trim(),
    description: description?.trim() || '',
    displayOrder: parsedOrder,
    varieties: [],
    createdBy: req.user._id,
  });

  return res.status(201).json(generateResponse('Success', 'Plant created successfully', doc, undefined));
});

export const getAllBiotechPlants = catchAsync(async (req, res) => {
  const { search, isActive } = req.query;
  const query = {};

  if (search) {
    query.$or = [
      { plantName: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { 'varieties.name': { $regex: search, $options: 'i' } },
    ];
  }
  if (isActive !== undefined) query.isActive = isActive === 'true';

  const rows = await RamBiotechSeedProduct.find(query)
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type')
    .lean();

  const sorted = sortPlants(rows);
  const enriched = await enrichBiotechSeedPlants(sorted);

  return res.status(200).json(
    generateResponse('Success', 'Biotech seed plants fetched successfully', enriched, undefined)
  );
});

export const getBiotechPlantById = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid ID format', 400));

  const row = await RamBiotechSeedProduct.findById(id)
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type')
    .lean();

  if (!row) return next(new AppError('Plant not found', 404));

  const [enriched] = await enrichBiotechSeedPlants([row]);
  return res.status(200).json(generateResponse('Success', 'Plant fetched successfully', enriched, undefined));
});

export const updateBiotechPlant = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { plantName, description, isActive, displayOrder } = req.body;

  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid ID format', 400));

  const doc = await RamBiotechSeedProduct.findById(id);
  if (!doc) return next(new AppError('Plant not found', 404));

  if (plantName !== undefined) {
    if (!plantName.trim()) return next(new AppError('Plant name is required', 400));
    const dup = await RamBiotechSeedProduct.findOne({ plantName: plantName.trim(), _id: { $ne: id } });
    if (dup) return next(new AppError('Plant with this name already exists', 409));
    doc.plantName = plantName.trim();
  }
  if (description !== undefined) doc.description = description?.trim() || '';
  if (isActive !== undefined) doc.isActive = isActive;

  const parsedOrder = parseDisplayOrder(displayOrder);
  if (displayOrder !== undefined && parsedOrder === null) {
    return next(new AppError('displayOrder must be a non-negative integer', 400));
  }
  if (parsedOrder !== undefined) doc.displayOrder = parsedOrder;

  doc.updatedBy = req.user._id;
  await doc.save({ validateModifiedOnly: true });
  sortVarieties(doc.varieties);

  return res.status(200).json(generateResponse('Success', 'Plant updated successfully', doc, undefined));
});

export const deleteBiotechPlant = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid ID format', 400));

  const doc = await RamBiotechSeedProduct.findById(id);
  if (!doc) return next(new AppError('Plant not found', 404));

  await RamBiotechSeedProduct.findByIdAndDelete(id);
  return res.status(200).json(generateResponse('Success', 'Plant deleted successfully', null, undefined));
});

export const addBiotechVariety = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid ID format', 400));

  let varietyData;
  try {
    varietyData = buildVarietyPayload(req.body);
  } catch (err) {
    return next(err instanceof AppError ? err : new AppError(err.message, 400));
  }

  const doc = await RamBiotechSeedProduct.findById(id);
  if (!doc) return next(new AppError('Plant not found', 404));

  const dup = doc.varieties.find((v) => v.name.toLowerCase() === varietyData.name.toLowerCase());
  if (dup) return next(new AppError('Variety with this name already exists', 409));

  doc.varieties.push(varietyData);
  const variety = doc.varieties[doc.varieties.length - 1];

  try {
    await syncProductForBiotechVariety({
      plantDoc: doc,
      variety,
      userId: req.user._id,
    });
  } catch (err) {
    doc.varieties.pull(variety._id);
    return next(new AppError(err.message || 'Failed to create inventory product', 400));
  }

  doc.updatedBy = req.user._id;
  await doc.save();
  sortVarieties(doc.varieties);

  const populated = await RamBiotechSeedProduct.findById(id)
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type')
    .lean();
  const [enriched] = await enrichBiotechSeedPlants([populated]);

  return res.status(201).json(generateResponse('Success', 'Variety added successfully', enriched, undefined));
});

export const updateBiotechVariety = catchAsync(async (req, res, next) => {
  const { id, varietyId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  let patch;
  try {
    patch = buildVarietyPayload(req.body, { requireName: false });
  } catch (err) {
    return next(err instanceof AppError ? err : new AppError(err.message, 400));
  }

  const doc = await RamBiotechSeedProduct.findById(id);
  if (!doc) return next(new AppError('Plant not found', 404));

  const variety = doc.varieties.id(varietyId);
  if (!variety) return next(new AppError('Variety not found', 404));

  if (patch.name !== undefined) {
    const dup = doc.varieties.find(
      (v) => String(v._id) !== String(varietyId) && v.name.toLowerCase() === patch.name.toLowerCase()
    );
    if (dup) return next(new AppError('Variety with this name already exists', 409));
    variety.name = patch.name;
  }
  Object.assign(variety, patch);

  try {
    await syncProductForBiotechVariety({
      plantDoc: doc,
      variety,
      userId: req.user._id,
    });
  } catch (err) {
    return next(new AppError(err.message || 'Failed to sync inventory product', 400));
  }

  doc.updatedBy = req.user._id;
  await doc.save();
  sortVarieties(doc.varieties);

  const populated = await RamBiotechSeedProduct.findById(id)
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type')
    .lean();
  const [enriched] = await enrichBiotechSeedPlants([populated]);

  return res.status(200).json(generateResponse('Success', 'Variety updated successfully', enriched, undefined));
});

export const deleteBiotechVariety = catchAsync(async (req, res, next) => {
  const { id, varietyId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const doc = await RamBiotechSeedProduct.findById(id);
  if (!doc) return next(new AppError('Plant not found', 404));

  const variety = doc.varieties.id(varietyId);
  if (!variety) return next(new AppError('Variety not found', 404));

  doc.varieties.pull(varietyId);
  doc.updatedBy = req.user._id;
  await doc.save();

  return res.status(200).json(generateResponse('Success', 'Variety deleted successfully', doc, undefined));
});
