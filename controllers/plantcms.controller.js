import PlantCms from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

// Add a new plant with subtypes
export const addPlant = async (req, res) => {
  const { name, subtypes, addedBy, slotSize, buffer, sowingAllowed } = req.body;

  try {
    // Check if a plant with the same name already exists
    const existingPlant = await PlantCms.findOne({ name });
    if (existingPlant) {
      return res.status(400).json({ message: "Plant name must be unique" });
    }

    // Process subtypes to include required fields and validate structure
    const processedSubtypes = subtypes.map((subtype) => {
      if (!subtype.name) {
        throw new Error("Each subtype must have a name.");
      }

      return {
        name: subtype.name,
        description: subtype.description || "",
        characteristics: subtype.characteristics || {},
        rates: Array.isArray(subtype.rates) ? subtype.rates : [], // Ensure rates is an array
        buffer: subtype.buffer || 0,
        plantReadyDays: subtype.plantReadyDays || 0, // Plant ready days for sowing
      };
    });

    // Create a new plant document
    const newPlant = new PlantCms({
      name,
      subtypes: processedSubtypes,
      addedBy,
      slotSize: slotSize || 5, // Default slot size to 5 if not provided
      buffer: buffer || 0, // Default buffer to 0 if not provided
      sowingAllowed: sowingAllowed || false, // Default sowing allowed to false
    });

    const savedPlant = await newPlant.save();

    return res
      .status(201)
      .json({ message: "Plant added successfully", data: savedPlant });
  } catch (error) {
    console.error("Error adding plant:", error.message);
    return res.status(500).json({
      message: "Error adding plant",
      error: error.message,
    });
  }
};

// Update a plant's details, subtypes, or slotSize
export const updatePlant = async (req, res) => {
  const { plantId } = req.params;
  const { name, subtypes, slotSize, buffer, sowingAllowed } = req.body;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    // Update plant fields
    plant.name = name || plant.name;
    plant.slotSize = slotSize || plant.slotSize;
    plant.buffer = buffer !== undefined ? buffer : plant.buffer;
    plant.sowingAllowed = sowingAllowed !== undefined ? sowingAllowed : plant.sowingAllowed;

    if (subtypes) {
      plant.subtypes = subtypes; // Replace subtypes if provided
    }

    const updatedPlant = await plant.save();

    return res
      .status(200)
      .json({ message: "Plant updated successfully", data: updatedPlant });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating plant", error: error.message });
  }
};

// Delete a plant
export const deletePlant = async (req, res) => {
  const { plantId } = req.params;

  try {
    // Find the plant to delete
    const deletedPlant = await PlantCms.findByIdAndDelete(plantId);

    if (!deletedPlant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    // Delete related slots
    await PlantSlot.deleteMany({ plantId });
    // console.log(`Deleted slots for plant ID: ${plantId}`);

    return res.status(200).json({
      message: "Plant and related slots deleted successfully",
      data: deletedPlant,
    });
  } catch (error) {
    console.error("Error deleting plant and related slots:", error);
    return res
      .status(500)
      .json({ message: "Error deleting plant", error: error.message });
  }
};
// Add a new subtype to an existing plant
export const addSubtype = async (req, res) => {
  const { plantId } = req.params;
  const { name, description, characteristics } = req.body;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    plant.subtypes.push({ name, description, characteristics });
    const updatedPlant = await plant.save();

    return res
      .status(200)
      .json({ message: "Subtype added successfully", data: updatedPlant });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error adding subtype", error: error.message });
  }
};

// Update a specific subtype
export const updateSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;
  const { name, description, characteristics, plantReadyDays } = req.body;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    const subtype = plant.subtypes.id(subtypeId);

    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    if (name !== undefined) subtype.name = name;
    if (description !== undefined) subtype.description = description;
    if (characteristics !== undefined) subtype.characteristics = characteristics;
    if (plantReadyDays !== undefined) subtype.plantReadyDays = Number(plantReadyDays) || 0;

    const updatedPlant = await plant.save();

    return res
      .status(200)
      .json({ message: "Subtype updated successfully", data: updatedPlant });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error updating subtype", error: error.message });
  }
};

// Delete a specific subtype
export const deleteSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;

  try {
    const plant = await PlantCms.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    const subtype = plant.subtypes.id(subtypeId);

    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    subtype.remove();
    const updatedPlant = await plant.save();

    return res
      .status(200)
      .json({ message: "Subtype deleted successfully", data: updatedPlant });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error deleting subtype", error: error.message });
  }
};

// Get all plants
export const getPlants = async (req, res) => {
  try {
    // Fetch all plants with their embedded subtypes (including plantReadyDays)
    const plants = await PlantCms.find()
      .select("name subtypes slotSize addedBy buffer sowingAllowed createdAt") // Select fields to return
      .lean() // Convert to plain JavaScript object for better performance
      .exec();

    if (!plants || plants.length === 0) {
      return res.status(404).json({ message: "No plant data found." });
    }

    // Ensure all subtype fields are included (plantReadyDays, buffer, etc.) with default values
    const plantsWithCompleteData = plants.map(plant => ({
      _id: plant._id,
      name: plant.name,
      slotSize: plant.slotSize,
      buffer: plant.buffer || 0,
      sowingAllowed: plant.sowingAllowed || false, // Explicitly include with default
      createdAt: plant.createdAt,
      addedBy: plant.addedBy,
      subtypes: plant.subtypes.map(subtype => ({
        _id: subtype._id,
        name: subtype.name,
        description: subtype.description || "",
        characteristics: subtype.characteristics || {},
        rates: subtype.rates || [],
        dailyDispatch: subtype.dailyDispatch || 0,
        buffer: subtype.buffer || 0,
        plantReadyDays: subtype.plantReadyDays || 0, // Explicitly include plantReadyDays with default
      }))
    }));

    return res
      .status(200)
      .json({ 
        success: true, 
        message: "Plants retrieved successfully", 
        data: plantsWithCompleteData 
      });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error retrieving plants", error: error.message });
  }
};

// Auto slot generation removed - slots are now managed through dedicated slot management system
