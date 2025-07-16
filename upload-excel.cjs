const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'deployment', 'Booking Sep To Feb.xlsx');
const url = 'http://localhost:8000/api/v1/excel/import-excel';
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODY5ZmYwNzllNTJlZmU2MTg0YWVjM2EiLCJwaG9uZU51bWJlciI6NzU4ODY4NjQ1Miwicm9sZSI6IlNVUEVSX0FETUlOIiwibmFtZSI6IlN1cGVyIEFkbWluIiwidHlwZSI6ImFjY2VzcyIsImlhdCI6MTc1MjQwMjQ4OSwiZXhwIjoxNzUyNDg4ODg5LCJhdWQiOiJudXJzZXJ5LXVzZXJzIiwiaXNzIjoibnVyc2VyeS1hcHAifQ.eFXr-r-Iqc05VJWxTqFdNMYO-P7jTnfZEtlYP6qKVbE';

const form = new FormData();
form.append('file', fs.createReadStream(filePath));

axios.post(url, form, {
  headers: {
    ...form.getHeaders(),
    Authorization: `Bearer ${token}`,
  },
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
})
.then(res => {
  console.log('Response:', res.data);
  
  // Show first few successful imports
  if (res.data.data && res.data.data.successfulImports && res.data.data.successfulImports.length > 0) {
    console.log('\n=== FIRST 5 SUCCESSFUL IMPORTS ===');
    res.data.data.successfulImports.slice(0, 5).forEach((success, index) => {
      console.log(`Success ${index + 1}:`, success);
    });
  }
  
  // Show first few errors in detail
  if (res.data.data && res.data.data.failedImports && res.data.data.failedImports.length > 0) {
    console.log('\n=== FIRST 5 ERRORS ===');
    res.data.data.failedImports.slice(0, 5).forEach((error, index) => {
      console.log(`Error ${index + 1}:`, error);
    });
  }
})
.catch(err => {
  if (err.response) {
    console.error('Error:', err.response.data);
  } else {
    console.error('Error:', err.message);
  }
}); 