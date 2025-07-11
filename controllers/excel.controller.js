import catchAsync from '../utility/catchAsync.js';
import multer from 'multer';
import { importOrdersAndFarmers, validateExcelStructure } from './excel.serveces.controller.js';
import PlantSlot from '../models/slots.model.js';
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Please upload an Excel file (.xlsx or .xls)'));
    }
  }
}).single('file');

// Validation endpoint
export const validateExcel = catchAsync(async (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        status: 'error',
        message: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'Please upload an Excel file'
      });
    }

    try {
      const validationResults = validateExcelStructure(req.file.buffer);
      
      if (!validationResults.isValid) {
        return res.status(400).json({
          status: 'error',
          message: 'Excel validation failed',
          errors: validationResults.errors,
          warnings: validationResults.warnings,
          rowErrors: validationResults.rowErrors
        });
      }

      return res.status(200).json({
        status: 'success',
        message: 'Excel file is valid',
        warnings: validationResults.warnings
      });
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: 'Error validating file',
        error: error.message
      });
    }
  });
});

// Import endpoint
export const importExcelData = catchAsync(async (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        status: 'error',
        message: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: 'Please upload an Excel file'
      });
    }

    try {
      // First validate
      const validationResults = validateExcelStructure(req.file.buffer);
      
      if (!validationResults.isValid) {
        return res.status(400).json({
          status: 'error',
          message: 'Excel validation failed',
          errors: validationResults.errors,
          warnings: validationResults.warnings,
          rowErrors: validationResults.rowErrors
        });
      }

      // If valid, proceed with import
      const results = await importOrdersAndFarmers(req.file.buffer);

      return res.status(200).json({
        status: 'success',
        message: 'Data imported successfully',
        data: {
          summary: results.summary,
          successfulImports: results.success,
          failedImports: results.errors
        }
      });
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: 'Error processing file',
        error: error.message
      });
    }
  });
});

// Reset overflow slot endpoint
export const resetOverflowSlot = catchAsync(async (req, res) => {
  try {
    const { slotId, additionalCapacity } = req.body;
    
    if (!slotId || !additionalCapacity || additionalCapacity <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Slot ID and positive additional capacity are required'
      });
    }

    // Find the slot and update its capacity
    const updateResult = await PlantSlot.updateOne(
      { "subtypeSlots.slots._id": slotId },
      {
        $inc: {
          "subtypeSlots.$[subtypeSlot].slots.$[slot].totalPlants": additionalCapacity
        },
        $set: {
          "subtypeSlots.$[subtypeSlot].slots.$[slot].isOverflow": false,
          "subtypeSlots.$[subtypeSlot].slots.$[slot].overflow": false
        }
      },
      {
        arrayFilters: [
          { "subtypeSlot.slots._id": slotId },
          { "slot._id": slotId }
        ]
      }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Slot not found'
      });
    }

    // Get updated slot information
    const plantSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": slotId },
      { "subtypeSlots.$": 1 }
    ).populate('plantId', 'name');

    if (!plantSlot) {
      return res.status(404).json({
        status: 'error',
        message: 'Updated slot not found'
      });
    }

    const targetSlot = plantSlot.subtypeSlots[0].slots.find(
      (slot) => slot._id.toString() === slotId.toString()
    );

    return res.status(200).json({
      status: 'success',
      message: 'Overflow slot reset successfully',
      data: {
        slotId: targetSlot._id,
        plantName: plantSlot.plantId?.name,
        totalPlants: targetSlot.totalPlants,
        totalBookedPlants: targetSlot.totalBookedPlants,
        availablePlants: targetSlot.totalPlants,
        isOverflow: targetSlot.totalPlants < 0,
        startDay: targetSlot.startDay,
        endDay: targetSlot.endDay,
        month: targetSlot.month,
        additionalCapacityAdded: additionalCapacity
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Error resetting overflow slot',
      error: error.message
    });
  }
});

// Get overflow slots endpoint
export const getOverflowSlots = catchAsync(async (req, res) => {
  try {
    const { plantId, year, month } = req.query;
    
    let filter = {};
    
    if (plantId) {
      filter.plantId = plantId;
    }
    
    if (year) {
      filter.year = parseInt(year);
    }

    const plantSlots = await PlantSlot.find(filter)
      .populate('plantId', 'name')
      .lean();

    const overflowSlots = [];

    plantSlots.forEach(plantSlot => {
      plantSlot.subtypeSlots.forEach(subtypeSlot => {
        subtypeSlot.slots.forEach(slot => {
          if (slot.totalPlants < 0) {
            overflowSlots.push({
              plantName: plantSlot.plantId?.name || 'Unknown',
              plantId: plantSlot.plantId?._id,
              year: plantSlot.year,
              subtypeId: subtypeSlot.subtypeId,
              slotId: slot._id,
              startDay: slot.startDay,
              endDay: slot.endDay,
              month: slot.month,
              totalPlants: slot.totalPlants,
              totalBookedPlants: slot.totalBookedPlants,
              availablePlants: slot.totalPlants,
              overflowAmount: Math.abs(slot.totalPlants),
            });
          }
        });
      });
    });

    // Filter by month if provided
    const filteredOverflowSlots = month 
      ? overflowSlots.filter(slot => slot.month === month)
      : overflowSlots;

    return res.status(200).json({
      status: 'success',
      message: 'Overflow slots retrieved successfully',
      data: {
        totalOverflowSlots: filteredOverflowSlots.length,
        overflowSlots: filteredOverflowSlots,
        summary: {
          totalOverflowPlants: filteredOverflowSlots.reduce((sum, slot) => sum + slot.overflowAmount, 0),
          plantsWithOverflow: [...new Set(filteredOverflowSlots.map(slot => slot.plantName))],
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Error retrieving overflow slots',
      error: error.message
    });
  }
});