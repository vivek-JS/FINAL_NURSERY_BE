import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import server from "./app.js";

mongoose
  .connect(process.env.MONGO_URL)
  .then(() => {
    console.log(`Connected to database`);
    server.listen(process.env.PORT || 8080, () => {
      console.log(`Server running`);
    });
  })
  .catch((error) => {
    console.error(`Problem while connecting to database`, error);
  });
