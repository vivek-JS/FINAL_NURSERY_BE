import catchAsync from '../utility/catchAsync.js';
import AppError from '../utility/appError.js';
import generateResponse from '../utility/responseFormat.js';
import PlantProductMapping from '../models/plantProductMapping.model.js';
import PlantSlot from '../models/slots.model.js';
import moment from 'moment';

// Create plant product mapping
export const createPlantProductMapping = catchAsync(async (req, res, next) => {
  const { productId, plantId, subtypeId, dateRange, displayTitle, notes, totalQuantity } = req.body;

  // Validation
  if (!productId || !plantId || !subtypeId) {
    return next(new AppError('Product ID, Plant ID, and Subtype ID are required', 400));
  }

  if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
    return next(new AppError('Date range (startDate and endDate) is required', 400));
  }

  if (!displayTitle || displayTitle.trim() === '') {
    return next(new AppError('Display title is required', 400));
  }

  // Validate date format
  const startDate = moment(dateRange.startDate, "DD-MM-YYYY", true);
  const endDate = moment(dateRange.endDate, "DD-MM-YYYY", true);

  if (!startDate.isValid() || !endDate.isValid()) {
    return next(new AppError('Invalid date format. Use DD-MM-YYYY', 400));
  }

  if (!endDate.isAfter(startDate) && !endDate.isSame(startDate, 'day')) {
    return next(new AppError('End date must be after or equal to start date', 400));
  }

  // Check for duplicate mapping (same product, plant, subtype, and overlapping date range)
  const existingMapping = await PlantProductMapping.findOne({
    productId,
    plantId,
    subtypeId,
    isActive: true,
    $or: [
      {
        'dateRange.startDate': { $lte: dateRange.endDate },
        'dateRange.endDate': { $gte: dateRange.startDate },
      },
    ],
  });

  if (existingMapping) {
    return next(
      new AppError(
        'A mapping already exists for this product, plant, and subtype with overlapping date range',
        409
      )
    );
  }

  const mapping = await PlantProductMapping.create({
    productId,
    plantId,
    subtypeId,
    dateRange: {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    },
    displayTitle: displayTitle.trim(),
    notes: notes?.trim(),
    totalQuantity: totalQuantity || 0, // Total stock quantity available
    allocatedQuantity: 0, // Will be updated when orders are placed
    createdBy: req.user._id,
  });

  await mapping.populate('productId', 'name code category');
  await mapping.populate('plantId', 'name');

  const response = generateResponse(
    'Success',
    'Plant product mapping created successfully',
    mapping,
    undefined
  );

  return res.status(201).json(response);
});

// Get all plant product mappings
export const getAllPlantProductMappings = catchAsync(async (req, res, next) => {
  const { isActive, productId, plantId, subtypeId, checkDate } = req.query;

  const query = {};

  if (isActive !== undefined && isActive !== '') {
    query.isActive = isActive === 'true' || isActive === true;
  }

  if (productId) {
    query.productId = productId;
  }

  if (plantId) {
    query.plantId = plantId;
  }

  if (subtypeId) {
    query.subtypeId = subtypeId;
  }

  // If checkDate is provided, filter by date range
  if (checkDate) {
    const dateStr = moment(checkDate).format("DD-MM-YYYY");
    query['dateRange.startDate'] = { $lte: dateStr };
    query['dateRange.endDate'] = { $gte: dateStr };
  }

  const mappings = await PlantProductMapping.find(query)
    .populate('productId', 'name code category')
    .populate('plantId', 'name')
    .populate('createdBy', 'name')
    .populate('updatedBy', 'name')
    .sort({ createdAt: -1 })
    .lean();

  const response = generateResponse(
    'Success',
    'Plant product mappings fetched successfully',
    mappings,
    undefined
  );

  return res.status(200).json(response);
});

// Get plant product mappings by plant and subtype
export const getMappingsByPlantAndSubtype = catchAsync(async (req, res, next) => {
  const { plantId, subtypeId } = req.params;
  const { checkDate } = req.query;

  if (!plantId || !subtypeId) {
    return next(new AppError('Plant ID and Subtype ID are required', 400));
  }

  // Use static method to find active mappings
  let mappings;
  if (checkDate) {
    const date = moment(checkDate).toDate();
    mappings = await PlantProductMapping.findActiveByPlantAndSubtype(plantId, subtypeId, date);
  } else {
    mappings = await PlantProductMapping.findActiveByPlantAndSubtype(plantId, subtypeId);
  }

  // Enrich mappings with available stock from slots
  const enrichedMappings = await Promise.all(
    mappings.map(async (mapping) => {
      try {
        // Find all slots for this plant and subtype
        const slotDocs = await PlantSlot.find({
          plantId: plantId,
          'subtypeSlots.subtypeId': subtypeId,
        }).lean();

        let totalAvailable = 0;
        let totalBooked = 0;
        let totalPOQuantity = 0;
        let totalReceived = 0;

        // Calculate stock across all slots
        slotDocs.forEach((slotDoc) => {
          if (slotDoc.subtypeSlots && Array.isArray(slotDoc.subtypeSlots)) {
            slotDoc.subtypeSlots.forEach((subtypeSlot) => {
              if (subtypeSlot.subtypeId && subtypeSlot.subtypeId.toString() === subtypeId.toString()) {
                if (subtypeSlot.slots && Array.isArray(subtypeSlot.slots)) {
                  subtypeSlot.slots.forEach((slot) => {
                    if (slot.productStock && Array.isArray(slot.productStock)) {
                      // Find productStock entry matching this mapping
                      const productStock = slot.productStock.find(
                        (ps) =>
                          ps.productMappingId &&
                          ps.productMappingId.toString() === mapping._id.toString()
                      );

                      if (productStock) {
                        // Calculate available (received - booked)
                        const receivedAvailable = Math.max(0, (productStock.available || 0) - (productStock.booked || 0));
                        const pendingAvailable = productStock.poQuantity || 0;
                        totalAvailable += receivedAvailable + pendingAvailable;
                        totalBooked += productStock.booked || 0;
                        totalPOQuantity += productStock.poQuantity || 0;
                        totalReceived += productStock.available || 0;
                      }
                    }
                  });
                }
              }
            });
          }
        });

        // Calculate available from mapping's totalQuantity minus allocated
        const mappingAvailable = Math.max(0, (mapping.totalQuantity || 0) - (mapping.allocatedQuantity || 0));
        
        // Return mapping with stock information
        return {
          ...mapping.toObject ? mapping.toObject() : mapping,
          stockInfo: {
            totalAvailable: Math.max(mappingAvailable, totalAvailable), // Use mapping's totalQuantity as source of truth
            totalBooked: totalBooked,
            totalPOQuantity: totalPOQuantity,
            totalReceived: totalReceived,
            receivedAvailable: Math.max(0, totalReceived - totalBooked),
            pendingAvailable: totalPOQuantity,
            mappingTotalQuantity: mapping.totalQuantity || 0,
            mappingAllocatedQuantity: mapping.allocatedQuantity || 0,
            mappingAvailableQuantity: mappingAvailable,
          },
        };
      } catch (error) {
        console.error(`Error calculating stock for mapping ${mapping._id}:`, error);
        // Return mapping without stock info if calculation fails
        return {
          ...mapping.toObject ? mapping.toObject() : mapping,
          stockInfo: {
            totalAvailable: 0,
            totalBooked: 0,
            totalPOQuantity: 0,
            totalReceived: 0,
            receivedAvailable: 0,
            pendingAvailable: 0,
          },
        };
      }
    })
  );

  const response = generateResponse(
    'Success',
    'Plant product mappings fetched successfully',
    enrichedMappings,
    undefined
  );

  return res.status(200).json(response);
});

// Get plant product mapping by ID
export const getPlantProductMappingById = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const mapping = await PlantProductMapping.findById(id)
    .populate('productId', 'name code category')
    .populate('plantId', 'name')
    .populate('createdBy', 'name')
    .populate('updatedBy', 'name');

  if (!mapping) {
    return next(new AppError('Plant product mapping not found', 404));
  }

  const response = generateResponse(
    'Success',
    'Plant product mapping fetched successfully',
    mapping,
    undefined
  );

  return res.status(200).json(response);
});

// Update plant product mapping
export const updatePlantProductMapping = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { dateRange, displayTitle, isActive, notes, totalQuantity } = req.body;

  const mapping = await PlantProductMapping.findById(id);

  if (!mapping) {
    return next(new AppError('Plant product mapping not found', 404));
  }

  // Validate date range if provided
  if (dateRange) {
    if (dateRange.startDate && dateRange.endDate) {
      const startDate = moment(dateRange.startDate, "DD-MM-YYYY", true);
      const endDate = moment(dateRange.endDate, "DD-MM-YYYY", true);

      if (!startDate.isValid() || !endDate.isValid()) {
        return next(new AppError('Invalid date format. Use DD-MM-YYYY', 400));
      }

      if (!endDate.isAfter(startDate) && !endDate.isSame(startDate, 'day')) {
        return next(new AppError('End date must be after or equal to start date', 400));
      }

      mapping.dateRange = {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      };
    }
  }

  if (displayTitle !== undefined) {
    mapping.displayTitle = displayTitle.trim();
  }

  if (isActive !== undefined) {
    mapping.isActive = isActive;
  }

  if (notes !== undefined) {
    mapping.notes = notes?.trim();
  }

  if (totalQuantity !== undefined) {
    mapping.totalQuantity = totalQuantity;
  }

  mapping.updatedBy = req.user._id;

  await mapping.save();

  await mapping.populate('productId', 'name code category');
  await mapping.populate('plantId', 'name');

  const response = generateResponse(
    'Success',
    'Plant product mapping updated successfully',
    mapping,
    undefined
  );

  return res.status(200).json(response);
});

// Delete plant product mapping
export const deletePlantProductMapping = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const mapping = await PlantProductMapping.findById(id);

  if (!mapping) {
    return next(new AppError('Plant product mapping not found', 404));
  }

  // Soft delete by setting isActive to false instead of hard delete
  // This preserves data integrity for existing orders
  mapping.isActive = false;
  mapping.updatedBy = req.user._id;
  await mapping.save();

  const response = generateResponse(
    'Success',
    'Plant product mapping deleted successfully',
    null,
    undefined
  );

  return res.status(200).json(response);
});

