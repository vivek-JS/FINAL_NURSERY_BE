import mongoose from "mongoose";

const connectionString = "mongodb+srv://vivekcreact_db_user:Vivek006@#@ram.tddrg8s.mongodb.net/?appName=Ram";

// Different encoding variations to try
// The password appears to be: Vivek006@#@
// Let's try different encoding combinations

// Option 1: All special chars encoded (@=%40, #=%23)
const connectionString1 = "mongodb+srv://vivekcreact_db_user:Vivek006%40%23%40@ram.tddrg8s.mongodb.net/?appName=Ram";

// Option 2: Maybe the password is actually "Vivek006@#" (one @ at end)
const connectionString2 = "mongodb+srv://vivekcreact_db_user:Vivek006%40%23@ram.tddrg8s.mongodb.net/?appName=Ram";

// Option 3: Maybe password is "Vivek006#" (no @)
const connectionString3 = "mongodb+srv://vivekcreact_db_user:Vivek006%23@ram.tddrg8s.mongodb.net/?appName=Ram";

// Option 4: Maybe password is "Vivek006@" (one @)
const connectionString4 = "mongodb+srv://vivekcreact_db_user:Vivek006%40@ram.tddrg8s.mongodb.net/?appName=Ram";

// Option 5: With database name "ram"
const connectionString5 = "mongodb+srv://vivekcreact_db_user:Vivek006%40%23%40@ram.tddrg8s.mongodb.net/ram?appName=Ram";

// Option 6: Maybe password doesn't have special chars at all
const connectionString6 = "mongodb+srv://vivekcreact_db_user:Vivek006@ram.tddrg8s.mongodb.net/?appName=Ram";

const testConnection = async (uri, label) => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Connection String: ${uri.replace(/:[^:@]+@/, ':****@')}`); // Hide password
  
  try {
    const options = {
      serverSelectionTimeoutMS: 10000, // 10 seconds
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    };

    console.log("Attempting to connect...");
    await mongoose.connect(uri, options);
    
    console.log("✅ Successfully connected to MongoDB!");
    console.log(`  - Database: ${mongoose.connection.name}`);
    console.log(`  - Host: ${mongoose.connection.host}`);
    console.log(`  - Port: ${mongoose.connection.port}`);
    console.log(`  - Ready State: ${mongoose.connection.readyState === 1 ? "Connected" : "Not Connected"}`);
    
    // Test a simple query
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`\n📊 Available collections (${collections.length}):`);
    collections.slice(0, 10).forEach(c => console.log(`  - ${c.name}`));
    if (collections.length > 10) {
      console.log(`  ... and ${collections.length - 10} more`);
    }
    
    // Get database stats
    const stats = await mongoose.connection.db.stats();
    console.log(`\n📈 Database Stats:`);
    console.log(`  - Collections: ${stats.collections}`);
    console.log(`  - Data Size: ${(stats.dataSize / 1024 / 1024).toFixed(2)} MB`);
    
    await mongoose.disconnect();
    console.log("\n✅ Connection test completed successfully!");
    return true;
    
  } catch (error) {
    console.error("\n❌ MongoDB connection failed:");
    console.error(`  Error: ${error.message}`);
    if (error.code) {
      console.error(`  Code: ${error.code}`);
    }
    if (error.reason) {
      console.error(`  Reason: ${error.reason}`);
    }
    
    // Provide specific troubleshooting tips
    if (error.message.includes("authentication failed") || error.message.includes("bad auth")) {
      console.log("\n🔧 Authentication Error - Possible issues:");
      console.log("  1. Incorrect username or password");
      console.log("  2. Password contains special characters that need URL encoding");
      console.log("  3. User doesn't have access to this database");
    } else if (error.message.includes("ENOTFOUND") || error.message.includes("getaddrinfo")) {
      console.log("\n🔧 DNS/Network Error - Possible issues:");
      console.log("  1. Incorrect hostname in connection string");
      console.log("  2. Network connectivity issues");
      console.log("  3. DNS resolution problems");
    } else if (error.message.includes("timeout") || error.message.includes("timed out")) {
      console.log("\n🔧 Timeout Error - Possible issues:");
      console.log("  1. IP address not whitelisted in MongoDB Atlas");
      console.log("  2. Network firewall blocking connection");
      console.log("  3. MongoDB cluster is down or unreachable");
    }
    
    // Try to disconnect if connected
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
      }
    } catch (e) {
      // Ignore disconnect errors
    }
    
    return false;
  }
};

const main = async () => {
  console.log("🔍 MongoDB Connection String Test");
  console.log("=".repeat(60));
  console.log("Original: mongodb+srv://vivekcreact_db_user:Vivek006@#@ram.tddrg8s.mongodb.net/?appName=Ram");
  console.log("=".repeat(60));
  
  const testCases = [
    { uri: connectionString, label: "Original (will fail - invalid format)" },
    { uri: connectionString1, label: "Password: Vivek006@#@ (all encoded)" },
    { uri: connectionString2, label: "Password: Vivek006@# (encoded)" },
    { uri: connectionString3, label: "Password: Vivek006# (encoded)" },
    { uri: connectionString4, label: "Password: Vivek006@ (encoded)" },
    { uri: connectionString5, label: "Password: Vivek006@#@ + DB: ram" },
    { uri: connectionString6, label: "Password: Vivek006 (no special chars)" },
  ];
  
  let success = false;
  for (const testCase of testCases) {
    success = await testConnection(testCase.uri, testCase.label);
    if (success) {
      console.log(`\n✅ SUCCESS! Working connection string found.`);
      console.log(`\n📋 Use this connection string:`);
      console.log(`   ${testCase.uri.replace(/:[^:@]+@/, ':****@')}`);
      break;
    }
    // Small delay between attempts
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (!success) {
    console.log("\n\n❌ All connection attempts failed.");
    console.log("\n📝 Analysis:");
    console.log("  The connection string cannot be connected. Possible issues:");
    console.log("\n  1. ❌ Password encoding issue:");
    console.log("     - Password contains special characters (@, #)");
    console.log("     - These MUST be URL-encoded in connection strings");
    console.log("     - @ → %40, # → %23");
    console.log("\n  2. ❌ Authentication failure:");
    console.log("     - Username 'vivekcreact_db_user' may be incorrect");
    console.log("     - Password may be incorrect");
    console.log("     - User may not exist or be disabled");
    console.log("\n  3. ❌ Network/IP whitelist:");
    console.log("     - Your IP address may not be whitelisted in MongoDB Atlas");
    console.log("     - Check MongoDB Atlas → Network Access");
    console.log("     - Add your IP or use 0.0.0.0/0 (testing only)");
    console.log("\n  4. ❌ Database access:");
    console.log("     - User may not have access to the database");
    console.log("     - Check user permissions in MongoDB Atlas");
    console.log("\n💡 Next Steps:");
    console.log("  1. Verify credentials in MongoDB Atlas dashboard");
    console.log("  2. Check Network Access → IP Whitelist");
    console.log("  3. Verify user permissions");
    console.log("  4. Get the correct connection string from Atlas (it auto-encodes passwords)");
  }
  
  process.exit(0);
};

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

