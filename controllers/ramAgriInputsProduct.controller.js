import mongoose from 'mongoose';
import RamAgriInputsProduct from '../models/ramAgriInputsProduct.model.js';
import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import generateResponse from '../utility/responseFormat.js';
import {
  createChangeLog,
  generateChangesArray,
} from '../utils/changeLogHelper.js';

const normalizeProductType = (value, { allowAll = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    return 'seed';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'seeds') return 'seed';
  if (normalized === 'chemicals') return 'chemical';
  if (normalized === 'seed' || normalized === 'chemical') {
    return normalized;
  }
  if (normalized === 'all') return allowAll ? 'all' : null;
  return null;
};

// Create crop
export const createCrop = catchAsync(async (req, res, next) => {
  const { cropName, description, varieties, productType } = req.body;

  if (!cropName || !cropName.trim()) {
    return next(new AppError('Crop name is required', 400));
  }

  const normalizedType = normalizeProductType(productType);
  if (productType && (!normalizedType || normalizedType === 'all')) {
    return next(new AppError('Invalid product type. Use "seed" or "chemical"', 400));
  }
  const finalProductType = normalizedType || 'seed';

  // Check if crop already exists
  const existingQuery = { cropName: cropName.trim() };
  if (finalProductType === 'seed') {
    existingQuery.$or = [{ productType: 'seed' }, { productType: { $exists: false } }];
  } else {
    existingQuery.productType = finalProductType;
  }

  const existingCrop = await RamAgriInputsProduct.findOne(existingQuery);

  if (existingCrop) {
    return next(new AppError('Crop with this name already exists', 409));
  }

  const crop = await RamAgriInputsProduct.create({
    productType: finalProductType,
    cropName: cropName.trim(),
    description: description?.trim() || '',
    varieties: varieties || [],
    createdBy: req.user._id,
  });

  const response = generateResponse(
    'Success',
    'Crop created successfully',
    crop,
    undefined
  );

  return res.status(201).json(response);
});

// Get all crops
export const getAllCrops = catchAsync(async (req, res, next) => {
  const { search, isActive, productType } = req.query;
  const query = {};
  let typeFilter = null;

  if (search) {
    query.$or = [
      { cropName: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { 'varieties.name': { $regex: search, $options: 'i' } },
    ];
  }

  if (isActive !== undefined) {
    query.isActive = isActive === 'true';
  }

  if (productType !== undefined) {
    const normalizedType = normalizeProductType(productType, { allowAll: true });
    if (!normalizedType) {
      return next(new AppError('Invalid product type. Use "seed" or "chemical"', 400));
    }
    if (normalizedType === 'seed') {
      typeFilter = {
        $or: [{ productType: 'seed' }, { productType: { $exists: false } }],
      };
    } else if (normalizedType === 'chemical') {
      typeFilter = { productType: 'chemical' };
    }
  }

  if (typeFilter) {
    if (query.$or) {
      query.$and = [{ $or: query.$or }, typeFilter];
      delete query.$or;
    } else {
      Object.assign(query, typeFilter);
    }
  }

  const crops = await RamAgriInputsProduct.find(query)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type')
    .sort({ createdAt: -1 });

  const response = generateResponse(
    'Success',
    'Crops fetched successfully',
    crops,
    undefined
  );

  return res.status(200).json(response);
});

// Get crop by ID
export const getCropById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type');

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const response = generateResponse(
    'Success',
    'Crop fetched successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Update crop
export const updateCrop = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { cropName, description, isActive, productType } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const normalizedType = productType !== undefined ? normalizeProductType(productType) : null;
  if (productType !== undefined && (!normalizedType || normalizedType === 'all')) {
    return next(new AppError('Invalid product type. Use "seed" or "chemical"', 400));
  }
  const nextProductType = normalizedType || crop.productType || 'seed';

  // Check if crop name is being changed and if it already exists
  if ((cropName && cropName.trim() !== crop.cropName) || (normalizedType && normalizedType !== crop.productType)) {
    const existingQuery = {
      cropName: cropName ? cropName.trim() : crop.cropName,
      _id: { $ne: id },
    };
    if (nextProductType === 'seed') {
      existingQuery.$or = [{ productType: 'seed' }, { productType: { $exists: false } }];
    } else {
      existingQuery.productType = nextProductType;
    }

    const existingCrop = await RamAgriInputsProduct.findOne(existingQuery);

    if (existingCrop) {
      return next(new AppError('Crop with this name already exists', 409));
    }

    crop.cropName = cropName.trim();
  }

  if (description !== undefined) crop.description = description?.trim() || '';
  if (isActive !== undefined) crop.isActive = isActive;
  if (normalizedType) crop.productType = normalizedType;

  crop.updatedBy = req.user._id;
  await crop.save();

  const response = generateResponse(
    'Success',
    'Crop updated successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Delete crop
export const deleteCrop = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  // Log the change before deleting
  await createChangeLog({
    entityType: 'crop',
    entityId: crop._id,
    action: 'delete',
    changedBy: req.user._id,
    changes: [
      { field: 'cropName', oldValue: crop.cropName, newValue: null },
      { field: 'description', oldValue: crop.description, newValue: null },
      { field: 'isActive', oldValue: crop.isActive, newValue: null },
    ],
    description: `Crop "${crop.cropName}" deleted`,
    metadata: { cropName: crop.cropName, varietiesCount: crop.varieties?.length || 0 },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  await RamAgriInputsProduct.findByIdAndDelete(id);

  const response = generateResponse(
    'Success',
    'Crop deleted successfully',
    null,
    undefined
  );

  return res.status(200).json(response);
});

// Add variety
export const addVariety = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, description, primaryUnit, secondaryUnit, conversionFactor, defaultRate, purchasePrice, isActive } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('Invalid ID format', 400));
  }

  if (!name || !name.trim()) {
    return next(new AppError('Variety name is required', 400));
  }

  if (!primaryUnit) {
    return next(new AppError('Primary unit is required', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id).select('varieties');

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  // Check if variety already exists
  const existingVariety = crop.varieties.find(
    (v) => v.name.toLowerCase() === name.trim().toLowerCase()
  );

  if (existingVariety) {
    return next(new AppError('Variety with this name already exists', 409));
  }

  const varietyData = {
    name: name.trim(),
    description: description?.trim() || '',
    primaryUnit,
    secondaryUnit: secondaryUnit || undefined,
    conversionFactor: conversionFactor || 1,
    isActive: isActive !== undefined ? isActive : true,
  };

  if (defaultRate !== undefined && defaultRate !== null && defaultRate !== '') {
    const rateValue = Number(defaultRate);
    if (isNaN(rateValue) || rateValue < 0) {
      return next(new AppError('Default rate must be a positive number', 400));
    }
    varietyData.defaultRate = rateValue;
  }
  
  if (purchasePrice !== undefined && purchasePrice !== null && purchasePrice !== '') {
    const priceValue = Number(purchasePrice);
    if (isNaN(priceValue) || priceValue < 0) {
      return next(new AppError('Purchase price must be a positive number', 400));
    }
    varietyData.purchasePrice = priceValue;
  }

  const updatedCrop = await RamAgriInputsProduct.findByIdAndUpdate(
    id,
    {
      $push: { varieties: varietyData },
      $set: { updatedBy: req.user._id },
    },
    {
      new: true,
      runValidators: true,
    }
  )
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email')
    .populate('varieties.primaryUnit', 'name abbreviation type')
    .populate('varieties.secondaryUnit', 'name abbreviation type');

  if (!updatedCrop) {
    return next(new AppError('Crop not found', 404));
  }

  const response = generateResponse(
    'Success',
    'Variety added successfully',
    updatedCrop,
    undefined
  );

  return res.status(200).json(response);
});

// Update variety
export const updateVariety = catchAsync(async (req, res, next) => {
  const { id, varietyId } = req.params;
  const { name, description, primaryUnit, secondaryUnit, conversionFactor, defaultRate, purchasePrice, isActive } = req.body;

  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const variety = crop.varieties.id(varietyId);

  if (!variety) {
    return next(new AppError('Variety not found', 404));
  }

  // Store old values for change log
  const oldData = {
    name: variety.name,
    description: variety.description,
    primaryUnit: variety.primaryUnit,
    secondaryUnit: variety.secondaryUnit,
    conversionFactor: variety.conversionFactor,
    defaultRate: variety.defaultRate,
    purchasePrice: variety.purchasePrice,
    isActive: variety.isActive,
  };

  // Check if variety name is being changed and if it already exists
  if (name && name.trim() !== variety.name) {
    const existingVariety = crop.varieties.find(
      (v) => v.name.toLowerCase() === name.trim().toLowerCase() && v._id.toString() !== varietyId
    );

    if (existingVariety) {
      return next(new AppError('Variety with this name already exists', 409));
    }

    variety.name = name.trim();
  }

  if (description !== undefined) variety.description = description?.trim() || '';
  if (primaryUnit !== undefined) variety.primaryUnit = primaryUnit;
  if (secondaryUnit !== undefined) variety.secondaryUnit = secondaryUnit || undefined;
  if (conversionFactor !== undefined) variety.conversionFactor = conversionFactor || 1;
  if (isActive !== undefined) variety.isActive = isActive;
  
  if (defaultRate !== undefined && defaultRate !== null && defaultRate !== '') {
    const rateValue = Number(defaultRate);
    if (isNaN(rateValue) || rateValue < 0) {
      return next(new AppError('Default rate must be a positive number', 400));
    }
    variety.defaultRate = rateValue;
  } else if (defaultRate === null || defaultRate === '') {
    // Allow clearing the default rate
    variety.defaultRate = undefined;
  }
  
  if (purchasePrice !== undefined && purchasePrice !== null && purchasePrice !== '') {
    const priceValue = Number(purchasePrice);
    if (isNaN(priceValue) || priceValue < 0) {
      return next(new AppError('Purchase price must be a positive number', 400));
    }
    variety.purchasePrice = priceValue;
  } else if (purchasePrice === null || purchasePrice === '') {
    // Allow clearing the purchase price
    variety.purchasePrice = undefined;
  }

  crop.updatedBy = req.user._id;
  await crop.save();

  // Log the change
  const newData = {
    name: variety.name,
    description: variety.description,
    primaryUnit: variety.primaryUnit,
    secondaryUnit: variety.secondaryUnit,
    conversionFactor: variety.conversionFactor,
    defaultRate: variety.defaultRate,
    purchasePrice: variety.purchasePrice,
    isActive: variety.isActive,
  };
  const changes = generateChangesArray(oldData, newData);
  if (changes.length > 0) {
    await createChangeLog({
      entityType: 'variety',
      entityId: variety._id,
      action: 'update',
      changedBy: req.user._id,
      changes,
      metadata: { cropId: crop._id, cropName: crop.cropName },
      description: `Variety "${variety.name}" updated in crop "${crop.cropName}"`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  const response = generateResponse(
    'Success',
    'Variety updated successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Delete variety
export const deleteVariety = catchAsync(async (req, res, next) => {
  const { id, varietyId } = req.params;

  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const variety = crop.varieties.id(varietyId);

  if (!variety) {
    return next(new AppError('Variety not found', 404));
  }

  // Log the change before deleting
  await createChangeLog({
    entityType: 'variety',
    entityId: variety._id,
    action: 'delete',
    changedBy: req.user._id,
    changes: [
      { field: 'name', oldValue: variety.name, newValue: null },
      { field: 'description', oldValue: variety.description, newValue: null },
      { field: 'isActive', oldValue: variety.isActive, newValue: null },
    ],
    metadata: { cropId: crop._id, cropName: crop.cropName },
    description: `Variety "${variety.name}" deleted from crop "${crop.cropName}"`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  crop.varieties.pull(varietyId);
  crop.updatedBy = req.user._id;
  await crop.save();

  const response = generateResponse(
    'Success',
    'Variety deleted successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Add rate to variety
export const addRate = catchAsync(async (req, res, next) => {
  const { id, varietyId } = req.params;
  const { minRate, maxRate, rate, startDate, endDate, season, notes } = req.body;

  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  // Support both new format (minRate/maxRate) and old format (rate) for backward compatibility
  let finalMinRate, finalMaxRate;
  if (minRate !== undefined && maxRate !== undefined) {
    finalMinRate = parseFloat(minRate);
    finalMaxRate = parseFloat(maxRate);
    if (isNaN(finalMinRate) || finalMinRate < 0) {
      return next(new AppError('Minimum rate is required and must be 0 or greater', 400));
    }
    if (isNaN(finalMaxRate) || finalMaxRate < 0) {
      return next(new AppError('Maximum rate is required and must be 0 or greater', 400));
    }
    if (finalMinRate > finalMaxRate) {
      return next(new AppError('Maximum rate must be greater than or equal to minimum rate', 400));
    }
  } else if (rate !== undefined) {
    // Backward compatibility: use rate as both min and max
    finalMinRate = parseFloat(rate);
    finalMaxRate = parseFloat(rate);
    if (isNaN(finalMinRate) || finalMinRate <= 0) {
      return next(new AppError('Rate is required and must be greater than 0', 400));
    }
  } else {
    return next(new AppError('Rate or minRate/maxRate is required', 400));
  }

  if (!startDate || !endDate) {
    return next(new AppError('Start date and end date are required', 400));
  }

  if (new Date(startDate) >= new Date(endDate)) {
    return next(new AppError('End date must be after start date', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const variety = crop.varieties.id(varietyId);

  if (!variety) {
    return next(new AppError('Variety not found', 404));
  }

  // Check for overlapping date ranges
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  const hasOverlap = variety.rates.some((existingRate) => {
    const existingStart = new Date(existingRate.startDate);
    const existingEnd = new Date(existingRate.endDate);
    return (
      (start >= existingStart && start <= existingEnd) ||
      (end >= existingStart && end <= existingEnd) ||
      (start <= existingStart && end >= existingEnd)
    );
  });

  if (hasOverlap) {
    return next(new AppError('Date range overlaps with an existing rate', 409));
  }

  // Calculate average rate for backward compatibility
  const avgRate = (finalMinRate + finalMaxRate) / 2;

  const rateData = {
    minRate: finalMinRate,
    maxRate: finalMaxRate,
    rate: avgRate, // For backward compatibility
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    season: season?.trim() || '',
    notes: notes?.trim() || '',
    createdBy: req.user._id,
  };

  variety.rates.push(rateData);
  crop.updatedBy = req.user._id;
  await crop.save();

  // Get the saved rate ID
  const savedRate = variety.rates[variety.rates.length - 1];

  // Log the change
  await createChangeLog({
    entityType: 'rate',
    entityId: savedRate._id,
    action: 'create',
    changedBy: req.user._id,
    changes: [
      { field: 'minRate', oldValue: null, newValue: rateData.minRate },
      { field: 'maxRate', oldValue: null, newValue: rateData.maxRate },
      { field: 'rate', oldValue: null, newValue: rateData.rate },
      { field: 'startDate', oldValue: null, newValue: rateData.startDate },
      { field: 'endDate', oldValue: null, newValue: rateData.endDate },
      { field: 'season', oldValue: null, newValue: rateData.season },
      { field: 'notes', oldValue: null, newValue: rateData.notes },
    ],
    metadata: {
      cropId: crop._id,
      cropName: crop.cropName,
      varietyId: variety._id,
      varietyName: variety.name,
    },
    description: `Rate ₹${finalMinRate} - ₹${finalMaxRate} added for variety "${variety.name}" in crop "${crop.cropName}"`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  const response = generateResponse(
    'Success',
    'Rate added successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Update rate
export const updateRate = catchAsync(async (req, res, next) => {
  const { id, varietyId, rateId } = req.params;
  const { rate, startDate, endDate, season, notes } = req.body;

  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId) || !mongoose.isValidObjectId(rateId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const variety = crop.varieties.id(varietyId);

  if (!variety) {
    return next(new AppError('Variety not found', 404));
  }

  const rateDoc = variety.rates.id(rateId);

  if (!rateDoc) {
    return next(new AppError('Rate not found', 404));
  }

  // Store old values for change log
  const oldData = {
    rate: rateDoc.rate,
    startDate: rateDoc.startDate,
    endDate: rateDoc.endDate,
    season: rateDoc.season,
    notes: rateDoc.notes,
  };

  // If dates are being updated, check for overlaps (excluding current rate)
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (start >= end) {
      return next(new AppError('End date must be after start date', 400));
    }

    const hasOverlap = variety.rates.some((existingRate) => {
      if (existingRate._id.toString() === rateId) return false; // Exclude current rate
      const existingStart = new Date(existingRate.startDate);
      const existingEnd = new Date(existingRate.endDate);
      return (
        (start >= existingStart && start <= existingEnd) ||
        (end >= existingStart && end <= existingEnd) ||
        (start <= existingStart && end >= existingEnd)
      );
    });

    if (hasOverlap) {
      return next(new AppError('Date range overlaps with an existing rate', 409));
    }

    rateDoc.startDate = new Date(startDate);
    rateDoc.endDate = new Date(endDate);
  }

  // Handle rate updates - support both new format (minRate/maxRate) and old format (rate)
  if (minRate !== undefined && maxRate !== undefined) {
    const finalMinRate = parseFloat(minRate);
    const finalMaxRate = parseFloat(maxRate);
    if (isNaN(finalMinRate) || finalMinRate < 0) {
      return next(new AppError('Minimum rate must be 0 or greater', 400));
    }
    if (isNaN(finalMaxRate) || finalMaxRate < 0) {
      return next(new AppError('Maximum rate must be 0 or greater', 400));
    }
    if (finalMinRate > finalMaxRate) {
      return next(new AppError('Maximum rate must be greater than or equal to minimum rate', 400));
    }
    rateDoc.minRate = finalMinRate;
    rateDoc.maxRate = finalMaxRate;
    rateDoc.rate = (finalMinRate + finalMaxRate) / 2; // Update average for backward compatibility
  } else if (rate !== undefined && rate > 0) {
    // Backward compatibility: use rate as both min and max
    const finalRate = parseFloat(rate);
    rateDoc.minRate = finalRate;
    rateDoc.maxRate = finalRate;
    rateDoc.rate = finalRate;
  }
  if (season !== undefined) rateDoc.season = season?.trim() || '';
  if (notes !== undefined) rateDoc.notes = notes?.trim() || '';

  crop.updatedBy = req.user._id;
  await crop.save();

  // Log the change
  const newData = {
    minRate: rateDoc.minRate,
    maxRate: rateDoc.maxRate,
    rate: rateDoc.rate,
    startDate: rateDoc.startDate,
    endDate: rateDoc.endDate,
    season: rateDoc.season,
    notes: rateDoc.notes,
  };
  const changes = generateChangesArray(oldData, newData);
  if (changes.length > 0) {
    await createChangeLog({
      entityType: 'rate',
      entityId: rateDoc._id,
      action: 'update',
      changedBy: req.user._id,
      changes,
      metadata: {
        cropId: crop._id,
        cropName: crop.cropName,
        varietyId: variety._id,
        varietyName: variety.name,
      },
      description: `Rate updated for variety "${variety.name}" in crop "${crop.cropName}"`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  const response = generateResponse(
    'Success',
    'Rate updated successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});

// Delete rate
export const deleteRate = catchAsync(async (req, res, next) => {
  const { id, varietyId, rateId } = req.params;

  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(varietyId) || !mongoose.isValidObjectId(rateId)) {
    return next(new AppError('Invalid ID format', 400));
  }

  const crop = await RamAgriInputsProduct.findById(id);

  if (!crop) {
    return next(new AppError('Crop not found', 404));
  }

  const variety = crop.varieties.id(varietyId);

  if (!variety) {
    return next(new AppError('Variety not found', 404));
  }

  const rateDoc = variety.rates.id(rateId);

  if (!rateDoc) {
    return next(new AppError('Rate not found', 404));
  }

  variety.rates.pull(rateId);
  crop.updatedBy = req.user._id;
  await crop.save();

  const response = generateResponse(
    'Success',
    'Rate deleted successfully',
    crop,
    undefined
  );

  return res.status(200).json(response);
});
