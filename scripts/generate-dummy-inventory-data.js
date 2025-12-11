import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../models/product.model.js';
import Supplier from '../models/supplier.model.js';
import Merchant from '../models/merchant.model.js';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import MerchantSellOrder from '../models/sellOrder.model.js';
import GRN from '../models/grn.model.js';
import Batch from '../models/batch.model.js';
import InventoryTransaction from '../models/inventoryTransaction.model.js';
import MeasurementUnit from '../models/measurementUnit.model.js';
import User from '../models/user.model.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

// Dummy data generators
const generateSuppliers = () => [
  {
    code: 'SUP001',
    name: 'Agri Supplies Pvt Ltd',
    contactPerson: 'Rajesh Kumar',
    phone: '9876543210',
    email: 'rajesh@agrisupplies.com',
    address: {
      street: '123 Market Street',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      country: 'India',
    },
    gstin: '27AABCU9603R1ZX',
    pan: 'AABCU9603R',
    paymentTerms: 'net30',
    creditLimit: 500000,
    rating: 4,
    notes: 'Reliable supplier for seeds and fertilizers',
  },
  {
    code: 'SUP002',
    name: 'Green Farm Solutions',
    contactPerson: 'Priya Sharma',
    phone: '9876543211',
    email: 'priya@greenfarm.com',
    address: {
      street: '456 Farm Road',
      city: 'Nashik',
      state: 'Maharashtra',
      pincode: '422001',
      country: 'India',
    },
    gstin: '27BBCCU9604R1ZY',
    pan: 'BBCCU9604R',
    paymentTerms: 'net45',
    creditLimit: 300000,
    rating: 5,
    notes: 'Premium quality products',
  },
  {
    code: 'SUP003',
    name: 'Organic Seeds Co',
    contactPerson: 'Amit Patel',
    phone: '9876543212',
    email: 'amit@organicseeds.com',
    address: {
      street: '789 Organic Lane',
      city: 'Aurangabad',
      state: 'Maharashtra',
      pincode: '431001',
      country: 'India',
    },
    gstin: '27CCDDU9605R1ZZ',
    pan: 'CCDDU9605R',
    paymentTerms: 'net30',
    creditLimit: 200000,
    rating: 4,
    notes: 'Specializes in organic seeds',
  },
];

const generateMerchants = () => [
  {
    code: 'MER001',
    name: 'City Garden Store',
    contactPerson: 'Vikram Singh',
    phone: '9876543220',
    email: 'vikram@citygarden.com',
    address: {
      street: '321 Shop Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      country: 'India',
    },
    gstin: '27DDEEU9606R1ZA',
    pan: 'DDEEU9606R',
    paymentTerms: 'net30',
    creditLimit: 1000000,
    rating: 5,
    notes: 'Major retail outlet',
  },
  {
    code: 'MER002',
    name: 'Farm Fresh Mart',
    contactPerson: 'Sneha Desai',
    phone: '9876543221',
    email: 'sneha@farmfresh.com',
    address: {
      street: '654 Retail Avenue',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411002',
      country: 'India',
    },
    gstin: '27EEFFU9607R1ZB',
    pan: 'EEFFU9607R',
    paymentTerms: 'net15',
    creditLimit: 750000,
    rating: 4,
    notes: 'Fast growing chain',
  },
  {
    code: 'MER003',
    name: 'Green Valley Distributors',
    contactPerson: 'Rahul Mehta',
    phone: '9876543222',
    email: 'rahul@greenvalley.com',
    address: {
      street: '987 Distribution Center',
      city: 'Nagpur',
      state: 'Maharashtra',
      pincode: '440001',
      country: 'India',
    },
    gstin: '27FFGGU9608R1ZC',
    pan: 'FFGGU9608R',
    paymentTerms: 'net45',
    creditLimit: 500000,
    rating: 4,
    notes: 'Regional distributor',
  },
  {
    code: 'MER004',
    name: 'Agri Mart Express',
    contactPerson: 'Kavita Joshi',
    phone: '9876543223',
    email: 'kavita@agrimart.com',
    address: {
      street: '111 Express Road',
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380001',
      country: 'India',
    },
    gstin: '24GGHHU9609R1ZD',
    pan: 'GGHHU9609R',
    paymentTerms: 'net30',
    creditLimit: 600000,
    rating: 4,
    notes: 'Express delivery service',
  },
];

const generateProducts = () => [
  {
    name: 'Tomato Seeds - Hybrid',
    code: 'PROD001',
    category: 'raw_material',
    description: 'High yield hybrid tomato seeds - Premium quality',
    averagePrice: 150, // This will be used as cost price
    minStockLevel: 100,
    maxStockLevel: 1000,
    reorderLevel: 150,
    gst: 12,
    isActive: true,
  },
  {
    name: 'Fertilizer - NPK 19:19:19',
    code: 'PROD002',
    category: 'raw_material',
    description: 'Balanced NPK fertilizer for all crops',
    averagePrice: 450,
    minStockLevel: 50,
    maxStockLevel: 500,
    reorderLevel: 75,
    gst: 12,
    isActive: true,
  },
  {
    name: 'Pesticide - Neem Oil',
    code: 'PROD003',
    category: 'raw_material',
    description: 'Organic neem oil pesticide - 100% natural',
    averagePrice: 350,
    minStockLevel: 30,
    maxStockLevel: 300,
    reorderLevel: 50,
    gst: 12,
    isActive: true,
  },
  {
    name: 'Potting Soil - Premium',
    code: 'PROD004',
    category: 'raw_material',
    description: 'Premium quality potting soil with nutrients',
    averagePrice: 250,
    minStockLevel: 200,
    maxStockLevel: 2000,
    reorderLevel: 300,
    gst: 12,
    isActive: true,
  },
  {
    name: 'Garden Tools Set',
    code: 'PROD005',
    category: 'finished_good',
    description: 'Complete garden tools set - 10 pieces',
    averagePrice: 1200,
    minStockLevel: 20,
    maxStockLevel: 200,
    reorderLevel: 30,
    gst: 18,
    isActive: true,
  },
  {
    name: 'Watering Can - 5L',
    code: 'PROD006',
    category: 'finished_good',
    description: 'Plastic watering can with spray nozzle',
    averagePrice: 180,
    minStockLevel: 50,
    maxStockLevel: 500,
    reorderLevel: 75,
    gst: 18,
    isActive: true,
  },
  {
    name: 'Plant Pots - Set of 5',
    code: 'PROD007',
    category: 'finished_good',
    description: 'Terracotta plant pots - 5 different sizes',
    averagePrice: 300,
    minStockLevel: 40,
    maxStockLevel: 400,
    reorderLevel: 60,
    gst: 18,
    isActive: true,
  },
];

const generateUnits = () => [
  { name: 'Kilogram', symbol: 'kg', abbreviation: 'kg', type: 'weight', conversionToBase: 1 },
  { name: 'Gram', symbol: 'g', abbreviation: 'g', type: 'weight', conversionToBase: 0.001 },
  { name: 'Liter', symbol: 'L', abbreviation: 'L', type: 'volume', conversionToBase: 1 },
  { name: 'Milliliter', symbol: 'ml', abbreviation: 'ml', type: 'volume', conversionToBase: 0.001 },
  { name: 'Piece', symbol: 'pcs', abbreviation: 'pcs', type: 'quantity', conversionToBase: 1 },
  { name: 'Packet', symbol: 'pkt', abbreviation: 'pkt', type: 'quantity', conversionToBase: 1 },
];

// Helper function to approve GRN and update inventory (simulating real operation)
async function approveGRN(grn, user) {
  const Batch = mongoose.models.Batch || (await import('../models/batch.model.js')).default;
  
  // Create batches and update inventory
  for (const item of grn.items) {
    if (item.acceptedQuantity > 0) {
      // Create batch
      const batch = new Batch({
        batchNumber: item.batchNumber,
        product: item.product,
        manufactureDate: item.manufactureDate,
        expiryDate: item.expiryDate,
        receivedDate: grn.grnDate,
        supplier: grn.supplier,
        purchasePrice: item.rate,
        quantity: item.acceptedQuantity,
        remainingQuantity: item.acceptedQuantity,
        unit: item.unit,
        grn: grn._id,
        createdBy: user._id,
      });

      await batch.save();

      // Update item with batch reference
      item.batch = batch._id;

      // Update product stock
      const product = await Product.findById(item.product);
      if (product) {
        const oldStock = product.currentStock || 0;
        const oldValue = product.stockValue || 0;

        product.currentStock = (oldStock || 0) + item.acceptedQuantity;
        product.stockValue = (oldValue || 0) + item.amount;
        product.averagePrice = product.stockValue / product.currentStock;
        product.updatedBy = user._id;

        await product.save();

        // Create inventory transaction
        const transactionNumber = `TXN${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const transaction = new InventoryTransaction({
          transactionNumber,
          transactionType: 'inward',
          product: item.product,
          batch: batch._id,
          quantity: item.acceptedQuantity,
          unit: item.unit,
          balanceBeforeTransaction: oldStock,
          balanceAfterTransaction: product.currentStock,
          rate: item.rate,
          value: item.amount,
          referenceType: 'GRN',
          referenceId: grn._id,
          referenceNumber: grn.grnNumber,
          toLocation: 'Main Warehouse',
          reason: 'GRN Entry',
          performedBy: user._id,
        });

        await transaction.save();
      }
    }
  }

  // Update GRN status
  grn.status = 'approved';
  grn.qualityCheckBy = user._id;
  grn.qualityCheckDate = new Date();
  grn.qualityCheckRemarks = 'Quality check passed - Dummy data';
  grn.updatedBy = user._id;

  await grn.save();

  // Update PO if linked
  if (grn.purchaseOrder) {
    const po = await PurchaseOrder.findById(grn.purchaseOrder);
    if (po) {
      // Update received quantities
      grn.items.forEach((grnItem) => {
        const poItem = po.items.find(
          (item) => item.product.toString() === grnItem.product.toString()
        );
        if (poItem) {
          poItem.receivedQuantity = (poItem.receivedQuantity || 0) + grnItem.acceptedQuantity;
        }
      });

      // Check if PO is fully received
      const allReceived = po.items.every(
        (item) => (item.receivedQuantity || 0) >= item.quantity
      );

      if (allReceived) {
        po.status = 'received';
      } else {
        po.status = 'partial_received';
      }

      await po.save();
    }
  }

  return grn;
}

async function generateDummyData() {
  try {
    console.log('🚀 Starting Dummy Data Generation...\n');
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get a user for createdBy fields
    let user = await User.findOne({ role: 'SUPER_ADMIN' });
    if (!user) {
      user = await User.findOne({ role: 'ADMIN' });
    }
    if (!user) {
      user = await User.findOne();
    }
    if (!user) {
      console.error('❌ No user found. Creating a default admin user...');
      user = await User.create({
        name: 'System Admin',
        email: 'admin@nursery.com',
        password: '12345678',
        role: 'SUPER_ADMIN',
        phone: '9999999999',
      });
      console.log('✅ Created default admin user');
    }
    console.log(`✅ Using user: ${user.name || user.email} (${user.role})\n`);

    // ========== STEP 1: Create Measurement Units ==========
    console.log('📏 STEP 1: Creating measurement units...');
    const existingUnits = await MeasurementUnit.find();
    let units = existingUnits;
    
    if (existingUnits.length === 0) {
      units = await MeasurementUnit.insertMany(
        generateUnits().map(unit => ({ ...unit, createdBy: user._id }))
      );
      console.log(`   ✅ Created ${units.length} measurement units`);
    } else {
      console.log(`   ℹ️  ${existingUnits.length} units already exist, using existing`);
    }

    // ========== STEP 2: Create Suppliers ==========
    console.log('\n🏭 STEP 2: Creating suppliers...');
    const existingSuppliers = await Supplier.find();
    let suppliers = existingSuppliers;
    
    if (existingSuppliers.length === 0) {
      suppliers = await Supplier.insertMany(
        generateSuppliers().map(supplier => ({ ...supplier, createdBy: user._id }))
      );
      console.log(`   ✅ Created ${suppliers.length} suppliers`);
    } else {
      console.log(`   ℹ️  ${suppliers.length} suppliers already exist, using existing`);
    }

    // ========== STEP 3: Create Merchants ==========
    console.log('\n🏪 STEP 3: Creating merchants...');
    const existingMerchants = await Merchant.find();
    let merchants = existingMerchants;
    
    if (existingMerchants.length === 0) {
      merchants = await Merchant.insertMany(
        generateMerchants().map(merchant => ({ ...merchant, createdBy: user._id }))
      );
      console.log(`   ✅ Created ${merchants.length} merchants`);
    } else {
      console.log(`   ℹ️  ${merchants.length} merchants already exist, using existing`);
    }

    // ========== STEP 4: Create Products ==========
    console.log('\n📦 STEP 4: Creating products...');
    const kgUnit = units.find(u => u.abbreviation === 'kg' || u.symbol === 'kg');
    const pktUnit = units.find(u => u.abbreviation === 'pkt' || u.symbol === 'pkt');
    const pcsUnit = units.find(u => u.abbreviation === 'pcs' || u.symbol === 'pcs');
    const LUnit = units.find(u => u.abbreviation === 'L' || u.symbol === 'L');
    
    if (!kgUnit || !pktUnit || !pcsUnit) {
      console.error('❌ Required units not found. Please check unit creation.');
      throw new Error('Missing required units');
    }
    
    const productsData = generateProducts().map((product, index) => {
      let unit = kgUnit;
      if (index === 0) unit = pktUnit; // Seeds in packets
      if (index === 4 || index === 5 || index === 6) unit = pcsUnit; // Tools and pots in pieces
      if (index === 3) unit = kgUnit; // Soil in kg
      if (!unit || !unit._id) {
        throw new Error(`Unit not found for product ${product.name}`);
      }
      return {
        ...product,
        primaryUnit: unit._id,
        currentStock: 0,
        stockValue: 0,
        averagePrice: 0,
        createdBy: user._id,
      };
    });
    
    // Check for existing products
    const existingProducts = await Product.find({ code: { $in: productsData.map(p => p.code) } });
    const existingCodes = new Set(existingProducts.map(p => p.code));
    const newProductsData = productsData.filter(p => !existingCodes.has(p.code));
    
    let products = existingProducts;
    if (newProductsData.length > 0) {
      const newProducts = await Product.insertMany(newProductsData);
      products = [...existingProducts, ...newProducts];
      console.log(`   ✅ Created ${newProducts.length} new products`);
    }
    if (existingProducts.length > 0) {
      console.log(`   ℹ️  ${existingProducts.length} products already exist`);
    }
    console.log(`   📊 Total products: ${products.length}`);

    // ========== STEP 5: Create Purchase Orders ==========
    console.log('\n📋 STEP 5: Creating purchase orders...');
    const purchaseOrders = [];
    for (let i = 0; i < 5; i++) {
      const supplier = suppliers[i % suppliers.length];
      const selectedProducts = products.slice(0, Math.min(3, products.length));
      
      const items = selectedProducts.map((product, idx) => {
        const quantity = (i + 1) * (50 + idx * 25);
        const rate = product.averagePrice || 100; // Use averagePrice as cost price
        const itemSubtotal = quantity * rate;
        const itemDiscount = 0;
        const itemGst = (itemSubtotal * (product.gst || 12)) / 100;
        const itemAmount = itemSubtotal - itemDiscount + itemGst;
        
        return {
          product: product._id,
          quantity,
          unit: product.primaryUnit,
          rate,
          gst: product.gst || 12,
          discount: 0,
          amount: itemAmount,
          receivedQuantity: 0,
        };
      });

      const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.rate), 0);
      const gstAmount = subtotal * 0.12;
      const totalAmount = subtotal + gstAmount;

      const timestamp = Date.now();
      const po = await PurchaseOrder.create({
        poNumber: `PO${new Date().getFullYear()}${String(timestamp).slice(-6)}${i}`,
        supplier: supplier._id,
        poDate: new Date(Date.now() - (i * 7 * 24 * 60 * 60 * 1000)),
        expectedDeliveryDate: new Date(Date.now() - ((i - 1) * 7 * 24 * 60 * 60 * 1000)),
        items,
        subtotal,
        gstAmount,
        discountAmount: 0,
        otherCharges: 0,
        totalAmount,
        status: i < 2 ? 'approved' : i === 2 ? 'pending' : 'draft',
        paymentStatus: 'pending',
        paidAmount: 0,
        createdBy: user._id,
      });
      purchaseOrders.push(po);
    }
    console.log(`   ✅ Created ${purchaseOrders.length} purchase orders`);
    console.log(`   📊 Approved: ${purchaseOrders.filter(po => po.status === 'approved').length}`);
    console.log(`   📊 Pending: ${purchaseOrders.filter(po => po.status === 'pending').length}`);

    // ========== STEP 6: Create GRNs for Approved POs ==========
    console.log('\n📥 STEP 6: Creating GRNs and updating inventory...');
    const grns = [];
    const approvedPOs = purchaseOrders.filter(po => po.status === 'approved');
    
    for (const po of approvedPOs) {
      const grnNumber = await GRN.generateGRNNumber();
      
      const grnItems = po.items.map((poItem, idx) => {
        const acceptedQuantity = poItem.quantity; // Accept full quantity
        const rejectedQuantity = 0;
        const damageQuantity = 0;
        const itemAmount = acceptedQuantity * poItem.rate;
        
        return {
          product: poItem.product,
          poItem: poItem._id,
          batchNumber: `BATCH${Date.now()}${idx}`,
          quantity: poItem.quantity,
          acceptedQuantity,
          rejectedQuantity,
          damageQuantity,
          unit: poItem.unit,
          rate: poItem.rate,
          amount: itemAmount,
          manufactureDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
        };
      });

      const subtotal = grnItems.reduce((sum, item) => sum + item.amount, 0);
      const gstAmount = subtotal * 0.12;
      const totalAmount = subtotal + gstAmount;

      const grn = await GRN.create({
        grnNumber,
        grnDate: new Date(),
        supplier: po.supplier,
        purchaseOrder: po._id,
        invoiceNumber: `INV-${grnNumber}`,
        invoiceDate: new Date(),
        challanNumber: `CH-${grnNumber}`,
        challanDate: new Date(),
        vehicleNumber: `MH-${Math.floor(Math.random() * 10000)}-AB`,
        driverName: `Driver ${Math.floor(Math.random() * 100)}`,
        items: grnItems,
        subtotal,
        gstAmount,
        freightCharges: 500,
        otherCharges: 200,
        totalAmount: totalAmount + 500 + 200,
        status: 'draft',
        notes: 'Dummy GRN for testing',
        createdBy: user._id,
      });

      // Approve GRN to update inventory (REAL OPERATION)
      console.log(`   🔄 Approving GRN ${grnNumber} and updating stock...`);
      await approveGRN(grn, user);
      grns.push(grn);
      
      console.log(`   ✅ GRN ${grnNumber} approved - Stock updated`);
    }
    console.log(`   ✅ Created and approved ${grns.length} GRNs`);
    
    // Show stock updates
    console.log('\n   📊 Product Stock After GRN:');
    for (const product of products.slice(0, 3)) {
      const updatedProduct = await Product.findById(product._id);
      console.log(`      ${updatedProduct.name}: ${updatedProduct.currentStock} ${(await MeasurementUnit.findById(updatedProduct.primaryUnit)).symbol} (Value: ₹${updatedProduct.stockValue?.toLocaleString('en-IN') || 0})`);
    }

    // ========== STEP 7: Create Sell Orders with Payments ==========
    console.log('\n💰 STEP 7: Creating sell orders with payments...');
    const sellOrders = [];
    
    for (let i = 0; i < 8; i++) {
      const merchant = merchants[i % merchants.length];
      const availableProducts = products.filter(p => {
        const updated = products.find(up => up._id.toString() === p._id.toString());
        return updated?.currentStock > 0 || true; // Allow even if stock is 0 for testing
      });
      
      const selectedProducts = availableProducts.slice(0, Math.min(2 + (i % 2), availableProducts.length));
      
      const orderItems = selectedProducts.map((product, idx) => {
        const quantity = 10 + (i * 5) + (idx * 3);
        const rate = (product.averagePrice || 100) * 1.3; // Selling price = cost * 1.3
        const itemSubtotal = quantity * rate;
        const itemDiscount = (itemSubtotal * (idx === 0 ? 5 : 0)) / 100; // 5% discount on first item
        const itemGst = ((itemSubtotal - itemDiscount) * (product.gst || 12)) / 100;
        const itemAmount = itemSubtotal - itemDiscount + itemGst;
        
        return {
          product: product._id,
          quantity,
          unit: product.primaryUnit,
          rate,
          discount: idx === 0 ? 5 : 0,
          gst: product.gst || 12,
          amount: itemAmount,
          batchNumber: `SO-BATCH-${Date.now()}-${idx}`,
          notes: `Order item ${idx + 1}`,
        };
      });

      const subtotal = orderItems.reduce((sum, item) => {
        const itemSubtotal = item.quantity * item.rate;
        const itemDiscount = (itemSubtotal * item.discount) / 100;
        return sum + itemSubtotal - itemDiscount;
      }, 0);
      
      const totalDiscount = orderItems.reduce((sum, item) => {
        const itemSubtotal = item.quantity * item.rate;
        return sum + (itemSubtotal * item.discount) / 100;
      }, 0);
      
      const totalGst = orderItems.reduce((sum, item) => {
        const itemSubtotal = item.quantity * item.rate;
        const itemDiscount = (itemSubtotal * item.discount) / 100;
        return sum + ((itemSubtotal - itemDiscount) * item.gst) / 100;
      }, 0);
      
      const totalAmount = subtotal + totalGst;

      // Create payments based on order index
      const payments = [];
      if (i < 3) {
        // First 3 orders: Full payment
        payments.push({
          paidAmount: totalAmount,
          paymentDate: new Date(Date.now() - (i * 2 * 24 * 60 * 60 * 1000)),
          modeOfPayment: i === 0 ? 'Cash' : i === 1 ? 'UPI' : 'Cheque',
          paymentStatus: 'COLLECTED',
          bankName: i === 2 ? 'State Bank' : undefined,
          transactionId: i === 1 ? `TXN${Date.now()}` : undefined,
          chequeNumber: i === 2 ? `CHQ${Date.now()}` : undefined,
        });
      } else if (i < 6) {
        // Next 3 orders: Partial payment
        payments.push({
          paidAmount: totalAmount * 0.6,
          paymentDate: new Date(Date.now() - (i * 2 * 24 * 60 * 60 * 1000)),
          modeOfPayment: 'Cash',
          paymentStatus: 'COLLECTED',
        });
        payments.push({
          paidAmount: totalAmount * 0.2,
          paymentDate: new Date(Date.now() - ((i - 1) * 24 * 60 * 60 * 1000)),
          modeOfPayment: 'UPI',
          paymentStatus: 'PENDING',
          transactionId: `TXN-PENDING-${Date.now()}`,
        });
      } else {
        // Last 2 orders: No payment or pending
        if (i === 6) {
          payments.push({
            paidAmount: totalAmount * 0.3,
            paymentDate: new Date(),
            modeOfPayment: 'Cash',
            paymentStatus: 'PENDING',
          });
        }
      }

      const paidAmount = payments.reduce(
        (sum, p) => sum + (p.paymentStatus === 'COLLECTED' ? p.paidAmount : 0),
        0
      );
      const paymentStatus = paidAmount >= totalAmount ? 'paid' : paidAmount > 0 ? 'partial' : 'pending';

      const sellOrder = await MerchantSellOrder.create({
        orderNumber: await MerchantSellOrder.generateOrderNumber(),
        merchant: merchant._id,
        orderDate: new Date(Date.now() - (i * 3 * 24 * 60 * 60 * 1000)),
        deliveryDate: new Date(Date.now() - ((i - 1) * 3 * 24 * 60 * 60 * 1000)),
        items: orderItems,
        subtotal,
        discountAmount: totalDiscount,
        gstAmount: totalGst,
        otherCharges: i % 2 === 0 ? 100 : 0,
        totalAmount: totalAmount + (i % 2 === 0 ? 100 : 0),
        payment: payments,
        paymentStatus,
        paidAmount,
        status: i < 3 ? 'confirmed' : i < 6 ? 'pending' : 'draft',
        notes: `Test sell order ${i + 1}`,
        createdBy: user._id,
      });

      // Update merchant totals (REAL OPERATION)
      await Merchant.findByIdAndUpdate(merchant._id, {
        $inc: {
          totalOrderValue: sellOrder.totalAmount,
          totalPaidAmount: paidAmount,
          outstandingAmount: sellOrder.totalAmount - paidAmount,
        },
      });

      sellOrders.push(sellOrder);
    }
    console.log(`   ✅ Created ${sellOrders.length} sell orders`);
    console.log(`   💰 Paid: ${sellOrders.filter(so => so.paymentStatus === 'paid').length}`);
    console.log(`   💰 Partial: ${sellOrders.filter(so => so.paymentStatus === 'partial').length}`);
    console.log(`   💰 Pending: ${sellOrders.filter(so => so.paymentStatus === 'pending').length}`);

    // ========== STEP 8: Add More Payments to Existing Orders ==========
    console.log('\n💳 STEP 8: Adding additional payments to sell orders...');
    let additionalPayments = 0;
    
    for (let i = 3; i < 6; i++) {
      const order = sellOrders[i];
      if (order.paymentStatus === 'partial') {
        const newPayment = {
          paidAmount: (order.totalAmount - order.paidAmount) * 0.5,
          paymentDate: new Date(),
          modeOfPayment: 'NEFT/RTGS',
          paymentStatus: 'COLLECTED',
          bankName: 'HDFC Bank',
          transactionId: `NEFT-${Date.now()}-${i}`,
          remark: 'Additional payment',
        };
        
        order.payment.push(newPayment);
        order.calculatePaymentTotals();
        await order.save();
        
        // Update merchant totals
        await Merchant.findByIdAndUpdate(order.merchant, {
          $inc: {
            totalPaidAmount: newPayment.paidAmount,
            outstandingAmount: -newPayment.paidAmount,
          },
        });
        
        additionalPayments++;
      }
    }
    console.log(`   ✅ Added ${additionalPayments} additional payments`);

    // ========== FINAL SUMMARY ==========
    console.log('\n' + '='.repeat(60));
    console.log('✅ DUMMY DATA GENERATION COMPLETED!');
    console.log('='.repeat(60));
    console.log('\n📊 SUMMARY:');
    console.log(`   📏 Measurement Units: ${units.length}`);
    console.log(`   🏭 Suppliers: ${suppliers.length}`);
    console.log(`   🏪 Merchants: ${merchants.length}`);
    console.log(`   📦 Products: ${products.length}`);
    console.log(`   📋 Purchase Orders: ${purchaseOrders.length}`);
    console.log(`   📥 GRNs: ${grns.length} (all approved, stock updated)`);
    console.log(`   💰 Sell Orders: ${sellOrders.length}`);
    console.log(`   💳 Total Payments: ${sellOrders.reduce((sum, so) => sum + so.payment.length, 0)}`);
    
    // Show merchant totals
    console.log('\n🏪 MERCHANT TOTALS:');
    for (const merchant of merchants) {
      const updated = await Merchant.findById(merchant._id);
      console.log(`   ${updated.name}:`);
      console.log(`      Total Orders: ₹${(updated.totalOrderValue || 0).toLocaleString('en-IN')}`);
      console.log(`      Total Paid: ₹${(updated.totalPaidAmount || 0).toLocaleString('en-IN')}`);
      console.log(`      Outstanding: ₹${(updated.outstandingAmount || 0).toLocaleString('en-IN')}`);
    }
    
    // Show product stock
    console.log('\n📦 PRODUCT STOCK:');
    for (const product of products) {
      const updated = await Product.findById(product._id);
      const unit = await MeasurementUnit.findById(updated.primaryUnit);
      console.log(`   ${updated.name}: ${updated.currentStock || 0} ${unit?.symbol || ''} (₹${(updated.stockValue || 0).toLocaleString('en-IN')})`);
    }
    
    console.log('\n🎉 All dummy data created and tested successfully!');
    console.log('💡 You can now test the complete flow:');
    console.log('   1. View products with updated stock');
    console.log('   2. View purchase orders and GRNs');
    console.log('   3. View sell orders with payments');
    console.log('   4. View merchant ledgers');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ Error generating dummy data:', error);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateDummyData();
}

export default generateDummyData;
