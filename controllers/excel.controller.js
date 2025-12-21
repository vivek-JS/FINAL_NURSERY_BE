import catchAsync from '../utility/catchAsync.js';
import multer from 'multer';
import { importOrdersAndFarmers, validateExcelStructure, processExcelRowsForValidation, importOrdersFromExcel, retryErrorfulOrders, readPasswordProtectedExcel } from './excel.serveces.controller.js';
import PlantSlot from '../models/slots.model.js';
import UnprocessedFile from '../models/unprocessedFile.model.js';
import ErrorfulOrder from '../models/errorfulOrder.model.js';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
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

// Validation endpoint - now processes rows and creates unprocessed rows file
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
      // Get password from request body if provided
      const password = req.body.password || null;
      
      // Handle password-protected files
      let processedBuffer = req.file.buffer;
      if (password) {
        console.log("🔐 Password provided for validation, attempting to decrypt Excel file...");
        try {
          processedBuffer = await readPasswordProtectedExcel(req.file.buffer, password);
          console.log("✅ Successfully decrypted password-protected Excel file for validation");
        } catch (passwordError) {
          console.error("❌ Error decrypting password-protected file:", passwordError.message);
          return res.status(400).json({
            status: 'error',
            message: `Failed to decrypt Excel file: ${passwordError.message}. Please check the password.`
          });
        }
      }
      
      // Step 1: Validate structure (don't block - just report)
      const validationResults = validateExcelStructure(processedBuffer);
      
      // Log validation results but NEVER block
      if (!validationResults.isValid) {
        console.warn('⚠️  Validation issues detected (non-blocking):', {
          errors: validationResults.errors,
          warnings: validationResults.warnings
        });
        console.log('✅ Validation endpoint will still return success - import can proceed');
      }

      // Step 2: Process rows to identify unprocessed ones
      let processResults;
      try {
        processResults = await processExcelRowsForValidation(processedBuffer);
      } catch (processError) {
        console.warn('⚠️  Process error (non-blocking):', processError);
        processResults = {
          totalRows: 0,
          processableRows: 0,
          unprocessedRows: [],
          errors: [processError.message]
        };
      }
      
      // Step 3: Create Excel file with unprocessed rows if any
      let unprocessedFileUrl = null;
      let unprocessedRowsCount = 0;
      
      if (processResults.unprocessedRows && processResults.unprocessedRows.length > 0) {
        unprocessedRowsCount = processResults.unprocessedRows.length;
        
        // Create Excel workbook with unprocessed rows
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(processResults.unprocessedRows);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Unprocessed Rows');
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `unprocessed-rows-${timestamp}.xlsx`;
        const filepath = path.join(process.cwd(), 'uploads', filename);
        
        // Ensure uploads directory exists
        const uploadsDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        // Write file
        XLSX.writeFile(workbook, filepath);
        
        // Generate URL for download
        unprocessedFileUrl = `/api/v1/excel/download-unprocessed/${filename}`;
      }

      // ALWAYS return success - validation is just for preview, never blocks
      return res.status(200).json({
        status: 'success',
        message: validationResults.isValid 
          ? 'Excel file validated successfully' 
          : 'Excel file has validation issues but import can proceed',
        data: {
          totalRows: processResults.totalRows || 0,
          processableRows: processResults.processableRows || 0,
          unprocessedRowsCount: unprocessedRowsCount,
          unprocessedFileUrl: unprocessedFileUrl,
          warnings: validationResults.warnings || [],
          errors: validationResults.errors || [], // These are just informational, not blocking
          rowErrors: processResults.errors || []
        }
      });
    } catch (error) {
      console.error('Validation endpoint error:', error);
      // Even on error, return success so import can proceed
      return res.status(200).json({
        status: 'success',
        message: 'Validation encountered issues but import can proceed',
        data: {
          totalRows: 0,
          processableRows: 0,
          unprocessedRowsCount: 0,
          unprocessedFileUrl: null,
          warnings: [],
          errors: [error.message],
          rowErrors: []
        }
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
      // Read the Excel file to get original data for unprocessed rows file
      const workbook = XLSX.read(req.file.buffer, {
        type: "buffer",
        cellDates: true,
        raw: true,
      });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const originalData = XLSX.utils.sheet_to_json(worksheet, {
        raw: true,
        dateNF: "DD-MM-YYYY",
        defval: "",
      });

      // Validate structure (but NEVER block import - always proceed)
      let validationResults;
      try {
        validationResults = validateExcelStructure(req.file.buffer);
        console.log('📋 Validation completed:', {
          isValid: validationResults.isValid,
          errorsCount: validationResults.errors?.length || 0,
          warningsCount: validationResults.warnings?.length || 0
        });
      } catch (validationError) {
        console.warn('⚠️  Validation error (non-blocking):', validationError);
        validationResults = {
          isValid: false,
          errors: [validationError.message],
          warnings: [],
          rowErrors: []
        };
      }
      
      // CRITICAL: ALWAYS proceed with import regardless of validation result
      // Log validation results but NEVER block import
      if (!validationResults.isValid) {
        console.warn('⚠️  Validation issues detected, but proceeding with import anyway:', {
          errors: validationResults.errors,
          warnings: validationResults.warnings,
          rowErrors: validationResults.rowErrors
        });
        console.log('✅ IMPORT WILL PROCEED - Invalid rows will be skipped, valid rows will be imported');
      } else {
        console.log('✅ Validation passed, proceeding with import');
      }

      // Create unprocessed rows file DURING processing (not after)
      // This allows the download link to be available immediately
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `unprocessed-rows-${timestamp}.xlsx`;
      const filepath = path.join(process.cwd(), 'uploads', filename);
      
      // Ensure uploads directory exists
      const uploadsDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      // Proceed with import (it will skip invalid rows)
      // Always proceed even if validation failed - import function handles errors gracefully
      let results;
      let unprocessedRows = [];
      let unprocessedFileUrl = null;
      let unprocessedRowsCount = 0;
      
      try {
        // Generate import batch ID for this import session
        const importBatchId = `import-${Date.now()}`;
        results = await importOrdersAndFarmers(req.file.buffer, {
          importBatchId: importBatchId,
          sourceFilename: req.file.originalname || 'unknown.xlsx',
        });
        
        // Create unprocessed rows file from failed imports
        if (results.errors && results.errors.length > 0) {
          // Map failed imports back to original rows
          const failedBookingNos = new Set();
          const failedOrderIds = new Set();
          
          // Add all failed booking numbers and orderIds to set (handle different formats)
          results.errors.forEach(err => {
            if (err.bookingNo) {
              failedBookingNos.add(err.bookingNo.toString());
              failedBookingNos.add(parseInt(err.bookingNo));
              failedBookingNos.add(err.bookingNo);
            }
            if (err.orderId) {
              failedOrderIds.add(err.orderId.toString());
              failedOrderIds.add(parseInt(err.orderId));
              failedOrderIds.add(err.orderId);
            }
          });
          
          originalData.forEach((row, index) => {
            const bookingNo = row["Booking NO."];
            const bookingNoStr = bookingNo?.toString().trim();
            const bookingNoInt = bookingNo ? parseInt(bookingNo) : null;
            
            // Parse orderId from booking number
            let orderId = null;
            try {
              const parseOrderId = (bookingNo) => {
                if (!bookingNo) return null;
                const bookingStr = bookingNo.toString().trim();
                const numericValue = parseInt(bookingStr, 10);
                if (numericValue === 0) return null;
                const newFormatMatch = bookingStr.match(/^(\d{4})\/(\d+)$/);
                if (newFormatMatch) {
                  const year = newFormatMatch[1];
                  const sequence = newFormatMatch[2];
                  return parseInt(`${year}${sequence.padStart(3, '0')}`, 10);
                }
                const oldFormatMatch = bookingStr.match(/^(\d{2})-(\d{2})\/B(\d+)$/);
                if (oldFormatMatch) {
                  const startYear = oldFormatMatch[1];
                  const endYear = oldFormatMatch[2];
                  const sequence = oldFormatMatch[3];
                  return parseInt(`${startYear}${endYear}${sequence.padStart(3, '0')}`, 10);
                }
                const numericMatch = bookingStr.match(/^(\d+)$/);
                if (numericMatch) return parseInt(numericMatch[1], 10);
                return null;
              };
              orderId = parseOrderId(bookingNo);
            } catch (e) {
              // Ignore parsing errors
            }
            
            // Check if this row failed (by bookingNo or orderId)
            const isFailedByBooking = failedBookingNos.has(bookingNoStr) || 
                                      failedBookingNos.has(bookingNoInt) ||
                                      failedBookingNos.has(bookingNo);
            
            const isFailedByOrderId = orderId && (
              failedOrderIds.has(orderId.toString()) ||
              failedOrderIds.has(orderId) ||
              failedOrderIds.has(parseInt(orderId))
            );
            
            if (isFailedByBooking || isFailedByOrderId) {
              // Find the error message for this booking or orderId
              const error = results.errors.find(err => {
                const errBooking = err.bookingNo?.toString();
                const errOrderId = err.orderId?.toString();
                return errBooking === bookingNoStr || 
                       errBooking === bookingNoInt?.toString() ||
                       err.bookingNo === bookingNo ||
                       err.bookingNo === bookingNoInt ||
                       (orderId && (errOrderId === orderId.toString() || err.orderId === orderId));
              });
              unprocessedRows.push({
                ...row,
                "Error": error?.error || "Failed to import"
              });
            }
          });
          
          if (unprocessedRows.length > 0) {
            unprocessedRowsCount = unprocessedRows.length;
            
            // Create Excel workbook with unprocessed rows
            const unprocessedWorkbook = XLSX.utils.book_new();
            const unprocessedWorksheet = XLSX.utils.json_to_sheet(unprocessedRows);
            XLSX.utils.book_append_sheet(unprocessedWorkbook, unprocessedWorksheet, 'Unprocessed Rows');
            
            // Write file
            XLSX.writeFile(unprocessedWorkbook, filepath);
            
            // Generate URL for download
            unprocessedFileUrl = `/api/v1/excel/download-unprocessed/${filename}`;
            console.log(`📄 Created unprocessed rows file: ${filename} (${unprocessedRowsCount} rows)`);
            
            // Save file metadata to database
            try {
              await UnprocessedFile.create({
                filename: filename,
                originalFilename: req.file?.originalname || 'unknown.xlsx',
                filepath: filepath,
                unprocessedRowsCount: unprocessedRowsCount,
                totalRows: originalData.length,
                successfulImports: results.summary?.successfulImports || 0,
                failedImports: results.summary?.failedImports || 0,
                uploadedBy: req.user?._id || null,
                uploadedByName: req.user?.name || 'System',
                importSummary: results.summary || {},
                errors: results.errors || [],
                downloadUrl: unprocessedFileUrl,
                isDownloaded: false,
              });
              console.log(`✅ Saved unprocessed file metadata to database: ${filename}`);
            } catch (dbError) {
              console.error('❌ Error saving unprocessed file metadata:', dbError);
              // Continue even if DB save fails
            }
          }
        }
      } catch (importError) {
        console.error('Import error:', importError);
        // If import completely fails, create unprocessed file with all rows
        unprocessedRows = originalData.map((row, index) => ({
          ...row,
          "Error": importError.message || "Import failed"
        }));
        unprocessedRowsCount = unprocessedRows.length;
        
        // Create Excel workbook with all rows as unprocessed
        const unprocessedWorkbook = XLSX.utils.book_new();
        const unprocessedWorksheet = XLSX.utils.json_to_sheet(unprocessedRows);
        XLSX.utils.book_append_sheet(unprocessedWorkbook, unprocessedWorksheet, 'Unprocessed Rows');
        XLSX.writeFile(unprocessedWorkbook, filepath);
        unprocessedFileUrl = `/api/v1/excel/download-unprocessed/${filename}`;
        
        // Save file metadata to database
        try {
          await UnprocessedFile.create({
            filename: filename,
            originalFilename: req.file?.originalname || 'unknown.xlsx',
            filepath: filepath,
            unprocessedRowsCount: unprocessedRowsCount,
            totalRows: originalData.length,
            successfulImports: 0,
            failedImports: originalData.length,
            uploadedBy: req.user?._id || null,
            uploadedByName: req.user?.name || 'System',
            importSummary: {
              totalProcessed: originalData.length,
              successfulImports: 0,
              failedImports: originalData.length,
              overflowSlots: 0,
              invalidPhoneNumbers: 0,
            },
            errors: results.errors || [],
            downloadUrl: unprocessedFileUrl,
            isDownloaded: false,
          });
        } catch (dbError) {
          console.error('❌ Error saving unprocessed file metadata:', dbError);
        }
        
        results = {
          success: [],
          errors: originalData.map((row, index) => ({
            bookingNo: row["Booking NO."] || `Row ${index + 2}`,
            error: importError.message || "Import failed"
          })),
          summary: {
            totalProcessed: originalData.length,
            successfulImports: 0,
            failedImports: originalData.length,
            overflowSlots: 0,
            invalidPhoneNumbers: 0,
          },
          generatedOrderIds: []
        };
      }

      // Always return success - import proceeded, even if some rows failed
      const successMessage = results.summary.successfulImports > 0
        ? `Import completed: ${results.summary.successfulImports} successful, ${results.summary.failedImports} failed`
        : `Import attempted: ${results.summary.failedImports} rows failed to import`;

      return res.status(200).json({
        status: 'success',
        message: successMessage,
        data: {
          summary: results.summary,
          successfulImports: results.success,
          failedImports: results.errors,
          generatedOrderIds: results.generatedOrderIds || [],
          validationWarnings: validationResults.warnings || [],
          validationErrors: validationResults.errors || [],
          unprocessedRowsCount: unprocessedRowsCount,
          unprocessedFileUrl: unprocessedFileUrl,
          notes: results.summary.invalidPhoneNumbers > 0 
            ? `${results.summary.invalidPhoneNumbers} entries were created with invalid/missing phone numbers and marked with isInvalidPhone flag`
            : null
        }
      });
    } catch (error) {
      console.error('Import endpoint error:', error);
      // Even on error, try to return partial results if available
      return res.status(200).json({
        status: 'success',
        message: 'Import completed with errors',
        data: {
          summary: {
            totalProcessed: 0,
            successfulImports: 0,
            failedImports: 0,
            overflowSlots: 0,
            invalidPhoneNumbers: 0,
          },
          successfulImports: [],
          failedImports: [{ bookingNo: 'Unknown', error: error.message }],
          generatedOrderIds: [],
          validationWarnings: [],
          validationErrors: [error.message],
          unprocessedRowsCount: 0,
          unprocessedFileUrl: null,
          notes: `Import error: ${error.message}`
        }
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

// Download unprocessed rows file endpoint (no auth required)
export const downloadUnprocessedFile = catchAsync(async (req, res) => {
  try {
    const { filename } = req.params;
    const filepath = path.join(process.cwd(), 'uploads', filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({
        status: 'error',
        message: 'File not found'
      });
    }
    
    // Update download status in database if file record exists
    try {
      await UnprocessedFile.updateOne(
        { filename: filename },
        { 
          $set: { 
            isDownloaded: true, 
            downloadedAt: new Date(),
            downloadedBy: req.user?._id || null
          } 
        }
      );
    } catch (dbError) {
      console.warn('Could not update download status:', dbError.message);
      // Continue with download even if DB update fails
    }
    
    res.download(filepath, filename, (err) => {
      if (err) {
        console.error('Error downloading file:', err);
        return res.status(500).json({
          status: 'error',
          message: 'Error downloading file'
        });
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Error downloading file',
      error: error.message
    });
  }
});

// Get list of unprocessed files
export const getUnprocessedFiles = catchAsync(async (req, res) => {
  try {
    const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    const [files, total] = await Promise.all([
      UnprocessedFile.find({})
        .populate('uploadedBy', 'name phoneNumber')
        .populate('downloadedBy', 'name phoneNumber')
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      UnprocessedFile.countDocuments({})
    ]);
    
    return res.status(200).json({
      status: 'success',
      data: {
        files,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Error fetching unprocessed files',
      error: error.message
    });
  }
});

// Get errorful orders (failed imports saved to database)
export const getErrorfulOrders = catchAsync(async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      errorType,
      isResolved,
      importBatchId,
      bookingNumber
    } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    // Build query filter
    const filter = {};
    if (errorType) {
      filter.errorType = errorType;
    }
    if (isResolved !== undefined) {
      filter.isResolved = isResolved === 'true';
    }
    if (importBatchId) {
      filter.importBatchId = importBatchId;
    }
    if (bookingNumber) {
      filter.bookingNumber = { $regex: bookingNumber, $options: 'i' };
    }
    
    const [orders, total] = await Promise.all([
      ErrorfulOrder.find(filter)
        .populate('resolvedBy', 'name phoneNumber')
        .populate('importedOrderId', 'orderId numberOfPlants')
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ErrorfulOrder.countDocuments(filter)
    ]);
    
    // Get error type statistics
    const errorTypeStats = await ErrorfulOrder.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$errorType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    return res.status(200).json({
      status: 'success',
      data: {
        orders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        statistics: {
          errorTypeBreakdown: errorTypeStats,
          totalUnresolved: await ErrorfulOrder.countDocuments({ ...filter, isResolved: false }),
          totalResolved: await ErrorfulOrder.countDocuments({ ...filter, isResolved: true })
        }
      }
    });
  } catch (error) {
    console.error('Error fetching errorful orders:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch errorful orders',
      error: error.message
    });
  }
});

// Fix bookingSlot format endpoint
export const fixBookingSlotFormat = catchAsync(async (req, res) => {
  try {
    const Order = mongoose.model('Order');
    const PlantSlot = mongoose.model('PlantSlot');

    console.log("🔍 Starting bookingSlot format fix...");

    // First, let's check all orders and their bookingSlot types
    const allOrders = await Order.find({});
    console.log(`📊 Total orders found: ${allOrders.length}`);

    // Check the types of bookingSlot
    const bookingSlotTypes = new Map();
    allOrders.forEach(order => {
      const type = Array.isArray(order.bookingSlot) ? 'array' : typeof order.bookingSlot;
      bookingSlotTypes.set(type, (bookingSlotTypes.get(type) || 0) + 1);
    });
    console.log("📋 BookingSlot types:", Object.fromEntries(bookingSlotTypes));

    // Find all orders with bookingSlot as an array
    const ordersWithArrayBookingSlot = allOrders.filter(order => Array.isArray(order.bookingSlot));

    console.log(`📊 Found ${ordersWithArrayBookingSlot.length} orders with array bookingSlot format`);

    let updatedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const order of ordersWithArrayBookingSlot) {
      try {
        console.log(`🔧 Processing order ${order.orderId}...`);

        // Extract slot details from the array
        const slotDetails = order.bookingSlot[0];
        if (!slotDetails) {
          throw new Error("No slot details found");
        }

        const { slotId, startDay, endDay, subtypeId } = slotDetails;

        let correctSlotId = null;

        // If slotId is provided, use it directly
        if (slotId) {
          correctSlotId = slotId;
        } else {
          // Find the slot by matching the details
          const plantSlot = await PlantSlot.findOne({
            "subtypeSlots.subtypeId": new mongoose.Types.ObjectId(subtypeId),
            "subtypeSlots.slots.startDay": startDay,
            "subtypeSlots.slots.endDay": endDay
          });

          if (plantSlot) {
            for (const subtypeSlot of plantSlot.subtypeSlots) {
              const matchingSlot = subtypeSlot.slots.find(slot => 
                slot.startDay === startDay && slot.endDay === endDay
              );
              if (matchingSlot) {
                correctSlotId = matchingSlot._id.toString();
                break;
              }
            }
          }
        }

        if (correctSlotId) {
          // Update the order with the correct slot ID
          await Order.findByIdAndUpdate(order._id, {
            bookingSlot: new mongoose.Types.ObjectId(correctSlotId)
          });

          console.log(`✅ Updated order ${order.orderId} with slot ID: ${correctSlotId}`);
          updatedCount++;
        } else {
          console.log(`⚠️  Could not find correct slot for order ${order.orderId}`);
          errorCount++;
          errors.push({
            orderId: order.orderId,
            error: "Could not find correct slot ID"
          });
        }
      } catch (error) {
        console.error(`❌ Error processing order ${order.orderId}:`, error);
        errorCount++;
        errors.push({
          orderId: order.orderId,
          error: error.message
        });
      }
    }

    const summary = {
      totalProcessed: ordersWithArrayBookingSlot.length,
      successfullyUpdated: updatedCount,
      errors: errorCount,
      errorDetails: errors
    };

    console.log("\n📋 Fix Summary:", summary);

    return res.status(200).json({
      status: 'success',
      message: 'BookingSlot format fix completed',
      data: summary
    });

  } catch (error) {
    console.error("❌ Fix failed:", error);
    return res.status(500).json({
      status: 'error',
      message: 'Error fixing bookingSlot format',
      error: error.message
    });
  }
});

// New import endpoint for order structure with payment and reference fields
export const importOrdersWithPayment = catchAsync(async (req, res) => {
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
      // Get password from request body if provided
      const password = req.body.password || null;
      
      // Get row limit from request body if provided
      const rowLimit = req.body.rowLimit ? parseInt(req.body.rowLimit) : null;
      
      // Generate import batch ID for this import session
      const importBatchId = `import-${Date.now()}`;
      const results = await importOrdersFromExcel(req.file.buffer, {
        importBatchId: importBatchId,
        sourceFilename: req.file.originalname || 'unknown.xlsx',
        password: password, // Pass password if provided
        rowLimit: rowLimit, // Pass row limit if provided
      });

      return res.status(200).json({
        status: 'success',
        message: `Import completed: ${results.success} successful, ${results.failed} failed`,
        data: {
          success: results.success,
          failed: results.failed,
          errors: results.errors,
          autoCreatedFarmers: results.autoCreatedFarmers,
          autoCreatedSalesPersons: results.autoCreatedSalesPersons,
          autoCreatedTrays: results.autoCreatedTrays || [],
          autoCreatedReferenceUsers: results.autoCreatedReferenceUsers || [],
          skipped: results.skipped,
          errorfulOrders: results.errorfulOrders || [],
          errorfulOrdersCount: results.errorfulOrders?.length || 0,
        }
      });
    } catch (error) {
      console.error('Import error:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Error importing orders',
        error: error.message
      });
    }
  });
});

// Retry errorful orders endpoint - automatically imports orders after clearing faults
export const retryFailedOrders = catchAsync(async (req, res) => {
  try {
    const { 
      filter = {}, // Optional filter for errorful orders
      limit = null, // Optional limit on number of orders to retry
      importBatchId = null // Optional custom batch ID
    } = req.body;

    // Build filter - default to unresolved, not successfully imported
    const retryFilter = {
      isResolved: false,
      successfullyImported: false,
      ...filter
    };

    const results = await retryErrorfulOrders({
      filter: retryFilter,
      limit: limit,
      importBatchId: importBatchId || `retry-${Date.now()}`,
    });

    return res.status(200).json({
      status: 'success',
      message: `Retry completed: ${results.success} successful, ${results.failed} failed`,
      data: {
        success: results.success,
        failed: results.failed,
        retried: results.retried,
        errors: results.errors,
      }
    });
  } catch (error) {
    console.error('Retry error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Error retrying failed orders',
      error: error.message
    });
  }
});