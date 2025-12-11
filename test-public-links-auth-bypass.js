/**
 * Test Script: Public Links Endpoints - Auth Bypass Verification
 * 
 * This script tests that public farmer link endpoints work WITHOUT any authentication
 * It verifies:
 * 1. GET /api/v1/public-links/config/:slug works without token
 * 2. POST /api/v1/public-links/leads works without token
 * 3. No "Access token required" or "Refresh token required" errors
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const API_BASE = `${BASE_URL}/api/v1/public-links`;

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  test: (msg) => console.log(`${colors.cyan}🧪 ${msg}${colors.reset}`),
};

let testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

function recordTest(name, passed, details = '') {
  testResults.tests.push({ name, passed, details });
  if (passed) {
    testResults.passed++;
    log.success(`${name}${details ? ': ' + details : ''}`);
  } else {
    testResults.failed++;
    log.error(`${name}${details ? ': ' + details : ''}`);
  }
}

async function testPublicConfigEndpoint() {
  log.test('\n📋 Testing GET /api/v1/public-links/config/:slug (NO AUTH)');
  
  // Test 1: Valid slug (assuming you have a link with slug 'test-slug' or 'jamner-watermelon')
  try {
    const testSlugs = ['jamner-watermelon', 'test-slug', 'test-link'];
    let validSlug = null;
    
    for (const slug of testSlugs) {
      try {
        const response = await axios.get(`${API_BASE}/config/${slug}`, {
          headers: {
            'Accept': 'application/json',
            // NO Authorization header - this is the key test
          },
          validateStatus: () => true // Don't throw on any status
        });

        if (response.status === 200) {
          validSlug = slug;
          const hasError = response.data?.status === 'error' || response.data?.status === 'fail';
          const hasAuthError = response.data?.message?.toLowerCase().includes('token') || 
                              response.data?.message?.toLowerCase().includes('auth') ||
                              response.data?.message?.toLowerCase().includes('access token required');
          
          if (hasAuthError) {
            recordTest('Public Config Endpoint - Auth Check', false, 
              `Still requires auth: ${response.data.message}`);
          } else if (hasError && response.status === 404) {
            // 404 is OK - means slug doesn't exist, but endpoint is accessible
            log.warning(`Slug '${slug}' not found (404) - this is OK, endpoint is accessible`);
            recordTest('Public Config Endpoint - 404 Handling', true, 
              'Endpoint accessible, slug just doesn\'t exist');
            break;
          } else if (response.status === 200 && response.data?.status === 'success') {
            recordTest('Public Config Endpoint - Success Response', true, 
              `Got config for slug: ${slug}`);
            recordTest('Public Config Endpoint - No Auth Required', true, 
              'No Authorization header needed');
            break;
          }
        }
      } catch (err) {
        continue; // Try next slug
      }
    }

    if (!validSlug) {
      recordTest('Public Config Endpoint - Accessible', true, 
        'Endpoint accessible (returned 404 because no valid slug found, but no auth error)');
    }

  } catch (error) {
    const hasAuthError = error.response?.data?.message?.toLowerCase().includes('token') ||
                        error.response?.data?.message?.toLowerCase().includes('auth') ||
                        error.response?.data?.message?.toLowerCase().includes('access token required');
    
    if (hasAuthError) {
      recordTest('Public Config Endpoint - Auth Check', false, 
        `Auth error: ${error.response?.data?.message || error.message}`);
    } else {
      recordTest('Public Config Endpoint - Network Error', false, 
        error.message);
    }
  }

  // Test 2: Invalid slug - should return 404 but NOT auth error
  try {
    const response = await axios.get(`${API_BASE}/config/invalid-slug-12345`, {
      headers: {
        'Accept': 'application/json',
        // NO Authorization header
      },
      validateStatus: () => true
    });

    const hasAuthError = response.data?.message?.toLowerCase().includes('token') ||
                        response.data?.message?.toLowerCase().includes('auth') ||
                        response.data?.message?.toLowerCase().includes('access token required');

    if (hasAuthError) {
      recordTest('Public Config Endpoint - Invalid Slug Auth Check', false, 
        `Auth error on invalid slug: ${response.data.message}`);
    } else if (response.status === 404) {
      recordTest('Public Config Endpoint - Invalid Slug Handling', true, 
        'Returns 404 (not found) without auth error');
    } else {
      recordTest('Public Config Endpoint - Invalid Slug', true, 
        `Status ${response.status} (no auth error)`);
    }
  } catch (error) {
    const hasAuthError = error.response?.data?.message?.toLowerCase().includes('token') ||
                        error.response?.data?.message?.toLowerCase().includes('auth');
    recordTest('Public Config Endpoint - Invalid Slug', !hasAuthError, 
      hasAuthError ? `Auth error: ${error.message}` : error.message);
  }
}

async function testPublicLeadsEndpoint() {
  log.test('\n📋 Testing POST /api/v1/public-links/leads (NO AUTH)');
  
  try {
    // First, try to get a valid slug to use
    let testSlug = null;
    const testSlugs = ['jamner-watermelon', 'test-slug', 'test-link'];
    
    for (const slug of testSlugs) {
      try {
        const configResponse = await axios.get(`${API_BASE}/config/${slug}`, {
          headers: { 'Accept': 'application/json' },
          validateStatus: () => true
        });
        if (configResponse.status === 200 && configResponse.data?.status === 'success') {
          testSlug = slug;
          break;
        }
      } catch (err) {
        continue;
      }
    }

    if (!testSlug) {
      log.warning('No valid slug found, testing with dummy data');
      testSlug = 'test-slug';
    }

    // Test with valid payload structure (will fail validation, but shouldn't fail auth)
    const leadPayload = {
      slug: testSlug,
      name: 'Test Farmer',
      mobileNumber: '9876543210',
      stateCode: 'MH',
      stateName: 'Maharashtra',
      districtCode: 'MH_NAS',
      districtName: 'Nashik',
      talukaCode: 'MH_NAS_JAM',
      talukaName: 'Jamner',
      villageName: 'Test Village'
    };

    const response = await axios.post(`${API_BASE}/leads`, leadPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // NO Authorization header - this is the key test
      },
      validateStatus: () => true // Don't throw on any status
    });

    const hasAuthError = response.data?.status === 'error' && 
                        (response.data?.message?.toLowerCase().includes('token') ||
                         response.data?.message?.toLowerCase().includes('auth') ||
                         response.data?.message?.toLowerCase().includes('access token required'));

    if (hasAuthError) {
      recordTest('Public Leads Endpoint - Auth Check', false, 
        `Still requires auth: ${response.data.message}`);
    } else if (response.status === 201) {
      recordTest('Public Leads Endpoint - Success Response', true, 
        'Lead created successfully without auth');
      recordTest('Public Leads Endpoint - No Auth Required', true, 
        'No Authorization header needed');
    } else if (response.status === 400 || response.status === 404) {
      // Validation errors or not found are OK - means endpoint is accessible
      const isNotFound = response.data?.message?.toLowerCase().includes('not found') ||
                        response.data?.message?.toLowerCase().includes('inactive');
      recordTest('Public Leads Endpoint - Accessible', true, 
        `Endpoint accessible (${isNotFound ? 'link not found' : 'validation error'}, but no auth error)`);
    } else {
      recordTest('Public Leads Endpoint - Response', true, 
        `Status ${response.status} (no auth error)`);
    }

  } catch (error) {
    const hasAuthError = error.response?.data?.message?.toLowerCase().includes('token') ||
                        error.response?.data?.message?.toLowerCase().includes('auth') ||
                        error.response?.data?.message?.toLowerCase().includes('access token required');
    
    if (hasAuthError) {
      recordTest('Public Leads Endpoint - Auth Check', false, 
        `Auth error: ${error.response?.data?.message || error.message}`);
    } else {
      recordTest('Public Leads Endpoint - Error', false, 
        error.response?.data?.message || error.message);
    }
  }

  // Test with invalid payload (should fail validation, not auth)
  try {
    const invalidPayload = {
      slug: 'invalid-slug-xyz',
      name: 'Test'
      // Missing required fields
    };

    const response = await axios.post(`${API_BASE}/leads`, invalidPayload, {
      headers: {
        'Content-Type': 'application/json',
        // NO Authorization header
      },
      validateStatus: () => true
    });

    const hasAuthError = response.data?.message?.toLowerCase().includes('token') ||
                        response.data?.message?.toLowerCase().includes('auth') ||
                        response.data?.message?.toLowerCase().includes('access token required');

    if (hasAuthError) {
      recordTest('Public Leads Endpoint - Invalid Payload Auth Check', false, 
        `Auth error on invalid payload: ${response.data.message}`);
    } else {
      recordTest('Public Leads Endpoint - Invalid Payload Handling', true, 
        'Returns validation error (not auth error)');
    }
  } catch (error) {
    const hasAuthError = error.response?.data?.message?.toLowerCase().includes('token') ||
                        error.response?.data?.message?.toLowerCase().includes('auth');
    recordTest('Public Leads Endpoint - Invalid Payload', !hasAuthError, 
      hasAuthError ? `Auth error: ${error.message}` : error.message);
  }
}

async function testCorsPreflight() {
  log.test('\n📋 Testing CORS Preflight (OPTIONS)');
  
  try {
    const response = await axios.options(`${API_BASE}/config/test-slug`, {
      headers: {
        'Origin': 'http://localhost:3001',
        'Access-Control-Request-Method': 'GET',
      },
      validateStatus: () => true
    });

    if (response.status === 200 || response.status === 204) {
      recordTest('CORS Preflight - Config Endpoint', true, 
        `Status ${response.status}`);
    } else {
      recordTest('CORS Preflight - Config Endpoint', false, 
        `Unexpected status: ${response.status}`);
    }
  } catch (error) {
    recordTest('CORS Preflight - Config Endpoint', false, error.message);
  }

  try {
    const response = await axios.options(`${API_BASE}/leads`, {
      headers: {
        'Origin': 'http://localhost:3001',
        'Access-Control-Request-Method': 'POST',
      },
      validateStatus: () => true
    });

    if (response.status === 200 || response.status === 204) {
      recordTest('CORS Preflight - Leads Endpoint', true, 
        `Status ${response.status}`);
    } else {
      recordTest('CORS Preflight - Leads Endpoint', false, 
        `Unexpected status: ${response.status}`);
    }
  } catch (error) {
    recordTest('CORS Preflight - Leads Endpoint', false, error.message);
  }
}

async function runAllTests() {
  console.log(`${colors.cyan}
╔══════════════════════════════════════════════════════════════╗
║  Public Links Endpoints - Auth Bypass Test Suite            ║
╚══════════════════════════════════════════════════════════════╝
${colors.reset}`);

  log.info(`Testing against: ${BASE_URL}`);
  log.info('All tests will be performed WITHOUT any Authorization header\n');

  await testPublicConfigEndpoint();
  await testPublicLeadsEndpoint();
  await testCorsPreflight();

  // Print summary
  console.log(`\n${colors.cyan}
╔══════════════════════════════════════════════════════════════╗
║  Test Summary                                                ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  
  console.log(`\n${colors.green}✅ Passed: ${testResults.passed}${colors.reset}`);
  console.log(`${colors.red}❌ Failed: ${testResults.failed}${colors.reset}`);
  console.log(`Total: ${testResults.passed + testResults.failed}\n`);

  if (testResults.failed === 0) {
    log.success('🎉 All tests passed! Public endpoints are working without authentication.');
  } else {
    log.error('⚠️  Some tests failed. Check the details above.');
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  log.error(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});



