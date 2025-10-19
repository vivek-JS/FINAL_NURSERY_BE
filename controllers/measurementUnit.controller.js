import MeasurementUnit from '../models/measurementUnit.model.js';

// Create measurement unit
export const createMeasurementUnit = async (req, res) => {
  try {
    const { name, abbreviation, type, conversionToBase, baseUnit } = req.body;

    const measurementUnit = new MeasurementUnit({
      name,
      abbreviation,
      type,
      conversionToBase: conversionToBase || 1,
      baseUnit,
    });

    await measurementUnit.save();

    if (baseUnit) {
      await measurementUnit.populate('baseUnit');
    }

    res.status(201).json({
      success: true,
      message: 'Measurement unit created successfully',
      data: measurementUnit,
    });
  } catch (error) {
    console.error('Error creating measurement unit:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating measurement unit',
      error: error.message,
    });
  }
};

// Get all measurement units
export const getAllMeasurementUnits = async (req, res) => {
  try {
    const { type, isActive } = req.query;

    const query = {};

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const measurementUnits = await MeasurementUnit.find(query)
      .populate('baseUnit')
      .sort({ type: 1, name: 1 });

    res.json({
      success: true,
      data: measurementUnits,
    });
  } catch (error) {
    console.error('Error fetching measurement units:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching measurement units',
      error: error.message,
    });
  }
};

// Get measurement unit by ID
export const getMeasurementUnitById = async (req, res) => {
  try {
    const measurementUnit = await MeasurementUnit.findById(req.params.id).populate('baseUnit');

    if (!measurementUnit) {
      return res.status(404).json({
        success: false,
        message: 'Measurement unit not found',
      });
    }

    res.json({
      success: true,
      data: measurementUnit,
    });
  } catch (error) {
    console.error('Error fetching measurement unit:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching measurement unit',
      error: error.message,
    });
  }
};

// Update measurement unit
export const updateMeasurementUnit = async (req, res) => {
  try {
    const measurementUnit = await MeasurementUnit.findById(req.params.id);

    if (!measurementUnit) {
      return res.status(404).json({
        success: false,
        message: 'Measurement unit not found',
      });
    }

    const updateFields = ['name', 'abbreviation', 'conversionToBase', 'isActive'];

    updateFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        measurementUnit[field] = req.body[field];
      }
    });

    await measurementUnit.save();

    res.json({
      success: true,
      message: 'Measurement unit updated successfully',
      data: measurementUnit,
    });
  } catch (error) {
    console.error('Error updating measurement unit:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating measurement unit',
      error: error.message,
    });
  }
};

// Delete measurement unit (soft delete)
export const deleteMeasurementUnit = async (req, res) => {
  try {
    const measurementUnit = await MeasurementUnit.findById(req.params.id);

    if (!measurementUnit) {
      return res.status(404).json({
        success: false,
        message: 'Measurement unit not found',
      });
    }

    measurementUnit.isActive = false;
    await measurementUnit.save();

    res.json({
      success: true,
      message: 'Measurement unit deactivated successfully',
    });
  } catch (error) {
    console.error('Error deleting measurement unit:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting measurement unit',
      error: error.message,
    });
  }
};

