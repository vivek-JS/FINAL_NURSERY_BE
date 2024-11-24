import Plant from "../models/plantCms.model.js";
import PlantSlot from "../models/slots.model.js";

// Add a new plant with subtypes
export const addPlant = async (req, res) => {
  const { name, subtypes, addedBy, slotSize } = req.body;

  try {
    // Check if a plant with the same name already exists
    const existingPlant = await Plant.findOne({ name });
    if (existingPlant) {
      return res.status(400).json({ message: "Plant name must be unique" });
    }

    const newPlant = new Plant({
      name,
      subtypes,
      addedBy,
      slotSize: slotSize || 5, // Default slot size to 5 if not provided
    });

    const savedPlant = await newPlant.save();
    return res.status(201).json({ message: "Plant added successfully", data: savedPlant });
  } catch (error) {
    return res.status(500).json({ message: "Error adding plant", error: error.message });
  }
};

// Update a plant's details, subtypes, or slotSize
// Update a plant's details, subtypes, or slotSize
export const updatePlant = async (req, res) => {
  const { plantId } = req.params;
  const { name, subtypes, slotSize } = req.body;

  try {
    const plant = await Plant.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    // Update plant fields
    plant.name = name || plant.name;
    plant.slotSize = slotSize || plant.slotSize;

    if (subtypes) {
      plant.subtypes = subtypes; // Replace subtypes if provided
    }

    const updatedPlant = await plant.save();

    // Update slots
    await updateSlotsForPlant(updatedPlant);

    return res.status(200).json({ message: "Plant updated successfully", data: updatedPlant });
  } catch (error) {
    return res.status(500).json({ message: "Error updating plant", error: error.message });
  }
};

// Delete a plant
export const deletePlant = async (req, res) => {
  const { plantId } = req.params;

  try {
    // Find the plant to delete
    const deletedPlant = await Plant.findByIdAndDelete(plantId);

    if (!deletedPlant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    // Delete related slots
    await PlantSlot.deleteMany({ plantId });
    console.log(`Deleted slots for plant ID: ${plantId}`);

    return res
      .status(200)
      .json({ message: "Plant and related slots deleted successfully", data: deletedPlant });
  } catch (error) {
    console.error("Error deleting plant and related slots:", error);
    return res.status(500).json({ message: "Error deleting plant", error: error.message });
  }
};
// Add a new subtype to an existing plant
export const addSubtype = async (req, res) => {
  const { plantId } = req.params;
  const { name, description, characteristics } = req.body;

  try {
    const plant = await Plant.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    plant.subtypes.push({ name, description, characteristics });
    const updatedPlant = await plant.save();

    return res.status(200).json({ message: "Subtype added successfully", data: updatedPlant });
  } catch (error) {
    return res.status(500).json({ message: "Error adding subtype", error: error.message });
  }
};

// Update a specific subtype
export const updateSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;
  const { name, description, characteristics } = req.body;

  try {
    const plant = await Plant.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    const subtype = plant.subtypes.id(subtypeId);

    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    subtype.name = name || subtype.name;
    subtype.description = description || subtype.description;
    subtype.characteristics = characteristics || subtype.characteristics;

    const updatedPlant = await plant.save();

    return res.status(200).json({ message: "Subtype updated successfully", data: updatedPlant });
  } catch (error) {
    return res.status(500).json({ message: "Error updating subtype", error: error.message });
  }
};

// Delete a specific subtype
export const deleteSubtype = async (req, res) => {
  const { plantId, subtypeId } = req.params;

  try {
    const plant = await Plant.findById(plantId);

    if (!plant) {
      return res.status(404).json({ message: "Plant not found" });
    }

    const subtype = plant.subtypes.id(subtypeId);

    if (!subtype) {
      return res.status(404).json({ message: "Subtype not found" });
    }

    subtype.remove();
    const updatedPlant = await plant.save();

    return res.status(200).json({ message: "Subtype deleted successfully", data: updatedPlant });
  } catch (error) {
    return res.status(500).json({ message: "Error deleting subtype", error: error.message });
  }
};

// Get all plants
export const getPlants = async (req, res) => {
  try {
    // Fetch all plants and populate their subtypes
    const plants = await Plant.find()
      .select("name subtypes slotSize addedBy") // Select fields to return
      .populate("subtypes") // Populate the subtypes field
      .exec();

    if (!plants || plants.length === 0) {
      return res.status(404).json({ message: "No plants found" });
    }

    return res.status(200).json({ message: "Plants retrieved successfully", data: plants });
  } catch (error) {
    return res.status(500).json({ message: "Error retrieving plants", error: error.message });
  }
};


const updateSlotsForPlant = async (plant) => {
  try {
    const year = new Date().getFullYear();
    const { slotSize = 5 } = plant;

    // Fetch or create PlantSlot for the plant
    let plantSlot = await PlantSlot.findOne({ plantId: plant._id, year });

    if (!plantSlot) {
      plantSlot = new PlantSlot({ plantId: plant._id, year, subtypeSlots: [] });
    }

    const existingSubtypeIds = new Set(
      plantSlot.subtypeSlots.map((slot) => slot.subtypeId.toString())
    );

    const newSubtypes = plant.subtypes.filter(
      (subtype) => !existingSubtypeIds.has(subtype._id.toString())
    );

    // Add slots for new subtypes
    if (newSubtypes.length > 0) {
      const newSubtypeSlots = newSubtypes.map((subtype) => ({
        subtypeId: subtype._id,
        slots: generateSlotsForYear(year, slotSize),
      }));
      plantSlot.subtypeSlots.push(...newSubtypeSlots);
    }

    // Optionally regenerate slots for all subtypes if slotSize changes
    if (plantSlot.slotSize !== slotSize) {
      plantSlot.subtypeSlots.forEach((subtypeSlot) => {
        subtypeSlot.slots = generateSlotsForYear(year, slotSize);
      });
      plantSlot.slotSize = slotSize;
    }

    await plantSlot.save();
  } catch (error) {
    console.error("Error updating slots:", error);
  }
};