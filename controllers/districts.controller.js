import District from "../models/District.model.js";

export const getAllDistricts = async (req, res) => {
    try {
      const districts = await District.find({}, { district: 1, _id: 0 }); // Fetch only the district field
      const districtNames = districts.map((d) => d.district);
      res.status(200).json(districtNames);
    } catch (error) {
      res.status(500).json({ message: "Error fetching districts", error });
    }
  };


  

export const getVillages = async (req, res) => {
  try {
    console.log(req)
    const { district, subDistrict } = req.query;

    if (!district || !subDistrict) {
      return res.status(400).json({
        message: "Please provide both 'district' and 'subDistrict'.",
      });
    }

    // Find the district
    const districtData = await District.findOne(
      { district, "subDistricts.subDistrict": subDistrict },
      { "subDistricts.$": 1 } // Return only the matching subDistrict
    );

    if (!districtData || districtData.subDistricts.length === 0) {
      return res.status(404).json({
        message: "District or subdistrict not found.",
      });
    }

    const villages = districtData.subDistricts[0].villages;

    res.status(200).json({
      district,
      subDistrict,
      villages,
    });
  } catch (error) {
    console.error("Error fetching villages:", error);
    res.status(500).json({
      message: "An error occurred while fetching the village list.",
      error: error.message,
    });
  }
};
export const getSubDistrictsByDistrict = async (req, res) => {
    try {
      const { district } = req.query; // Get the district from query params
  
      if (!district) {
        return res.status(400).json({ message: "Please provide a district name." });
      }
  
      const result = await District.findOne({ district }).select("subDistricts.subDistrict");
      
      if (!result) {
        return res.status(404).json({ message: "District not found." });
      }
  
      const subDistricts = result.subDistricts.map((sd) => sd.subDistrict);
      return res.status(200).json({ subDistricts });
    } catch (error) {
        console.log(error)
      return res.status(500).json({ message: "An error occurred.", error });
    }
  };
  