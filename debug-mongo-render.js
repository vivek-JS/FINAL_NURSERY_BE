import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

const debugMongoConnection = async () => {
  console.log("🔍 MongoDB Connection Debug for Render");
  console.log("=" .repeat(50));
  
  // 1. Check environment variables
  console.log("\n📋 Environment Variables:");
  console.log("NODE_ENV:", process.env.NODE_ENV || "not set");
  console.log("PORT:", process.env.PORT || "not set");
  console.log("MONGO_URL:", process.env.MONGO_URL ? "✅ Set" : "❌ Not set");
  
  if (process.env.MONGO_URL) {
    // Mask sensitive info
    const maskedUrl = process.env.MONGO_URL.replace(
      /mongodb(\+srv)?:\/\/([^:]+):([^@]+)@/,
      (match, protocol, user, pass) => {
        return `mongodb${protocol || ''}://${user}:***@`;
      }
    );
    console.log("MONGO_URL (masked):", maskedUrl);
  }
  
  // 2. Test connection with different options
  console.log("\n🔌 Testing MongoDB Connection...");
  
  const connectionOptions = [
    {
      name: "Basic Connection",
      options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }
    },
    {
      name: "With Timeouts",
      options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 10000,
      }
    },
    {
      name: "With Retry Logic",
      options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        retryWrites: true,
        retryReads: true,
        bufferCommands: false,
      }
    }
  ];
  
  for (const config of connectionOptions) {
    console.log(`\n🧪 Testing: ${config.name}`);
    
    try {
      // Disconnect if already connected
      if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
      }
      
      const startTime = Date.now();
      await mongoose.connect(process.env.MONGO_URL, config.options);
      const endTime = Date.now();
      
      console.log(`✅ ${config.name}: SUCCESS (${endTime - startTime}ms)`);
      console.log(`   Connection State: ${mongoose.connection.readyState}`);
      console.log(`   Host: ${mongoose.connection.host}`);
      console.log(`   Port: ${mongoose.connection.port}`);
      console.log(`   Database: ${mongoose.connection.name}`);
      
      // Test a simple query
      try {
        const pingResult = await mongoose.connection.db.admin().ping();
        console.log(`   Ping Test: ✅ ${JSON.stringify(pingResult)}`);
      } catch (pingError) {
        console.log(`   Ping Test: ❌ ${pingError.message}`);
      }
      
      await mongoose.disconnect();
      
    } catch (error) {
      console.log(`❌ ${config.name}: FAILED`);
      console.log(`   Error: ${error.message}`);
      console.log(`   Code: ${error.code}`);
      
      if (error.message.includes("buffering timed out")) {
        console.log("   💡 This suggests IP whitelist or network connectivity issues");
      } else if (error.message.includes("authentication failed")) {
        console.log("   💡 This suggests username/password issues");
      } else if (error.message.includes("ENOTFOUND")) {
        console.log("   💡 This suggests DNS resolution issues");
      }
    }
  }
  
  // 3. Network connectivity test
  console.log("\n🌐 Network Connectivity Test:");
  
  try {
    const { default: dns } = await import('dns');
    const { promisify } = await import('util');
    const lookup = promisify(dns.lookup);
    
    if (process.env.MONGO_URL) {
      const url = new URL(process.env.MONGO_URL);
      const hostname = url.hostname;
      
      try {
        const result = await lookup(hostname);
        console.log(`✅ DNS Resolution for ${hostname}: ${result.address}`);
      } catch (dnsError) {
        console.log(`❌ DNS Resolution failed for ${hostname}: ${dnsError.message}`);
      }
    }
  } catch (error) {
    console.log("⚠️ Could not test DNS resolution");
  }
  
  // 4. Recommendations
  console.log("\n💡 Recommendations for Render:");
  console.log("1. Ensure MONGO_URL uses MongoDB Atlas (not localhost)");
  console.log("2. Add '0.0.0.0/0' to MongoDB Atlas IP whitelist");
  console.log("3. Use connection string format: mongodb+srv://user:pass@cluster.mongodb.net/db?retryWrites=true&w=majority");
  console.log("4. Check if MongoDB Atlas cluster is active");
  console.log("5. Verify username/password in connection string");
  
  console.log("\n🔗 Test your connection on Render:");
  console.log("https://your-render-app.onrender.com/health/mongo");
  
  console.log("\n" + "=" .repeat(50));
};

debugMongoConnection().catch(console.error); 