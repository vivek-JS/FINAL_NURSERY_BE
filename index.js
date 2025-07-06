import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import server from "./app.js";
import serverless from "serverless-http";

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log(`Connected to database`);
  } catch (error) {
    console.error(`Problem while connecting to database`, error);
  }
};

// Initialize database connection
connectDB();

// Lambda handler for AWS deployment
export const handler = serverless(server);

// Traditional server startup (for local development)
if (process.env.NODE_ENV !== 'production' || process.env.LOCAL_DEV) {
  try {
    server.listen(process.env.PORT || 8000, () => {
      console.log(`Server running on port ${process.env.PORT || 8000}`);
    });
  } catch (error) {
    console.error("Error starting server:", error);
  }
}
