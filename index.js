import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import server from "./app.js";
import { createSlotsForYear } from "./controllers/slots.controller.js";
mongoose
  .connect(process.env.MONGO_URL)
  .then(async () => {
    console.log(`Connected to database`);
    
    // Define plants and varieties to be inserted
    const plants = [
      {
        name: "Banana",
        varieties: [
          { varietyName: "Shrimanti" },
          { varietyName: "Bug Banana" },
          { varietyName: "Small Banana" },
        ],
      },
      // Add more plants and varieties as needed
    ];
     
    try {
      // Await the async insertMonthlySlots function
      //await insertMonthlySlots(2024, plants);
    //  createSlotsForPlants(2024)
   //   console.log("Monthly slots inserted successfully");
      
      // Now start the server after inserting the data
      server.listen(process.env.PORT || 8080, () => {
        console.log(`Server running`);
      });
    } catch (error) {
      console.error("Error inserting monthly slots:", error);
    }
  })
  .catch((error) => {
    console.error(`Problem while connecting to database`, error);
  });
