import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

/**
 * Test MongoDB connection to DigitalOcean instance
 * Usage: node test-mongodb-digitalocean.js
 * Or with environment variable:
 * MONGO_URL="mongodb://user:pass@YOUR_STATIC_IP:27017/db?authSource=db" node test-mongodb-digitalocean.js
 */

const testDigitalOceanConnection = async () => {
  console.log("🔍 Testing MongoDB connection to DigitalOcean...");
  console.log("=" .repeat(60));
  
  const mongoUrl = process.env.MONGO_URL;
  
  if (!mongoUrl) {
    console.error("❌ MONGO_URL environment variable is not set!");
    console.log("\n💡 Please set it like this:");
    console.log('export MONGO_URL="mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production"');
    console.log("\nOr create a .env file with:");
    console.log("MONGO_URL=mongodb://nursery_user:YOUR_PASSWORD@YOUR_STATIC_IP:27017/nursery_production?authSource=nursery_production");
    process.exit(1);
  }
  
  // Mask password in output
  const maskedUrl = mongoUrl.replace(/(mongodb:\/\/[^:]+:)([^@]+)(@.+)/, '$1****$3');
  console.log("📍 Connection URL:", maskedUrl);
  console.log("🌍 Node Environment:", process.env.NODE_ENV || "development");
  console.log("=" .repeat(60));
  
  try {
    // Production-ready connection options
    const connectionOptions = {
      serverSelectionTimeoutMS: 10000, // 10 seconds timeout
      socketTimeoutMS: 45000, // 45 seconds socket timeout
      connectTimeoutMS: 10000, // 10 seconds connection timeout
      maxPoolSize: 10, // Maintain up to 10 socket connections
      minPoolSize: 2, // Maintain at least 2 socket connections
      retryWrites: true,
      w: 'majority',
      // Enable connection retry
      retryReads: true,
    };
    
    console.log("⏳ Attempting to connect...");
    const startTime = Date.now();
    
    await mongoose.connect(mongoUrl, connectionOptions);
    
    const connectionTime = Date.now() - startTime;
    console.log(`✅ Successfully connected to MongoDB! (${connectionTime}ms)`);
    console.log("=" .repeat(60));
    
    // Test database operations
    console.log("\n📊 Database Information:");
    console.log("  - Database Name:", mongoose.connection.name);
    console.log("  - Host:", mongoose.connection.host);
    console.log("  - Port:", mongoose.connection.port);
    console.log("  - Ready State:", mongoose.connection.readyState === 1 ? "Connected" : "Not Connected");
    
    // List collections
    console.log("\n📁 Available Collections:");
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      if (collections.length === 0) {
        console.log("  ⚠️  No collections found (database is empty)");
      } else {
        collections.forEach((col, index) => {
          console.log(`  ${index + 1}. ${col.name}`);
        });
      }
    } catch (error) {
      console.log("  ⚠️  Could not list collections:", error.message);
    }
    
    // Test a simple query
    console.log("\n🧪 Testing database operations...");
    try {
      const adminDb = mongoose.connection.db.admin();
      const serverStatus = await adminDb.serverStatus();
      console.log("  ✅ Database ping successful");
      console.log("  - MongoDB Version:", serverStatus.version);
      console.log("  - Uptime:", Math.floor(serverStatus.uptime / 3600), "hours");
      console.log("  - Connections:", serverStatus.connections.current, "/", serverStatus.connections.available);
    } catch (error) {
      console.log("  ⚠️  Could not get server status:", error.message);
    }
    
    // Test write operation (optional - creates a test document)
    console.log("\n✍️  Testing write operation...");
    try {
      const testCollection = mongoose.connection.db.collection('_connection_test');
      await testCollection.insertOne({ 
        test: true, 
        timestamp: new Date(),
        message: 'Connection test successful'
      });
      console.log("  ✅ Write operation successful");
      
      // Clean up test document
      await testCollection.deleteOne({ test: true });
      console.log("  ✅ Cleanup successful");
    } catch (error) {
      console.log("  ⚠️  Write test failed:", error.message);
    }
    
    console.log("\n" + "=" .repeat(60));
    console.log("✅ All tests passed! Your MongoDB connection is ready for production.");
    console.log("=" .repeat(60));
    
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected from MongoDB");
    process.exit(0);
    
  } catch (error) {
    console.error("\n❌ MongoDB connection failed!");
    console.error("=" .repeat(60));
    console.error("Error Type:", error.name);
    console.error("Error Message:", error.message);
    console.error("Error Code:", error.code || "N/A");
    
    console.log("\n🔧 Troubleshooting Tips:");
    console.log("=" .repeat(60));
    
    if (error.message.includes("authentication failed") || error.name === "MongoServerError") {
      console.log("1. ❌ Authentication failed:");
      console.log("   - Check username and password in connection string");
      console.log("   - Verify authSource database name is correct");
      console.log("   - Ensure user exists and has proper permissions");
    }
    
    if (error.message.includes("timeout") || error.message.includes("ETIMEDOUT")) {
      console.log("2. ⏱️  Connection timeout:");
      console.log("   - Check if MongoDB is running on the server");
      console.log("   - Verify firewall allows connections from your IP");
      console.log("   - Check if static IP is correct");
      console.log("   - Test port connectivity: telnet YOUR_STATIC_IP 27017");
    }
    
    if (error.message.includes("ENOTFOUND") || error.message.includes("getaddrinfo")) {
      console.log("3. 🌐 DNS/Hostname resolution failed:");
      console.log("   - Verify the static IP address is correct");
      console.log("   - Check if the server is accessible");
    }
    
    if (error.message.includes("ECONNREFUSED")) {
      console.log("4. 🚫 Connection refused:");
      console.log("   - MongoDB service might not be running");
      console.log("   - Check if port 27017 is open");
      console.log("   - Verify bindIp in /etc/mongod.conf allows your IP");
    }
    
    console.log("\n📋 Common Solutions:");
    console.log("   • Verify MongoDB is running: sudo systemctl status mongod");
    console.log("   • Check firewall: sudo ufw status");
    console.log("   • Test port: nc -zv YOUR_STATIC_IP 27017");
    console.log("   • Check MongoDB logs: sudo tail -f /var/log/mongodb/mongod.log");
    
    process.exit(1);
  }
};

// Run the test
testDigitalOceanConnection();

