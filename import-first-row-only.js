import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import msoffcrypto from 'msoffcrypto';
import openpyxl from 'openpyxl';
import XLSX from 'xlsx';
import { importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error("MONGO_URL or MONGODB_URI environment variable is required.");
    }
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
};

const importFirstRow = async () => {
  try {
    await connectDB();

    console.log('📥 Importing First Row from Excel...');
    console.log('═══════════════════════════════════════════════\n');

    const excelFilePath = path.join(__dirname, 'deployment', 'BOOKING DETAILS 2025-26 (7).xlsx');
    const password = "AV1312";

    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      return;
    }

    console.log('📖 Reading password-protected Excel file...');
    
    // Decrypt and convert to buffer
    const fileBuffer = fs.readFileSync(excelFilePath);
    const encryptedFile = msoffcrypto.OfficeFile(fileBuffer);
    encryptedFile.load_key(password=password);
    
    const decryptedBuffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const chunks = [];
      encryptedFile.decrypt({
        pipe: (chunk) => {
          chunks.push(chunk);
        }
      });
      
      // Convert chunks to buffer
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });

    // Since msoffcrypto is async, let's use Python approach
    // Actually, let me use Python to convert to unlocked Excel first
    console.log('🔓 Decrypting file...');
    
    // Use Python script to decrypt and read first row
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Create Python script to extract first row
    const pythonScript = `
import msoffcrypto
import openpyxl
import json
import sys
import io

password = "AV1312"
file_path = "${excelFilePath.replace(/\\/g, '/')}"

try:
    with open(file_path, "rb") as file:
        encrypted_file = msoffcrypto.OfficeFile(file)
        encrypted_file.load_key(password=password)
        
        decrypted_file = io.BytesIO()
        encrypted_file.decrypt(decrypted_file)
        
        workbook = openpyxl.load_workbook(decrypted_file, data_only=True)
        sheet = workbook["BOOKING LIST"]
        
        # Get first data row (row 2, since row 1 is header)
        row_data = {}
        headers = []
        
        # Get headers from row 1
        for col in range(1, sheet.max_column + 1):
            cell = sheet.cell(row=1, column=col)
            header = cell.value if cell.value else f"Column_{col}"
            headers.append(str(header))
        
        # Get data from row 2
        for col_idx, header in enumerate(headers, 1):
            cell = sheet.cell(row=2, column=col_idx)
            value = cell.value
            if value is not None:
                if isinstance(value, datetime):
                    value = value.strftime("%Y-%m-%d")
            row_data[header] = value if value is not None else None
        
        # Convert to JSON and print
        print(json.dumps([row_data]))
        
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;
    
    // Save Python script temporarily
    const pythonScriptPath = path.join(__dirname, 'temp_extract_first_row.py');
    fs.writeFileSync(pythonScriptPath, pythonScript);
    
    console.log('📊 Extracting first row...');
    const { stdout, stderr } = await execAsync(`python3 ${pythonScriptPath}`);
    
    if (stderr && stderr.includes('error')) {
      console.error('❌ Error extracting first row:', stderr);
      return;
    }
    
    const firstRowData = JSON.parse(stdout);
    console.log('✅ First row extracted!\n');
    console.log('First Row Data:', JSON.stringify(firstRowData[0], null, 2));
    
    // Convert to Excel buffer for import
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(firstRowData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    console.log('\n📥 Importing first row...');
    const importResults = await importOrdersAndFarmers(excelBuffer, {
      sourceFilename: 'first-row-only.xlsx'
    });
    
    console.log('\n═══════════════════════════════════════════════');
    console.log('📊 Import Results:');
    console.log('─────────────────────────────────────────────');
    console.log(`Total Processed: ${importResults.summary.totalProcessed}`);
    console.log(`Successful: ${importResults.summary.successfulImports}`);
    console.log(`Failed: ${importResults.summary.failedImports}`);
    
    if (importResults.success.length > 0) {
      console.log('\n✅ Successful Imports:');
      importResults.success.forEach(success => {
        console.log(`   - ${success.farmerName || success.bookingNo || 'Order'}: Order ID ${success.orderId}`);
      });
    }
    
    if (importResults.errors.length > 0) {
      console.log('\n❌ Errors:');
      importResults.errors.forEach(error => {
        console.log(`   - Row ${error.row}: ${error.error}`);
      });
    }
    
    // Cleanup
    fs.unlinkSync(pythonScriptPath);
    
    console.log('\n✅ Import completed!');
    
  } catch (error) {
    console.error('❌ Error importing first row:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
};

importFirstRow();





