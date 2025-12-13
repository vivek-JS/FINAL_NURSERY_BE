import axios from 'axios';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../models/user.model.js';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000/api/v1';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✅${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}❌${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ️${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠️${colors.reset} ${msg}`),
};

async function getAuthToken() {
  try {
    // Connect to MongoDB to get a user
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';
    await mongoose.connect(MONGODB_URI);
    
    const user = await User.findOne({ role: { $in: ['SUPER_ADMIN', 'ADMIN'] } });
    if (!user) {
      log.error('No admin user found. Please create a user first.');
      process.exit(1);
    }
    
    // For testing, we'll use a simple approach - in production, you'd login
    log.info(`Using user: ${user.name || user.email} (${user.role})`);
    
    await mongoose.disconnect();
    
    // Return a placeholder - in real scenario, you'd login via API
    return null;
  } catch (error) {
    log.error(`Error getting auth token: ${error.message}`);
    return null;
  }
}

async function testProductCreation(token = null) {
  try {
    console.log('\n🧪 Testing Product Creation...\n');
    
    const api = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
    });

    // Step 1: Fetch Categories
    log.info('Step 1: Fetching categories...');
    let categoriesResponse;
    try {
      categoriesResponse = await api.get('/inventory/categories?isActive=true');
      if (categoriesResponse.data.success) {
        const categories = categoriesResponse.data.data;
        log.success(`Found ${categories.length} categories`);
        categories.forEach(cat => {
          log.info(`  - ${cat.displayName} (${cat.name})`);
        });
      }
    } catch (error) {
      log.error(`Error fetching categories: ${error.response?.data?.message || error.message}`);
      if (error.response?.status === 401) {
        log.warn('Authentication required. Please provide a valid token.');
        log.info('To get a token, login via: POST /api/v1/users/login');
        return false;
      }
      return false;
    }

    // Step 2: Fetch Units
    log.info('\nStep 2: Fetching measurement units...');
    let unitsResponse;
    try {
      unitsResponse = await api.get('/inventory/units');
      if (unitsResponse.data.success) {
        const units = unitsResponse.data.data;
        log.success(`Found ${units.length} units`);
        const kgUnit = units.find(u => u.abbreviation === 'kg' || u.abbreviation === 'Kg');
        const pktUnit = units.find(u => u.abbreviation === 'pkt' || u.abbreviation === 'Pkt');
        if (kgUnit) log.info(`  - Using: ${kgUnit.name} (${kgUnit.abbreviation})`);
        if (pktUnit) log.info(`  - Using: ${pktUnit.name} (${pktUnit.abbreviation})`);
      }
    } catch (error) {
      log.error(`Error fetching units: ${error.response?.data?.message || error.message}`);
      return false;
    }

    if (!categoriesResponse.data.success || !unitsResponse.data.success) {
      log.error('Failed to fetch required data');
      return false;
    }

    const categories = categoriesResponse.data.data;
    const units = unitsResponse.data.data;

    if (categories.length === 0) {
      log.warn('No categories found. Run: node scripts/seed-categories.js');
      return false;
    }

    if (units.length === 0) {
      log.warn('No units found. Run: node scripts/seed-measurement-units.js');
      return false;
    }

    // Step 3: Create Test Product
    log.info('\nStep 3: Creating test product...');
    const testProduct = {
      code: `TEST_PROD_${Date.now()}`,
      name: 'Test Product - Seeds',
      description: 'Test product for verification',
      category: categories.find(c => c.name === 'seeds')?.name || categories[0].name,
      primaryUnit: units.find(u => u.abbreviation === 'pkt' || u.abbreviation === 'Pkt')?._id || units[0]._id,
      minStockLevel: 10,
      maxStockLevel: 1000,
      reorderLevel: 50,
      hsn: '12099100',
      gst: 12,
    };

    log.info(`Product data: ${JSON.stringify(testProduct, null, 2)}`);

    try {
      const createResponse = await api.post('/inventory/products', testProduct);
      
      if (createResponse.data.success) {
        const product = createResponse.data.data;
        log.success(`Product created successfully!`);
        log.info(`  - Code: ${product.code}`);
        log.info(`  - Name: ${product.name}`);
        log.info(`  - Category: ${product.category}`);
        log.info(`  - Primary Unit: ${product.primaryUnit?.name || 'N/A'}`);
        log.info(`  - ID: ${product._id}`);
        
        // Step 4: Verify Product
        log.info('\nStep 4: Verifying product...');
        const verifyResponse = await api.get(`/inventory/products/${product._id}`);
        if (verifyResponse.data.success) {
          log.success('Product verified successfully!');
          log.info(`  - Current Stock: ${verifyResponse.data.data.product.currentStock || 0}`);
          log.info(`  - Status: ${verifyResponse.data.data.product.isActive ? 'Active' : 'Inactive'}`);
        }
        
        return true;
      }
    } catch (error) {
      log.error(`Error creating product: ${error.response?.data?.message || error.message}`);
      if (error.response?.data?.error) {
        log.error(`Details: ${JSON.stringify(error.response.data.error, null, 2)}`);
      }
      return false;
    }

  } catch (error) {
    log.error(`Test failed: ${error.message}`);
    return false;
  }
}

// Main execution
async function main() {
  console.log('='.repeat(60));
  console.log('🧪 PRODUCT CREATION TEST');
  console.log('='.repeat(60));
  
  // Check if token is provided as argument
  const token = process.argv[2] || process.env.TEST_TOKEN;
  
  if (!token) {
    log.warn('No authentication token provided.');
    log.info('Usage: node scripts/test-product-creation.js <YOUR_JWT_TOKEN>');
    log.info('Or set TEST_TOKEN environment variable');
    log.info('\nTo get a token:');
    log.info('1. Login via POST /api/v1/users/login');
    log.info('2. Copy the token from response');
    log.info('3. Run: node scripts/test-product-creation.js <token>');
    console.log('\n');
  }
  
  const result = await testProductCreation(token);
  
  console.log('\n' + '='.repeat(60));
  if (result) {
    log.success('TEST COMPLETED SUCCESSFULLY!');
  } else {
    log.error('TEST FAILED');
  }
  console.log('='.repeat(60) + '\n');
  
  process.exit(result ? 0 : 1);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default testProductCreation;




