import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import server from "./app.js";
mongoose
  .connect(process.env.MONGO_URL)
  .then(async () => {
    console.log(`Connected to database`);

    // Define plants and varieties to be inserted

    try {
      const httpServer = server.listen(process.env.PORT || 8000, () => {
        console.log(`Server running on port ${process.env.PORT || 8000}`);
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
