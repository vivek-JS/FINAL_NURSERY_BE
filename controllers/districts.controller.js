import District from "../models/District.model.js";
import fs from "fs";

export const getDistrictsByState = async (req, res) => {
  try {
    const { stateId } = req.query;

    if (!stateId) {
      return res.status(400).json({ message: "Please provide 'stateId'." });
    }

    const state = await District.findById(stateId, { stateName: 1, districts: 1 });

    if (!state) {
      return res.status(404).json({ message: "State not found." });
    }

    const districts = state.districts.map((d) => ({
      _id: d._id, // Include district _id
      name: d.district, // District name
    }));

    res.status(200).json({
      state: state.stateName,
      districts,
    });
  } catch (error) {
    console.error("Error fetching districts:", error);
    res.status(500).json({ message: "Error fetching districts", error: error.message });
  }
};


export const getVillagesByStateDistrictAndSubDistrict = async (req, res) => {
  try {
    const { stateId, districtId, subDistrictId } = req.query;

    // Check if all required parameters are provided
    if (!stateId || !districtId || !subDistrictId) {
      return res.status(400).json({
        message: "Please provide 'stateId', 'districtId', and 'subDistrictId'.",
      });
    }

    // Validate the provided IDs
    const stateObjectId = mongoose.Types.ObjectId.isValid(stateId) ? new mongoose.Types.ObjectId(stateId) : null;
    const districtObjectId = mongoose.Types.ObjectId.isValid(districtId) ? new mongoose.Types.ObjectId(districtId) : null;
    const subDistrictObjectId = mongoose.Types.ObjectId.isValid(subDistrictId) ? new mongoose.Types.ObjectId(subDistrictId) : null;

    if (!stateObjectId || !districtObjectId || !subDistrictObjectId) {
      return res.status(400).json({
        message: "Invalid 'stateId', 'districtId' or 'subDistrictId' format.",
      });
    }

    // Fetch the state and its districts
    const state = await District.findOne(
      {
        _id: stateObjectId,
        "districts._id": districtObjectId,
      },
      { "districts.$": 1 } // Only fetch the matching district
    );

    if (!state || state.districts.length === 0) {
      return res.status(404).json({
        message: "State or district not found.",
      });
    }

    // Now filter the subDistricts from the found district
    const district = state.districts[0]; // Get the district
    const subDistrict = district.subDistricts.find(
      (sd) => sd._id.toString() === subDistrictObjectId.toString()
    );

    if (!subDistrict) {
      return res.status(404).json({
        message: "Sub-district not found.",
      });
    }

    // Return the villages
    const villages = subDistrict.villages;

    res.status(200).json({
      state: state.stateName,
      district: {
        _id: district._id,
        name: district.district,
      },
      subDistrict: {
        _id: subDistrict._id,
        name: subDistrict.subDistrict,
      },
      villages,
    });
  } catch (error) {
    console.error("Error fetching villages:", error.message);
    res.status(500).json({
      message: "Error fetching villages",
      error: error.message,
    });
  }
};

import mongoose from "mongoose";

export const getSubDistrictsByStateAndDistrict = async (req, res) => {
  try {
    const { stateId, districtId } = req.query;

    if (!stateId || !districtId) {
      return res.status(400).json({ message: "Please provide 'stateId' and 'districtId'." });
    }

    // Validate stateId and districtId
    const stateObjectId = mongoose.Types.ObjectId.isValid(stateId) ? new mongoose.Types.ObjectId(stateId) : null;
    const districtObjectId = mongoose.Types.ObjectId.isValid(districtId) ? new mongoose.Types.ObjectId(districtId) : null;

    if (!stateObjectId || !districtObjectId) {
      return res.status(400).json({ message: "Invalid 'stateId' or 'districtId' format." });
    }

    // Query the database
    const state = await District.findOne(
      { _id: stateObjectId, "districts._id": districtObjectId },
      { "districts.$": 1 } // Only fetch the matching district
    );

    if (!state || state.districts.length === 0) {
      return res.status(404).json({ message: "State or district not found." });
    }

    const district = state.districts[0];
    const subDistricts = district.subDistricts.map((subDistrict) => ({
      _id: subDistrict._id,
      name: subDistrict.subDistrict,
    }));

    res.status(200).json({
      state: state.stateName,
      district: {
        _id: district._id,
        name: district.district,
      },
      subDistricts,
    });
  } catch (error) {
    console.error("Error fetching sub-districts:", error.message);
    res.status(500).json({ message: "Error fetching sub-districts", error: error.message });
  }
};


  
  export const getAllStates = async (req, res) => {
    try {
      const states = await District.find({}, { stateName: 1, _id: 1 }); // Fetch stateName and _id
      res.status(200).json(states);
    } catch (error) {
      res.status(500).json({ message: "Error fetching states", error: error.message });
    }
  };
  
  // export const insertData = async () => {
  //   try {
  //     // Read JSON file
  //     const data = JSON.parse(fs.readFileSync("./data.json", "utf-8"));
  
  //     // Transform and save each state
  //     for (const state of data) {
  //       const newState = {
  //         stateName: state.state, // Rename "state" to "stateName"
  //         districts: state.districts.map((district) => ({
  //           district: district.district, // Name of the district
  //           subDistricts: district.subDistricts.map((subDistrict) => ({
  //             subDistrict: subDistrict.subDistrict, // Name of the sub-district
  //             villages: subDistrict.villages, // Villages array
  //           })),
  //         })),
  //       };
  
  //       // Save to database
  //       await District.create(newState);
  //       console.log(`State "${state.state}" inserted successfully.`);
  //     }
  
  //     console.log("All data inserted successfully!");
  //     process.exit(); // Exit the process after insertion
  //   } catch (error) {
  //     console.error("Error inserting data:", error.message);
  //     process.exit(1);
  //   }
  // };