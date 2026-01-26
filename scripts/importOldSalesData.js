/**
 * Import old sales data from utility/dummy.xlsx
 * Run: node scripts/importOldSalesData.js
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const OldSalesData = (await import('../models/oldSalesData.model.js')).default;

const DEFAULT_FILE_PATH = path.join(__dirname, '../utility/dummy.xlsx');
const FILE_PATH = process.env.OLD_SALES_XLSX || DEFAULT_FILE_PATH;
const FILE_PASSWORD = process.env.OLD_SALES_XLSX_PASSWORD || 'AV1312';
const BATCH_SIZE = Number(process.env.OLD_SALES_BATCH_SIZE || 500);

const HEADER_TO_FIELD = {
  'Del.Date': 'deliveryDate',
  'Reference Receipt No.': 'referenceReceiptNo',
  'Bill Given Or Not': 'billGivenOrNot',
  'Booking No.': 'bookingNo',
  'Customer Name': 'customerName',
  'Mo. No.': 'mobileNo',
  'Village': 'village',
  'Taluka': 'taluka',
  'District': 'district',
  'Plant': 'plant',
  'Variety': 'variety',
  'Media': 'media',
  'Details': 'details',
  'Shade No.': 'shadeNo',
  'Batch': 'batch',
  'Issue Plant Qty.': 'issuePlantQty',
  'Return': 'returnQty',
  'Damaged': 'damagedQty',
  'Extra Plants': 'extraPlants',
  'Plant Qty': 'plantQty',
  'MIS': 'mis',
  'Reference': 'reference',
  'Marketing Reference': 'marketingReference',
  'Rate': 'rate',
  'Inv. Amt.': 'invoiceAmount',
  'Rent/ Extra Charge': 'rentOrExtraCharge',
  'Vehicle No.': 'vehicleNo',
  'Driver Name': 'driverName',
  'Total Invoice Amount': 'totalInvoiceAmount',
  'Advance Paid': 'advancePaid',
  'Advance Date': 'advanceDate',
  'Details Of Advance': 'advanceDetails',
  'Remaining Amount': 'remainingAmount',
  'Payment Mode': 'paymentMode',
  'Payment Date': 'paymentDate',
  'Payment Amt.': 'paymentAmount',
  'Cheque No.': 'chequeNo',
  'Deposited In Bank': 'depositedInBank',
  'Balance Amount': 'balanceAmount',
  'Remaining Amount Paid Date': 'remainingAmountPaidDate',
  'Rem. Amount Pmt. Mode': 'remainingAmountPaymentMode',
  'Rem. Amt. Cheque No.': 'remainingAmountChequeNo',
  'Remark': 'remark',
  'Veified Or Not': 'verifiedOrNot',
};

const NUMBER_FIELDS = new Set([
  'issuePlantQty',
  'returnQty',
  'damagedQty',
  'extraPlants',
  'plantQty',
  'mis',
  'rate',
  'invoiceAmount',
  'rentOrExtraCharge',
  'totalInvoiceAmount',
  'advancePaid',
  'remainingAmount',
  'paymentAmount',
  'balanceAmount',
]);

const DATE_FIELDS = new Set([
  'deliveryDate',
  'advanceDate',
  'paymentDate',
  'remainingAmountPaidDate',
]);

const normalizeHeader = (value) => {
  if (!value) return '';
  return value.toString().replace(/\s+/g, ' ').trim();
};

const isEmptyValue = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
};

const parseString = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return String(value);
};

const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const number = Number(cleaned);
  return Number.isNaN(number) ? null : number;
};

const parseDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const excelEpoch = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(excelEpoch.getTime()) ? null : excelEpoch;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseValue = (field, value) => {
  if (DATE_FIELDS.has(field)) return parseDate(value);
  if (NUMBER_FIELDS.has(field)) return parseNumber(value);
  return parseString(value);
};

const decryptToTempFile = (inputPath, password) => {
  const tempPath = path.join(
    os.tmpdir(),
    `old-sales-decrypted-${Date.now()}.xlsx`
  );

  const pythonScript = `
import io
import sys
from pathlib import Path
import msoffcrypto

input_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
password = sys.argv[3]

with open(input_path, 'rb') as f:
    office = msoffcrypto.OfficeFile(f)
    office.load_key(password=password)
    decrypted = io.BytesIO()
    office.decrypt(decrypted)

output_path.write_bytes(decrypted.getvalue())
`;

  const result = spawnSync(
    'python3',
    ['-c', pythonScript, inputPath, tempPath, password],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    const stderr = result.stderr || 'Unknown error';
    throw new Error(`Python decryption failed: ${stderr.trim()}`);
  }

  return tempPath;
};

const connectDB = async () => {
  const uri =
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    process.env.DB_URI;

  if (!uri) {
    throw new Error(
      'MongoDB connection string not found. Set MONGO_URL (or MONGODB_URI/MONGO_URI).'
    );
  }

  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB');
};

const importOldSalesData = async () => {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`❌ File not found: ${FILE_PATH}`);
    process.exit(1);
  }

  await connectDB();

  let decryptedPath;

  try {
    console.log('🔐 Decrypting Excel file...');
    decryptedPath = decryptToTempFile(FILE_PATH, FILE_PASSWORD);

    console.log('📄 Reading decrypted Excel file...');
    const xlsxWorkbook = XLSX.readFile(decryptedPath, {
      cellDates: true,
      raw: true,
    });

    const sheetName = xlsxWorkbook.SheetNames.includes('SALE')
      ? 'SALE'
      : xlsxWorkbook.SheetNames[0];
    const worksheet = xlsxWorkbook.Sheets[sheetName];

    if (!worksheet) {
      throw new Error('No worksheet found in the Excel file.');
    }

    console.log(`📋 Using sheet: ${sheetName}`);

    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: null,
      raw: true,
    });

    if (!rows.length) {
      throw new Error('The worksheet is empty.');
    }

    const headerRow = rows[0].map(normalizeHeader);
    const columnMap = new Map();

    headerRow.forEach((header, index) => {
      if (!header) return;
      const fieldName = HEADER_TO_FIELD[header];
      if (fieldName) {
        columnMap.set(index, fieldName);
      }
    });

    if (columnMap.size === 0) {
      throw new Error('No matching headers found. Check the header mapping.');
    }

    const importBatchId = `old-sales-${Date.now()}`;
    const sourceFile = path.basename(FILE_PATH);
    const batch = [];
    let processedRows = 0;
    let insertedRows = 0;
    let skippedRows = 0;

    const insertBatch = async () => {
      if (batch.length === 0) return;
      const inserted = await OldSalesData.insertMany(batch, { ordered: false });
      insertedRows += inserted.length;
      batch.length = 0;
    };

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const rowNumber = rowIndex + 1;
      const row = rows[rowIndex] || [];
      let hasData = false;
      const rowData = {
        sourceRowNumber: rowNumber,
        sourceSheet: sheetName,
        sourceFile,
        importBatchId,
      };

      for (const [colIndex, fieldName] of columnMap.entries()) {
        const rawValue = row[colIndex];
        if (!hasData && !isEmptyValue(rawValue)) {
          hasData = true;
        }
        rowData[fieldName] = parseValue(fieldName, rawValue);
      }

      if (!hasData) {
        skippedRows += 1;
        continue;
      }

      batch.push(rowData);
      processedRows += 1;

      if (batch.length >= BATCH_SIZE) {
        await insertBatch();
        console.log(`✅ Inserted ${insertedRows}/${processedRows} rows...`);
      }
    }

    await insertBatch();

    console.log('\n📊 Import Summary');
    console.log('────────────────────────────');
    console.log(`Total rows processed: ${processedRows}`);
    console.log(`Total rows inserted : ${insertedRows}`);
    console.log(`Empty rows skipped  : ${skippedRows}`);
    console.log(`Import batch ID     : ${importBatchId}`);
    console.log('────────────────────────────');
  } catch (error) {
    console.error('❌ Import failed:', error.message);
    console.error(error.stack);
  } finally {
    if (decryptedPath && fs.existsSync(decryptedPath)) {
      fs.unlinkSync(decryptedPath);
    }
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

importOldSalesData();
