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
  log.info('Testing GET /api/v1/location/states - Get all states');
  
  const result = await makeRequest('GET', '/api/v1/location/states');
  
  if (result.success && result.data?.data) {
    const states = result.data.data;
    const maharashtra = states.find(state => state.name === 'Maharashtra');
    
    if (maharashtra) {
      recordTest('Get all states', true);
      log.info(`Found ${states.length} states, including Maharashtra`);
      return { states, maharashtra };
    } else {
      recordTest('Get all states', false, 'Maharashtra state not found');
      return null;
    }
  } else {
    recordTest('Get all states', false, result.error);
    return null;
  }
};

// Test 2: Get state by name
const testGetStateByName = async () => {
  log.info('Testing GET /api/v1/location/states/Maharashtra - Get state by name');
  
  const result = await makeRequest('GET', '/api/v1/location/states/Maharashtra');
  
  if (result.success && result.data?.data) {
    const state = result.data.data;
    if (state.name === 'Maharashtra') {
      recordTest('Get state by name', true);
      log.info(`Found Maharashtra state with ID: ${state.id}`);
      return state;
    } else {
      recordTest('Get state by name', false, 'Invalid state data');
      return null;
    }
  } else {
    recordTest('Get state by name', false, result.error);
    return null;
  }
};

// Test 3: Get districts by state name
const testGetDistrictsByName = async () => {
  log.info('Testing GET /api/v1/location/states/Maharashtra/districts - Get districts by state name');
  
  const result = await makeRequest('GET', '/api/v1/location/states/Maharashtra/districts');
  
  if (result.success && result.data?.data?.districts) {
    const districts = result.data.data.districts;
    if (districts.length > 0) {
      recordTest('Get districts by state name', true);
      log.info(`Found ${districts.length} districts in Maharashtra`);
      return districts;
    } else {
      recordTest('Get districts by state name', false, 'No districts found');
      return null;
    }
  } else {
    recordTest('Get districts by state name', false, result.error);
    return null;
  }
};

// Test 4: Get talukas by district name
const testGetTalukasByName = async () => {
  log.info('Testing GET /api/v1/location/states/Maharashtra/districts/Pune/talukas - Get talukas by district name');
  
  const result = await makeRequest('GET', '/api/v1/location/states/Maharashtra/districts/Pune/talukas');
  
  if (result.success && result.data?.data?.talukas) {
    const talukas = result.data.data.talukas;
    if (talukas.length > 0) {
      recordTest('Get talukas by district name', true);
      log.info(`Found ${talukas.length} talukas in Pune district`);
      return talukas;
    } else {
      recordTest('Get talukas by district name', false, 'No talukas found');
      return null;
    }
  } else {
    recordTest('Get talukas by district name', false, result.error);
    return null;
  }
};

// Test 5: Get villages by taluka name
const testGetVillagesByName = async () => {
  log.info('Testing GET /api/v1/location/states/Maharashtra/districts/Pune/talukas/Mulshi/villages - Get villages by taluka name');
  
  const result = await makeRequest('GET', '/api/v1/location/states/Maharashtra/districts/Pune/talukas/Mulshi/villages');
  
  if (result.success && result.data?.data?.villages) {
    const villages = result.data.data.villages;
    if (villages.length > 0) {
      recordTest('Get villages by taluka name', true);
      log.info(`Found ${villages.length} villages in Mulshi taluka`);
      return villages;
    } else {
      recordTest('Get villages by taluka name', false, 'No villages found');
      return null;
    }
  } else {
    recordTest('Get villages by taluka name', false, result.error);
    return null;
  }
};

// Test 6: Cascading API - State only
const testCascadingStateOnly = async () => {
  log.info('Testing POST /api/v1/location/cascade - State only');
  
  const result = await makeRequest('POST', '/api/v1/location/cascade', {
    state: 'Maharashtra'
  });
  
  if (result.success && result.data?.data?.districts) {
    const districts = result.data.data.districts;
    if (districts.length > 0) {
      recordTest('Cascading API - State only', true);
      log.info(`Cascading API returned ${districts.length} districts for Maharashtra`);
      return districts;
    } else {
      recordTest('Cascading API - State only', false, 'No districts returned');
      return null;
    }
  } else {
    recordTest('Cascading API - State only', false, result.error);
    return null;
  }
};

// Test 7: Cascading API - State and District
const testCascadingStateDistrict = async () => {
  log.info('Testing POST /api/v1/location/cascade - State and District');
  
  const result = await makeRequest('POST', '/api/v1/location/cascade', {
    state: 'Maharashtra',
    district: 'Pune'
  });
  
  if (result.success && result.data?.data?.talukas) {
    const talukas = result.data.data.talukas;
    if (talukas.length > 0) {
      recordTest('Cascading API - State and District', true);
      log.info(`Cascading API returned ${talukas.length} talukas for Pune district`);
      return talukas;
    } else {
      recordTest('Cascading API - State and District', false, 'No talukas returned');
      return null;
    }
  } else {
    recordTest('Cascading API - State and District', false, result.error);
    return null;
  }
};

// Test 8: Cascading API - State, District, and Taluka
const testCascadingStateDistrictTaluka = async () => {
  log.info('Testing POST /api/v1/location/cascade - State, District, and Taluka');
  
  const result = await makeRequest('POST', '/api/v1/location/cascade', {
    state: 'Maharashtra',
    district: 'Pune',
    taluka: 'Mulshi'
  });
  
  if (result.success && result.data?.data?.villages) {
    const villages = result.data.data.villages;
    if (villages.length > 0) {
      recordTest('Cascading API - State, District, and Taluka', true);
      log.info(`Cascading API returned ${villages.length} villages for Mulshi taluka`);
      return villages;
    } else {
      recordTest('Cascading API - State, District, and Taluka', false, 'No villages returned');
      return null;
    }
  } else {
    recordTest('Cascading API - State, District, and Taluka', false, result.error);
    return false;
  }
};

// Test 9: Search API - Search for states
const testSearchStates = async () => {
  log.info('Testing GET /api/v1/location/search?query=maharashtra&type=states - Search states');
  
  const result = await makeRequest('GET', '/api/v1/location/search?query=maharashtra&type=states');
  
  if (result.success && result.data?.data?.results) {
    const results = result.data.data.results;
    if (results.length > 0) {
      recordTest('Search API - States', true);
      log.info(`Search API found ${results.length} state results for "maharashtra"`);
      return results;
    } else {
      recordTest('Search API - States', false, 'No search results found');
      return null;
    }
  } else {
    recordTest('Search API - States', false, result.error);
    return null;
  }
};

// Test 10: Search API - Search for districts
const testSearchDistricts = async () => {
  log.info('Testing GET /api/v1/location/search?query=pune&type=districts - Search districts');
  
  const result = await makeRequest('GET', '/api/v1/location/search?query=pune&type=districts');
  
  if (result.success && result.data?.data?.results) {
    const results = result.data.data.results;
    if (results.length > 0) {
      recordTest('Search API - Districts', true);
      log.info(`Search API found ${results.length} district results for "pune"`);
      return results;
    } else {
      recordTest('Search API - Districts', false, 'No search results found');
      return null;
    }
  } else {
    recordTest('Search API - Districts', false, result.error);
    return null;
  }
};

// Test 11: Search API - Search for talukas
const testSearchTalukas = async () => {
  log.info('Testing GET /api/v1/location/search?query=mulshi&type=talukas - Search talukas');
  
  const result = await makeRequest('GET', '/api/v1/location/search?query=mulshi&type=talukas');
  
  if (result.success && result.data?.data?.results) {
    const results = result.data.data.results;
    if (results.length > 0) {
      recordTest('Search API - Talukas', true);
      log.info(`Search API found ${results.length} taluka results for "mulshi"`);
      return results;
    } else {
      recordTest('Search API - Talukas', false, 'No search results found');
      return null;
    }
  } else {
    recordTest('Search API - Talukas', false, result.error);
    return null;
  }
};

// Test 12: Search API - Search for villages
const testSearchVillages = async () => {
  log.info('Testing GET /api/v1/location/search?query=paud&type=villages - Search villages');
  
  const result = await makeRequest('GET', '/api/v1/location/search?query=paud&type=villages');
  
  if (result.success && result.data?.data?.results) {
    const results = result.data.data.results;
    if (results.length > 0) {
      recordTest('Search API - Villages', true);
      log.info(`Search API found ${results.length} village results for "paud"`);
      return results;
    } else {
      recordTest('Search API - Villages', false, 'No search results found');
      return null;
    }
  } else {
    recordTest('Search API - Villages', false, result.error);
    return null;
  }
};

// Test 13: Search API - Search all types
const testSearchAll = async () => {
  log.info('Testing GET /api/v1/location/search?query=pune - Search all types');
  
  const result = await makeRequest('GET', '/api/v1/location/search?query=pune');
  
  if (result.success && result.data?.data?.results) {
    const results = result.data.data.results;
    if (results.length > 0) {
      recordTest('Search API - All types', true);
      log.info(`Search API found ${results.length} total results for "pune"`);
      return results;
    } else {
      recordTest('Search API - All types', false, 'No search results found');
      return null;
    }
  } else {
    recordTest('Search API - All types', false, result.error);
    return null;
  }
};

// Test 14: Test with IDs (if we have them from previous tests)
const testWithIDs = async (stateId, districtId, talukaId) => {
  if (!stateId || !districtId || !talukaId) {
    log.warning('Skipping ID tests - missing IDs from previous tests');
    return;
  }
  
  log.info('Testing GET /api/v1/location/states/{stateId}/districts/{districtId}/talukas/{talukaId}/villages - Using IDs');
  
  const result = await makeRequest('GET', `/api/v1/location/states/${stateId}/districts/${districtId}/talukas/${talukaId}/villages`);
  
  if (result.success && result.data?.data?.villages) {
    const villages = result.data.data.villages;
    if (villages.length > 0) {
      recordTest('API with IDs', true);
      log.info(`API with IDs returned ${villages.length} villages`);
      return villages;
    } else {
      recordTest('API with IDs', false, 'No villages returned');
      return null;
    }
  } else {
    recordTest('API with IDs', false, result.error);
    return null;
  }
};

// Main test function
const runAllTests = async () => {
  log.title('\n🚀 Starting New Location API Tests');
  log.info(`Base URL: ${BASE_URL}`);
  
  try {
    // Test 1: Get all states
    const statesData = await testGetAllStates();
    if (!statesData) {
      log.error('Cannot proceed without states data');
      return;
    }
    
    // Test 2: Get state by name
    const stateData = await testGetStateByName();
    if (!stateData) {
      log.error('Cannot proceed without state data');
      return;
    }
    
    // Test 3: Get districts by state name
    const districtsData = await testGetDistrictsByName();
    if (!districtsData) {
      log.error('Cannot proceed without districts data');
      return;
    }
    
    // Test 4: Get talukas by district name
    const talukasData = await testGetTalukasByName();
    if (!talukasData) {
      log.error('Cannot proceed without talukas data');
      return;
    }
    
    // Test 5: Get villages by taluka name
    const villagesData = await testGetVillagesByName();
    if (!villagesData) {
      log.error('Cannot proceed without villages data');
      return;
    }
    
    // Test 6: Cascading API - State only
    await testCascadingStateOnly();
    
    // Test 7: Cascading API - State and District
    await testCascadingStateDistrict();
    
    // Test 8: Cascading API - State, District, and Taluka
    await testCascadingStateDistrictTaluka();
    
    // Test 9: Search API - States
    await testSearchStates();
    
    // Test 10: Search API - Districts
    await testSearchDistricts();
    
    // Test 11: Search API - Talukas
    await testSearchTalukas();
    
    // Test 12: Search API - Villages
    await testSearchVillages();
    
    // Test 13: Search API - All types
    await testSearchAll();
    
    // Test 14: Test with IDs (if we have them)
    if (stateData && districtsData.length > 0 && talukasData.length > 0) {
      await testWithIDs(stateData.id, districtsData[0].id, talukasData[0].id);
    }
    
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
    log.title('\n🎉 All tests passed! New location APIs are working correctly.');
  } else {
    log.title('\n⚠️  Some tests failed. Please check the errors above.');
  }
};

// Run the tests
runAllTests().catch(error => {
  log.error(`Test runner error: ${error.message}`);
  process.exit(1);
}); 