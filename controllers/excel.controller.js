import catchAsync from '../utility/catchAsync.js';
import multer from 'multer';
import { importOrdersAndFarmers, validateExcelStructure } from './excel.serveces.controller.js';
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