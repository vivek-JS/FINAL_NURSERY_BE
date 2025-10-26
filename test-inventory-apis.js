import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const API_BASE = `${BASE_URL}/api/v1`;

// Test configuration
const testConfig = {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TEST_TOKEN_HERE' // Replace with actual token
  }
};

// Test data
const testData = {
  supplier: {
    name: 'Test Supplier Ltd',
    contact: '+919876543210',
    email: 'test@supplier.com',
    address: '123 Test Street, Test City',
    gstNumber: '29ABCDE1234F1Z5'
  },
  farmer: {
    name: 'Test Farmer',
    mobile: '+919876543211',
    district: 'Test District',
    village: 'Test Village',
    taluka: 'Test Taluka',
    address: '456 Farm Road, Test Village'
  },
  product: {
    name: 'Test Product',
    description: 'Test product description',
    category: 'Seeds',
    unit: 'kg',
    minStockLevel: 10,
    maxStockLevel: 100,
    costPrice: 50,
    sellingPrice: 75,
    supplier: {
      name: 'Test Supplier',
      contact: '+919876543210'
    }
  }
};

// Test functions
const testPurchaseOrderAPIs = async () => {
  console.log('🧪 Testing Purchase Order APIs...');
  
  try {
    // 1. Create a product first
    console.log('1. Creating test product...');
    const productResponse = await axios.post(`${API_BASE}/inventory/products/create`, testData.product, testConfig);
    const productId = productResponse.data.data._id;
    console.log('✅ Product created:', productId);

    // 2. Create purchase order
    console.log('2. Creating purchase order...');
    const purchaseOrderData = {
      supplier: testData.supplier,
      expectedDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      items: [{
        productId: productId,
        quantity: 100,
        rate: 50
      }],
      notes: 'Test purchase order'
    };
    
    const poResponse = await axios.post(`${API_BASE}/purchase/purchase-orders/create`, purchaseOrderData, testConfig);
    const poId = poResponse.data.data._id;
    console.log('✅ Purchase order created:', poId);

    // 3. Get all purchase orders
    console.log('3. Fetching all purchase orders...');
    const allPOsResponse = await axios.get(`${API_BASE}/purchase/purchase-orders/all`, testConfig);
    console.log('✅ Purchase orders fetched:', allPOsResponse.data.data.data.length);

    // 4. Get purchase order by ID
    console.log('4. Fetching purchase order by ID...');
    const poByIdResponse = await axios.get(`${API_BASE}/purchase/purchase-orders/${poId}`, testConfig);
    console.log('✅ Purchase order by ID fetched:', poByIdResponse.data.data.orderNumber);

    // 5. Approve purchase order
    console.log('5. Approving purchase order...');
    const approveResponse = await axios.patch(`${API_BASE}/purchase/purchase-orders/${poId}/approve`, {}, testConfig);
    console.log('✅ Purchase order approved:', approveResponse.data.data.status);

    return { productId, poId };
  } catch (error) {
    console.error('❌ Purchase Order API Error:', error.response?.data || error.message);
    throw error;
  }
};

const testGRNAPIs = async (productId, poId) => {
  console.log('🧪 Testing GRN APIs...');
  
  try {
    // 1. Create GRN
    console.log('1. Creating GRN...');
    const grnData = {
      purchaseOrderId: poId,
      items: [{
        productId: productId,
        receivedQuantity: 80,
        rate: 50,
        batchNumber: 'BATCH-001',
        manufacturingDate: new Date().toISOString().split('T')[0],
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        quality: 'good',
        notes: 'Test GRN item'
      }],
      additionalItems: [{
        productId: productId,
        quantity: 20,
        rate: 55,
        batchNumber: 'BATCH-002',
        quality: 'excellent',
        notes: 'Additional item'
      }],
      invoiceNumber: 'INV-001',
      vehicleNumber: 'MH12AB1234',
      driverName: 'Test Driver',
      driverContact: '+919876543212',
      notes: 'Test GRN'
    };
    
    const grnResponse = await axios.post(`${API_BASE}/purchase/grn/create`, grnData, testConfig);
    const grnId = grnResponse.data.data._id;
    console.log('✅ GRN created:', grnId);

    // 2. Get all GRNs
    console.log('2. Fetching all GRNs...');
    const allGRNsResponse = await axios.get(`${API_BASE}/purchase/grn/all`, testConfig);
    console.log('✅ GRNs fetched:', allGRNsResponse.data.data.data.length);

    return grnId;
  } catch (error) {
    console.error('❌ GRN API Error:', error.response?.data || error.message);
    throw error;
  }
};

const testProductDispatchAPIs = async (productId) => {
  console.log('🧪 Testing Product Dispatch APIs...');
  
  try {
    // 1. Create product dispatch
    console.log('1. Creating product dispatch...');
    const dispatchData = {
      driver: {
        name: 'Dispatch Driver',
        contact: '+919876543213',
        licenseNumber: 'DL123456789'
      },
      vehicle: {
        number: 'MH12CD5678',
        type: 'truck'
      },
      items: [{
        productId: productId,
        quantity: 50,
        batchNumber: 'BATCH-001'
      }],
      destination: {
        address: '789 Delivery Street, Delivery City',
        city: 'Delivery City',
        state: 'Test State',
        pincode: '123456',
        contactPerson: 'Delivery Person',
        contactNumber: '+919876543214'
      },
      notes: 'Test dispatch'
    };
    
    const dispatchResponse = await axios.post(`${API_BASE}/purchase/dispatch/create`, dispatchData, testConfig);
    const dispatchId = dispatchResponse.data.data._id;
    console.log('✅ Product dispatch created:', dispatchId);

    // 2. Get all dispatches
    console.log('2. Fetching all dispatches...');
    const allDispatchesResponse = await axios.get(`${API_BASE}/purchase/dispatch/all`, testConfig);
    console.log('✅ Dispatches fetched:', allDispatchesResponse.data.data.data.length);

    return dispatchId;
  } catch (error) {
    console.error('❌ Product Dispatch API Error:', error.response?.data || error.message);
    throw error;
  }
};

const testSellOrderAPIs = async (productId) => {
  console.log('🧪 Testing Sell Order APIs...');
  
  try {
    // 1. Create sell order
    console.log('1. Creating sell order...');
    const sellOrderData = {
      farmer: testData.farmer,
      items: [{
        productId: productId,
        quantity: 25,
        size: 'Medium',
        rate: 75
      }],
      paymentMode: 'cash',
      paymentDetails: {
        transactionId: 'TXN123456789'
      },
      vehicleDetails: {
        number: 'MH12EF9012',
        type: 'van',
        driverName: 'Sell Driver',
        driverContact: '+919876543215'
      },
      notes: 'Test sell order'
    };
    
    const sellOrderResponse = await axios.post(`${API_BASE}/purchase/sell-orders/create`, sellOrderData, testConfig);
    const sellOrderId = sellOrderResponse.data.data._id;
    console.log('✅ Sell order created:', sellOrderId);

    // 2. Get all sell orders
    console.log('2. Fetching all sell orders...');
    const allSellOrdersResponse = await axios.get(`${API_BASE}/purchase/sell-orders/all`, testConfig);
    console.log('✅ Sell orders fetched:', allSellOrdersResponse.data.data.data.length);

    // 3. Update sell order payment
    console.log('3. Updating sell order payment...');
    const paymentUpdateData = {
      receivedAmount: 1000,
      paymentMode: 'upi',
      paymentDetails: {
        upiId: 'test@upi',
        transactionId: 'UPI123456789'
      }
    };
    
    const paymentResponse = await axios.patch(`${API_BASE}/purchase/sell-orders/${sellOrderId}/payment`, paymentUpdateData, testConfig);
    console.log('✅ Payment updated:', paymentResponse.data.data.receivedAmount);

    // 4. Confirm sell order
    console.log('4. Confirming sell order...');
    const confirmResponse = await axios.patch(`${API_BASE}/purchase/sell-orders/${sellOrderId}/confirm`, {}, testConfig);
    console.log('✅ Sell order confirmed:', confirmResponse.data.data.status);

    return sellOrderId;
  } catch (error) {
    console.error('❌ Sell Order API Error:', error.response?.data || error.message);
    throw error;
  }
};

const testInventoryAPIs = async () => {
  console.log('🧪 Testing Inventory APIs...');
  
  try {
    // 1. Get inventory dashboard
    console.log('1. Fetching inventory dashboard...');
    const dashboardResponse = await axios.get(`${API_BASE}/inventory/dashboard`, testConfig);
    console.log('✅ Inventory dashboard fetched:', dashboardResponse.data.data.summary);

    // 2. Get all products
    console.log('2. Fetching all products...');
    const productsResponse = await axios.get(`${API_BASE}/inventory/products/all`, testConfig);
    console.log('✅ Products fetched:', productsResponse.data.data.data.length);

    // 3. Get all batches
    console.log('3. Fetching all batches...');
    const batchesResponse = await axios.get(`${API_BASE}/inventory/batches/all`, testConfig);
    console.log('✅ Batches fetched:', batchesResponse.data.data.data.length);

    // 4. Get all inwards
    console.log('4. Fetching all inwards...');
    const inwardsResponse = await axios.get(`${API_BASE}/inventory/inwards/all`, testConfig);
    console.log('✅ Inwards fetched:', inwardsResponse.data.data.data.length);

    // 5. Get all outwards
    console.log('5. Fetching all outwards...');
    const outwardsResponse = await axios.get(`${API_BASE}/inventory/outwards/all`, testConfig);
    console.log('✅ Outwards fetched:', outwardsResponse.data.data.data.length);

  } catch (error) {
    console.error('❌ Inventory API Error:', error.response?.data || error.message);
    throw error;
  }
};

const runAllTests = async () => {
  console.log('🚀 Starting Comprehensive Inventory API Tests...\n');
  
  try {
    // Test inventory APIs first
    await testInventoryAPIs();
    console.log('\n');

    // Test purchase order flow
    const { productId, poId } = await testPurchaseOrderAPIs();
    console.log('\n');

    // Test GRN flow
    await testGRNAPIs(productId, poId);
    console.log('\n');

    // Test product dispatch
    await testProductDispatchAPIs(productId);
    console.log('\n');

    // Test sell order flow
    await testSellOrderAPIs(productId);
    console.log('\n');

    console.log('🎉 All tests completed successfully!');
    console.log('\n📊 Test Summary:');
    console.log('✅ Purchase Order APIs - Working');
    console.log('✅ GRN APIs - Working');
    console.log('✅ Product Dispatch APIs - Working');
    console.log('✅ Sell Order APIs - Working');
    console.log('✅ Inventory APIs - Working');
    
  } catch (error) {
    console.error('💥 Test suite failed:', error.message);
    process.exit(1);
  }
};

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export {
  testPurchaseOrderAPIs,
  testGRNAPIs,
  testProductDispatchAPIs,
  testSellOrderAPIs,
  testInventoryAPIs,
  runAllTests
};
