import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import RamAgriBatch from '../models/ramAgriBatch.model.js';
import RamAgriInputsProduct from '../models/ramAgriInputsProduct.model.js';
import mongoose from 'mongoose';

async function populateSupplierName(supplierId) {
  if (!supplierId) return null;
  const id = supplierId.toString();
  const { default: Supplier } = await import('../models/supplier.model.js');
  const { default: Merchant } = await import('../models/merchant.model.js');
  const supplierDoc = await Supplier.findById(id).select('name').lean();
  if (supplierDoc) return { _id: supplierDoc._id, name: supplierDoc.name };
  const merchant = await Merchant.findById(id).select('name').lean();
  if (merchant) return { _id: merchant._id, name: merchant.name };
  return { _id: supplierId, name: 'N/A' };
}

async function enrichBatch(batch, cropMap) {
  const cropKey = `${batch.ramAgriCropId}_${batch.ramAgriVarietyId}`;
  const meta = cropMap.get(cropKey) || {};
  const supplier = await populateSupplierName(batch.supplier);
  return {
    ...batch,
    cropName: meta.cropName || '',
    varietyName: meta.varietyName || '',
    productType: meta.productType || '',
    supplier,
  };
}

async function buildCropMap(batches) {
  const cropIds = [...new Set(batches.map((b) => b.ramAgriCropId?.toString()).filter(Boolean))];
  const crops = await RamAgriInputsProduct.find({ _id: { $in: cropIds } })
    .select('cropName productType varieties._id varieties.name')
    .lean();
  const map = new Map();
  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      map.set(`${crop._id}_${v._id}`, {
        cropName: crop.cropName,
        varietyName: v.name,
        productType: crop.productType,
      });
    }
  }
  return map;
}

export const getAllRamAgriBatches = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.cropId && mongoose.isValidObjectId(req.query.cropId)) {
    filter.ramAgriCropId = req.query.cropId;
  }
  if (req.query.varietyId && mongoose.isValidObjectId(req.query.varietyId)) {
    filter.ramAgriVarietyId = req.query.varietyId;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.batchNumber) {
    filter.batchNumber = { $regex: req.query.batchNumber.trim(), $options: 'i' };
  }

  if (req.query.productType) {
    const crops = await RamAgriInputsProduct.find({ productType: req.query.productType })
      .select('_id')
      .lean();
    filter.ramAgriCropId = { $in: crops.map((c) => c._id) };
  }

  const [total, batchDocs] = await Promise.all([
    RamAgriBatch.countDocuments(filter),
    RamAgriBatch.find(filter)
      .populate('unit', 'name abbreviation')
      .sort({ receivedDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const cropMap = await buildCropMap(batchDocs);
  const data = await Promise.all(batchDocs.map((b) => enrichBatch(b, cropMap)));

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

export const getRamAgriVarietyBatches = catchAsync(async (req, res, next) => {
  const { cropId, varietyId } = req.params;
  if (!mongoose.isValidObjectId(cropId) || !mongoose.isValidObjectId(varietyId)) {
    return next(new AppError('Invalid crop or variety ID', 400));
  }

  const batchDocs = await RamAgriBatch.find({
    ramAgriCropId: cropId,
    ramAgriVarietyId: varietyId,
  })
    .populate('unit', 'name abbreviation')
    .sort({ receivedDate: -1 })
    .lean();

  const cropMap = await buildCropMap(batchDocs);
  const data = await Promise.all(batchDocs.map((b) => enrichBatch(b, cropMap)));

  res.json({ success: true, data });
});

export const getRamAgriBatchSummary = catchAsync(async (req, res) => {
  const match = { remainingQuantity: { $gt: 0 }, status: { $in: ['active', 'expired'] } };
  if (req.query.cropId && mongoose.isValidObjectId(req.query.cropId)) {
    match.ramAgriCropId = new mongoose.Types.ObjectId(req.query.cropId);
  }

  const rows = await RamAgriBatch.aggregate([
    { $match: match },
    {
      $group: {
        _id: { cropId: '$ramAgriCropId', varietyId: '$ramAgriVarietyId' },
        totalQty: { $sum: '$remainingQuantity' },
        activeBatchCount: { $sum: 1 },
        nearestExpiry: { $min: '$expiryDate' },
      },
    },
  ]);

  const cropIds = [...new Set(rows.map((r) => r._id.cropId?.toString()).filter(Boolean))];
  const crops = await RamAgriInputsProduct.find({ _id: { $in: cropIds } })
    .select('cropName productType varieties._id varieties.name')
    .lean();

  const nameMap = new Map();
  for (const crop of crops) {
    for (const v of crop.varieties || []) {
      nameMap.set(`${crop._id}_${v._id}`, {
        cropName: crop.cropName,
        varietyName: v.name,
        productType: crop.productType,
      });
    }
  }

  const data = rows.map((r) => {
    const key = `${r._id.cropId}_${r._id.varietyId}`;
    const names = nameMap.get(key) || {};
    return {
      ramAgriCropId: r._id.cropId,
      ramAgriVarietyId: r._id.varietyId,
      cropName: names.cropName,
      varietyName: names.varietyName,
      productType: names.productType,
      totalQty: r.totalQty,
      activeBatchCount: r.activeBatchCount,
      nearestExpiry: r.nearestExpiry,
    };
  });

  res.json({ success: true, data });
});
