import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import server from "./app.js";

// Production-ready MongoDB connection options
const mongoOptions = {
  serverSelectionTimeoutMS: 10000, // 10 seconds timeout
  socketTimeoutMS: 45000, // 45 seconds socket timeout
  connectTimeoutMS: 10000, // 10 seconds connection timeout
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: process.env.NODE_ENV === 'production' ? 2 : 1, // At least 2 connections in production
  retryWrites: true,
  w: 'majority',
  retryReads: true,
};

mongoose
  .connect(process.env.MONGO_URL, mongoOptions)
  .then(async () => {
    console.log(`✅ Connected to database: ${mongoose.connection.name}@${mongoose.connection.host}:${mongoose.connection.port}`);

    // Define plants and varieties to be inserted

    try {
      const httpServer = server.listen(process.env.PORT || 8000, '0.0.0.0', () => {
        console.log(`Server running on port ${process.env.PORT || 8000}`);
        console.log(`Server accessible at:`);
        console.log(`  - http://localhost:8000 (from this machine)`);
        console.log(`  - http://10.0.2.2:8000 (from Android emulator)`);
      });
      
      // Set server timeout (10 minutes)
      httpServer.timeout = 600000; // 10 minutes in milliseconds
      httpServer.keepAliveTimeout = 600000; // 10 minutes
      httpServer.headersTimeout = 610000; // Slightly longer than keepAliveTimeout
      
      console.log('Server timeouts configured: 10 minutes');
    } catch (error) {
      console.error("Error starting server:", error);
    }
  })
  .catch((error) => {
    console.error(`Problem while connecting to database`, error);
  });
