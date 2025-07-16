const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const uploadExcel = async () => {
  try {
    const filePath = path.join(process.cwd(), 'deployment', 'Booking Sep To Feb.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error('❌ Excel file not found at:', filePath);
      return;
    }

    console.log('📤 Uploading Excel file...');

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));

    const response = await axios.post('http://localhost:8000/api/v1/excel/validate', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY1NzFhYzFhYzFhYzFhYzFhYzFhYzFhYyIsInJvbGUiOiJTVVBFUl9BRE1JTiIsImlhdCI6MTcwMjE5MjAwMCwiZXhwIjoxNzAyMjc4NDAwfQ.example'
      },
      timeout: 30000
    });

    console.log('✅ Response:', JSON.stringify(response.data, null, 2));

  } catch (error) {
    if (error.response) {
      console.error('❌ Error Response:', JSON.stringify(error.response.data, null, 2));
      
      // Show detailed row errors
      if (error.response.data.rowErrors) {
        console.log('\n📋 Detailed Row Errors:');
        error.response.data.rowErrors.forEach((rowError, index) => {
          console.log(`\nRow ${rowError.row}:`);
          rowError.errors.forEach(err => {
            console.log(`  - ${err}`);
          });
        });
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
};

uploadExcel(); 