import fs from 'fs';
import path from 'path';
import { validateExcelStructure, importOrdersAndFarmers } from './controllers/excel.serveces.controller.js';

const validateAndImportExcel = async () => {
  try {
    console.log('🔍 Starting Excel validation and import process...');
    
    // Path to the Excel file
    const excelFilePath = path.join(process.cwd(), 'deployment', 'Booking Sep To Feb.xlsx');
    
    // Check if file exists
    if (!fs.existsSync(excelFilePath)) {
      console.error('❌ Excel file not found at:', excelFilePath);
      console.log('Please make sure the file "Booking Sep To Feb.xlsx" is in the deployment folder');
      return;
    }

    console.log('📖 Reading Excel file:', excelFilePath);

    // Read the Excel file
    const fileBuffer = fs.readFileSync(excelFilePath);

    // Step 1: Validate Excel structure
    console.log('\n🔍 Step 1: Validating Excel structure...');
    const validationResults = validateExcelStructure(fileBuffer);
    
    if (!validationResults.isValid) {
      console.error('❌ Excel validation failed:');
      console.error('Errors:', validationResults.errors);
      console.error('Row Errors:', validationResults.rowErrors);
      return;
    }

    console.log('✅ Excel validation passed!');
    if (validationResults.warnings.length > 0) {
      console.log('⚠️  Warnings:', validationResults.warnings);
    }

    // Step 2: Import data
    console.log('\n📥 Step 2: Importing data...');
    const importResults = await importOrdersAndFarmers(fileBuffer);

    // Step 3: Display results
    console.log('\n📋 Import Results:');
    console.log(`📊 Total processed: ${importResults.summary.totalProcessed}`);
    console.log(`✅ Successful imports: ${importResults.summary.successfulImports}`);
    console.log(`❌ Failed imports: ${importResults.summary.failedImports}`);
    console.log(`⚠️  Overflow slots: ${importResults.summary.overflowSlots}`);

    if (importResults.success.length > 0) {
      console.log('\n✅ Successful imports:');
      importResults.success.slice(0, 5).forEach((result, index) => {
        console.log(`   ${index + 1}. ${result.bookingNo} - ${result.farmerName || 'Updated'}`);
        if (result.overflowWarning) {
          console.log(`      ⚠️  ${result.overflowWarning}`);
        }
      });
      
      if (importResults.success.length > 5) {
        console.log(`   ... and ${importResults.success.length - 5} more successful imports`);
      }
    }

    if (importResults.errors.length > 0) {
      console.log('\n❌ Failed imports:');
      importResults.errors.slice(0, 5).forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.bookingNo} - ${error.error}`);
      });
      
      if (importResults.errors.length > 5) {
        console.log(`   ... and ${importResults.errors.length - 5} more errors`);
      }
    }

    console.log('\n🎉 Excel validation and import process completed!');

  } catch (error) {
    console.error('❌ Error during validation and import:', error);
  }
};

// Run the script
validateAndImportExcel(); 