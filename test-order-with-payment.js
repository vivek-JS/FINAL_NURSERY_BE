import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Test order creation with payment
const testOrderWithPayment = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Test payload with payment
    const testPayload = {
      name: "Test Farmer",
      village: "Test Village",
      taluka: "Test Taluka",
      state: "Test State",
      district: "Test District",
      mobileNumber: "1234567890",
      numberOfPlants: 100,
      rate: 50,
      plantName: "64f8b8b8b8b8b8b8b8b8b8b8", // Replace with actual plant ID
      plantSubtype: "64f8b8b8b8b8b8b8b8b8b8b9", // Replace with actual subtype ID
      bookingSlot: "64f8b8b8b8b8b8b8b8b8b8ba", // Replace with actual slot ID
      salesPerson: "64f8b8b8b8b8b8b8b8b8b8bb", // Replace with actual sales person ID
      payment: [
        {
          paidAmount: 5000,
          paymentStatus: "PENDING",
          paymentDate: new Date().toISOString(),
          bankName: "Test Bank",
          modeOfPayment: "Cash",
          remark: "Test payment",
          isWalletPayment: false
        }
      ]
    };

    console.log('Test payload:', JSON.stringify(testPayload, null, 2));

    // Import the Order model
    const Order = mongoose.model('Order');
    
    // Create order with payment
    const order = await Order.create(testPayload);
    
    console.log('Order created successfully:');
    console.log('Order ID:', order._id);
    console.log('Payment count:', order.payment.length);
    console.log('Payment details:', order.payment[0]);

  } catch (error) {
    console.error('Error testing order with payment:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

testOrderWithPayment(); 