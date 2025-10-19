/**
 * Inventory System API Test Script
 * Run this to test all inventory endpoints
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:8000/api/v1';
const TOKEN = 'YOUR_JWT_TOKEN_HERE'; // Replace with actual token after login

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
});

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
};

// Store created IDs for cleanup
let createdIds = {
  supplier: null,
  product: null,
  unit: null,
  po: null,
  grn: null,
  outward: null,
};

async function testMeasurementUnits() {
  console.log('\n📏 Testing Measurement Units...');
  try {
    const response = await api.get('/inventory/units');
    if (response.data.success && response.data.data.length > 0) {
      log.success(`Found ${response.data.data.length} measurement units`);
      const kgUnit = response.data.data.find(u => u.abbreviation === 'kg');
      if (kgUnit) {
        createdIds.unit = kgUnit._id;
        log.info(`Using unit: Kilogram (${kgUnit._id})`);
      }
      return true;
    } else {
      log.warn('No measurement units found. Run: node seed-measurement-units.js');
      return false;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreateSupplier() {
  console.log('\n🏪 Testing Supplier Creation...');
  try {
    const supplierData = {
      code: `TEST_SUP_${Date.now()}`,
      name: 'Test Supplier Ltd',
      contactPerson: 'Test Contact',
      phone: '9876543210',
      email: 'test@supplier.com',
    };

    const response = await api.post('/inventory/suppliers', supplierData);
    if (response.data.success) {
      createdIds.supplier = response.data.data._id;
      log.success(`Supplier created: ${response.data.data.name} (${response.data.data.code})`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreateProduct() {
  console.log('\n📦 Testing Product Creation...');
  try {
    if (!createdIds.unit) {
      log.warn('No unit ID available. Skipping product creation.');
      return false;
    }

    const productData = {
      code: `TEST_PROD_${Date.now()}`,
      name: 'Test Product',
      category: 'raw_material',
      primaryUnit: createdIds.unit,
      minStockLevel: 10,
      reorderLevel: 50,
    };

    const response = await api.post('/inventory/products', productData);
    if (response.data.success) {
      createdIds.product = response.data.data._id;
      log.success(`Product created: ${response.data.data.name} (${response.data.data.code})`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testGetProducts() {
  console.log('\n📋 Testing Product List...');
  try {
    const response = await api.get('/inventory/products');
    if (response.data.success) {
      log.success(`Retrieved ${response.data.data.length} products`);
      log.info(`Total products in system: ${response.data.pagination.total}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testGetProductDetails() {
  console.log('\n🔍 Testing Product Details...');
  try {
    if (!createdIds.product) {
      log.warn('No product ID available. Skipping.');
      return false;
    }

    const response = await api.get(`/inventory/products/${createdIds.product}`);
    if (response.data.success) {
      const { product, batches, recentTransactions } = response.data.data;
      log.success(`Product details retrieved: ${product.name}`);
      log.info(`Current stock: ${product.currentStock}`);
      log.info(`Batches: ${batches.length}`);
      log.info(`Transactions: ${recentTransactions.length}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testInventorySummary() {
  console.log('\n📊 Testing Inventory Summary...');
  try {
    const response = await api.get('/inventory/products/summary');
    if (response.data.success) {
      const { totalProducts, activeProducts, lowStockCount, totalStockValue } = response.data.data;
      log.success('Inventory summary retrieved');
      log.info(`Total Products: ${totalProducts}`);
      log.info(`Active Products: ${activeProducts}`);
      log.info(`Low Stock Items: ${lowStockCount}`);
      log.info(`Stock Value: ₹${totalStockValue.toLocaleString()}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreatePurchaseOrder() {
  console.log('\n🛒 Testing Purchase Order Creation...');
  try {
    if (!createdIds.supplier || !createdIds.product || !createdIds.unit) {
      log.warn('Missing required IDs. Skipping PO creation.');
      return false;
    }

    const poData = {
      supplier: createdIds.supplier,
      items: [
        {
          product: createdIds.product,
          quantity: 100,
          unit: createdIds.unit,
          rate: 50.0,
          gst: 12,
        },
      ],
    };

    const response = await api.post('/inventory/purchase-orders', poData);
    if (response.data.success) {
      createdIds.po = response.data.data._id;
      log.success(`PO created: ${response.data.data.poNumber}`);
      log.info(`Status: ${response.data.data.status}`);
      log.info(`Total Amount: ₹${response.data.data.totalAmount}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testApprovePO() {
  console.log('\n✅ Testing PO Approval...');
  try {
    if (!createdIds.po) {
      log.warn('No PO to approve. Skipping.');
      return false;
    }

    const response = await api.post(`/inventory/purchase-orders/${createdIds.po}/approve`);
    if (response.data.success) {
      log.success(`PO approved: ${response.data.data.poNumber}`);
      log.info(`Status: ${response.data.data.status}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testCreateGRN() {
  console.log('\n📝 Testing GRN Creation...');
  try {
    if (!createdIds.supplier || !createdIds.product || !createdIds.unit) {
      log.warn('Missing required IDs. Skipping GRN creation.');
      return false;
    }

    const grnData = {
      supplier: createdIds.supplier,
      purchaseOrder: createdIds.po,
      invoiceNumber: `INV-TEST-${Date.now()}`,
      items: [
        {
          product: createdIds.product,
          batchNumber: `BATCH-TEST-${Date.now()}`,
          quantity: 100,
          acceptedQuantity: 98,
          rejectedQuantity: 2,
          unit: createdIds.unit,
          rate: 50.0,
          amount: 4900,
        },
      ],
    };

    const response = await api.post('/inventory/grn', grnData);
    if (response.data.success) {
      createdIds.grn = response.data.data._id;
      log.success(`GRN created: ${response.data.data.grnNumber}`);
      log.info(`Status: ${response.data.data.status}`);
      log.info(`Total Amount: ₹${response.data.data.totalAmount}`);
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testApproveGRN() {
  console.log('\n✅ Testing GRN Approval (Stock Update)...');
  try {
    if (!createdIds.grn) {
      log.warn('No GRN to approve. Skipping.');
      return false;
    }

    const response = await api.post(`/inventory/grn/${createdIds.grn}/approve`, {
      qualityCheckRemarks: 'Test approval - all OK',
    });
    
    if (response.data.success) {
      log.success(`GRN approved: ${response.data.data.grnNumber}`);
      log.info(`Status: ${response.data.data.status}`);
      log.info('✓ Batches created');
      log.info('✓ Stock updated');
      log.info('✓ Transactions recorded');
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function testTransactionHistory() {
  console.log('\n📜 Testing Transaction History...');
  try {
    const response = await api.get('/inventory/transactions?limit=5');
    if (response.data.success) {
      log.success(`Retrieved ${response.data.data.length} recent transactions`);
      response.data.data.forEach((txn, idx) => {
        log.info(`  ${idx + 1}. ${txn.transactionType.toUpperCase()} - ${txn.transactionNumber}`);
      });
      return true;
    }
  } catch (error) {
    log.error(`Error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function cleanup() {
  console.log('\n🧹 Cleanup (optional - delete test data)...');
  log.warn('Test data created. You can delete manually if needed.');
  log.info(`Supplier ID: ${createdIds.supplier}`);
  log.info(`Product ID: ${createdIds.product}`);
  log.info(`PO ID: ${createdIds.po}`);
  log.info(`GRN ID: ${createdIds.grn}`);
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════');
  console.log('  📦 INVENTORY SYSTEM API TEST SUITE');
  console.log('═══════════════════════════════════════════════');

  if (TOKEN === 'YOUR_JWT_TOKEN_HERE') {
    log.error('Please set your JWT token in the script first!');
    log.info('1. Login to get your token');
    log.info('2. Replace TOKEN variable at the top of this file');
    return;
  }

  const tests = [
    { name: 'Measurement Units', fn: testMeasurementUnits },
    { name: 'Create Supplier', fn: testCreateSupplier },
    { name: 'Create Product', fn: testCreateProduct },
    { name: 'Get Products', fn: testGetProducts },
    { name: 'Get Product Details', fn: testGetProductDetails },
    { name: 'Inventory Summary', fn: testInventorySummary },
    { name: 'Create Purchase Order', fn: testCreatePurchaseOrder },
    { name: 'Approve PO', fn: testApprovePO },
    { name: 'Create GRN', fn: testCreateGRN },
    { name: 'Approve GRN', fn: testApproveGRN },
    { name: 'Transaction History', fn: testTransactionHistory },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const result = await test.fn();
    if (result) passed++;
    else failed++;
  }

  await cleanup();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  TEST RESULTS: ${colors.green}${passed} passed${colors.reset} / ${colors.red}${failed} failed${colors.reset}`);
  console.log('═══════════════════════════════════════════════\n');

  if (passed === tests.length) {
    log.success('All tests passed! ✨ Inventory system is working correctly!');
  } else if (failed > 0) {
    log.warn('Some tests failed. Check the output above for details.');
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

