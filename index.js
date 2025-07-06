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
      server.listen(process.env.PORT || 8000, () => {
        console.log(`Server running on port ${process.env.PORT || 8000}`);
      });
    } catch (error) {
      console.error("Error inserting monthly slots:", error);
    }
  })
  .catch((error) => {
    console.error(`Problem while connecting to database`, error);
  });
