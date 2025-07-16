import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

// Test configuration
const testConfig = {
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
};

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m'
};

const log = {
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  title: (msg) => console.log(`${colors.bold}${colors.blue}${msg}${colors.reset}`)
};

// Test results tracking
let testResults = {
  total: 0,
  passed: 0,
  failed: 0,
  errors: []
};

const recordTest = (testName, passed, error = null) => {
  testResults.total++;
  if (passed) {
    testResults.passed++;
    log.success(`${testName}`);
  } else {
    testResults.failed++;
    testResults.errors.push({ testName, error });
    log.error(`${testName}: ${error}`);
  }
};

// Helper function to make API calls
const makeRequest = async (method, endpoint, data = null) => {
  try {
    const config = {
      ...testConfig,
      method,
      url: `${BASE_URL}${endpoint}`,
      ...(data && { data })
    };
    
    const response = await axios(config);
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data?.message || error.message,
      status: error.response?.status 
    };
  }
};

// Test 1: Get all states
const testGetAllStates = async () => {
  log.info('Testing GET /state/all - Get all states');
  
  const result = await makeRequest('GET', '/state/all');
  
  if (result.success && result.data?.data) {
    const states = result.data.data;
    const maharashtra = states.find(state => state.name === 'Maharashtra');
    
    if (maharashtra) {
      recordTest('Get all states', true);
      log.info(`Found Maharashtra state with ID: ${maharashtra._id}`);
      return maharashtra._id;
    } else {
      recordTest('Get all states', false, 'Maharashtra state not found');
      return null;
    }
  } else {
    recordTest('Get all states', false, result.error);
    return null;
  }
};

// Test 2: Get Maharashtra state details
const testGetMaharashtraState = async (stateId) => {
  log.info(`Testing GET /state/${stateId} - Get Maharashtra state details`);
  
  const result = await makeRequest('GET', `/state/${stateId}`);
  
  if (result.success && result.data?.data) {
    const state = result.data.data;
    if (state.name === 'Maharashtra' && state.districts && state.districts.length > 0) {
      recordTest('Get Maharashtra state details', true);
      log.info(`Maharashtra has ${state.districts.length} districts`);
      return state.districts;
    } else {
      recordTest('Get Maharashtra state details', false, 'Invalid state data or no districts');
      return null;
    }
  } else {
    recordTest('Get Maharashtra state details', false, result.error);
    return null;
  }
};

// Test 3: Get districts for Maharashtra
const testGetDistricts = async (stateId) => {
  log.info(`Testing GET /state/${stateId}/districts - Get districts for Maharashtra`);
  
  const result = await makeRequest('GET', `/state/${stateId}/districts`);
  
  if (result.success && result.data?.data?.districts) {
    const districts = result.data.data.districts;
    if (districts.length > 0) {
      recordTest('Get districts for Maharashtra', true);
      log.info(`Found ${districts.length} districts`);
      return districts;
    } else {
      recordTest('Get districts for Maharashtra', false, 'No districts found');
      return null;
    }
  } else {
    recordTest('Get districts for Maharashtra', false, result.error);
    return null;
  }
};

// Test 4: Get talukas for a specific district
const testGetTalukas = async (stateId, districtId) => {
  log.info(`Testing GET /state/${stateId}/districts/${districtId}/talukas - Get talukas for district`);
  
  const result = await makeRequest('GET', `/state/${stateId}/districts/${districtId}/talukas`);
  
  if (result.success && result.data?.data?.talukas) {
    const talukas = result.data.data.talukas;
    if (talukas.length > 0) {
      recordTest('Get talukas for district', true);
      log.info(`Found ${talukas.length} talukas in district`);
      return talukas;
    } else {
      recordTest('Get talukas for district', false, 'No talukas found');
      return null;
    }
  } else {
    recordTest('Get talukas for district', false, result.error);
    return null;
  }
};

// Test 5: Get villages for a specific taluka
const testGetVillages = async (stateId, districtId, talukaId) => {
  log.info(`Testing GET /state/${stateId}/districts/${districtId}/talukas/${talukaId}/villages - Get villages for taluka`);
  
  const result = await makeRequest('GET', `/state/${stateId}/districts/${districtId}/talukas/${talukaId}/villages`);
  
  if (result.success && result.data?.data?.villages) {
    const villages = result.data.data.villages;
    if (villages.length > 0) {
      recordTest('Get villages for taluka', true);
      log.info(`Found ${villages.length} villages in taluka`);
      return villages;
    } else {
      recordTest('Get villages for taluka', false, 'No villages found');
      return null;
    }
  } else {
    recordTest('Get villages for taluka', false, result.error);
    return null;
  }
};

// Test 6: Get complete location hierarchy
const testGetLocationHierarchy = async (stateId, districtId, talukaId, villageId) => {
  log.info(`Testing GET /state/${stateId}/districts/${districtId}/talukas/${talukaId}/villages/${villageId} - Get complete location hierarchy`);
  
  const result = await makeRequest('GET', `/state/${stateId}/districts/${districtId}/talukas/${talukaId}/villages/${villageId}`);
  
  if (result.success && result.data?.data) {
    const hierarchy = result.data.data;
    if (hierarchy.state && hierarchy.district && hierarchy.taluka && hierarchy.village) {
      recordTest('Get complete location hierarchy', true);
      log.info(`Hierarchy: ${hierarchy.state.name} → ${hierarchy.district.name} → ${hierarchy.taluka.name} → ${hierarchy.village.name}`);
      return true;
    } else {
      recordTest('Get complete location hierarchy', false, 'Incomplete hierarchy data');
      return false;
    }
  } else {
    recordTest('Get complete location hierarchy', false, result.error);
    return false;
  }
};

// Test 7: Test cascading selection with multiple districts
const testCascadingSelection = async (stateId) => {
  log.info('Testing cascading selection with multiple districts');
  
  const districts = await testGetDistricts(stateId);
  if (!districts) return false;
  
  // Test first 3 districts
  const testDistricts = districts.slice(0, 3);
  let successCount = 0;
  
  for (const district of testDistricts) {
    log.info(`Testing district: ${district.name}`);
    
    const talukas = await testGetTalukas(stateId, district._id);
    if (talukas && talukas.length > 0) {
      // Test first taluka of this district
      const taluka = talukas[0];
      log.info(`Testing taluka: ${taluka.name}`);
      
      const villages = await testGetVillages(stateId, district._id, taluka._id);
      if (villages && villages.length > 0) {
        // Test first village of this taluka
        const village = villages[0];
        log.info(`Testing village: ${village.name}`);
        
        const hierarchy = await testGetLocationHierarchy(stateId, district._id, taluka._id, village._id);
        if (hierarchy) {
          successCount++;
        }
      }
    }
  }
  
  if (successCount > 0) {
    recordTest('Cascading selection test', true);
    log.info(`Successfully tested ${successCount} complete location hierarchies`);
    return true;
  } else {
    recordTest('Cascading selection test', false, 'No complete hierarchies could be tested');
    return false;
  }
};

// Test 8: Performance test - Get all data for Maharashtra
const testPerformance = async (stateId) => {
  log.info('Testing performance - Getting all Maharashtra data');
  
  const startTime = Date.now();
  
  const result = await makeRequest('GET', `/state/${stateId}`);
  const endTime = Date.now();
  
  if (result.success && result.data?.data) {
    const state = result.data.data;
    const totalDistricts = state.districts?.length || 0;
    let totalTalukas = 0;
    let totalVillages = 0;
    
    for (const district of state.districts || []) {
      totalTalukas += district.talukas?.length || 0;
      for (const taluka of district.talukas || []) {
        totalVillages += taluka.villages?.length || 0;
      }
    }
    
    const duration = endTime - startTime;
    
    if (duration < 5000) { // Should complete within 5 seconds
      recordTest('Performance test', true);
      log.info(`Retrieved ${totalDistricts} districts, ${totalTalukas} talukas, ${totalVillages} villages in ${duration}ms`);
      return true;
    } else {
      recordTest('Performance test', false, `Too slow: ${duration}ms`);
      return false;
    }
  } else {
    recordTest('Performance test', false, result.error);
    return false;
  }
};

// Main test function
const runAllTests = async () => {
  log.title('\n🚀 Starting Location API Tests for Maharashtra');
  log.info(`Base URL: ${BASE_URL}`);
  
  try {
    // Test 1: Get all states and find Maharashtra
    const stateId = await testGetAllStates();
    if (!stateId) {
      log.error('Cannot proceed without Maharashtra state ID');
      return;
    }
    
    // Test 2: Get Maharashtra state details
    const districts = await testGetMaharashtraState(stateId);
    if (!districts) {
      log.error('Cannot proceed without district data');
      return;
    }
    
    // Test 3: Get districts
    const districtList = await testGetDistricts(stateId);
    if (!districtList) {
      log.error('Cannot proceed without district list');
      return;
    }
    
    // Test 4: Get talukas for first district
    const firstDistrict = districtList[0];
    const talukas = await testGetTalukas(stateId, firstDistrict._id);
    if (!talukas) {
      log.error('Cannot proceed without taluka data');
      return;
    }
    
    // Test 5: Get villages for first taluka
    const firstTaluka = talukas[0];
    const villages = await testGetVillages(stateId, firstDistrict._id, firstTaluka._id);
    if (!villages) {
      log.error('Cannot proceed without village data');
      return;
    }
    
    // Test 6: Get complete hierarchy for first village
    const firstVillage = villages[0];
    await testGetLocationHierarchy(stateId, firstDistrict._id, firstTaluka._id, firstVillage._id);
    
    // Test 7: Test cascading selection
    await testCascadingSelection(stateId);
    
    // Test 8: Performance test
    await testPerformance(stateId);
    
  } catch (error) {
    log.error(`Unexpected error: ${error.message}`);
    recordTest('Unexpected error', false, error.message);
  }
  
  // Print test summary
  log.title('\n📊 Test Summary');
  log.info(`Total tests: ${testResults.total}`);
  log.success(`Passed: ${testResults.passed}`);
  log.error(`Failed: ${testResults.failed}`);
  
  if (testResults.failed > 0) {
    log.title('\n❌ Failed Tests:');
    testResults.errors.forEach(({ testName, error }) => {
      log.error(`${testName}: ${error}`);
    });
  }
  
  if (testResults.passed === testResults.total) {
    log.title('\n🎉 All tests passed! Location APIs are working correctly.');
  } else {
    log.title('\n⚠️  Some tests failed. Please check the errors above.');
  }
};

// Run the tests
runAllTests().catch(error => {
  log.error(`Test runner error: ${error.message}`);
  process.exit(1);
}); 