import mongoose from 'mongoose';
import MeasurementUnit from './models/measurementUnit.model.js';
import dotenv from 'dotenv';

dotenv.config();

const units = [
  // Quantity units (base)
  { name: 'Piece', abbreviation: 'Pc', type: 'quantity', conversionToBase: 1, baseUnit: null },
  { name: 'Dozen', abbreviation: 'Dz', type: 'quantity', conversionToBase: 12, baseUnit: null },
  { name: 'Gross', abbreviation: 'Gr', type: 'quantity', conversionToBase: 144, baseUnit: null },
  
  // Weight units (gram as base)
  { name: 'Gram', abbreviation: 'g', type: 'weight', conversionToBase: 1, baseUnit: null },
  { name: 'Kilogram', abbreviation: 'kg', type: 'weight', conversionToBase: 1000, baseUnit: null },
  { name: 'Milligram', abbreviation: 'mg', type: 'weight', conversionToBase: 0.001, baseUnit: null },
  { name: 'Ton', abbreviation: 't', type: 'weight', conversionToBase: 1000000, baseUnit: null },
  { name: 'Quintal', abbreviation: 'q', type: 'weight', conversionToBase: 100000, baseUnit: null },
  
  // Volume units (liter as base)
  { name: 'Liter', abbreviation: 'L', type: 'volume', conversionToBase: 1, baseUnit: null },
  { name: 'Milliliter', abbreviation: 'mL', type: 'volume', conversionToBase: 0.001, baseUnit: null },
  { name: 'Gallon', abbreviation: 'gal', type: 'volume', conversionToBase: 3.78541, baseUnit: null },
  
  // Length units (meter as base)
  { name: 'Meter', abbreviation: 'm', type: 'length', conversionToBase: 1, baseUnit: null },
  { name: 'Centimeter', abbreviation: 'cm', type: 'length', conversionToBase: 0.01, baseUnit: null },
  { name: 'Millimeter', abbreviation: 'mm', type: 'length', conversionToBase: 0.001, baseUnit: null },
  { name: 'Kilometer', abbreviation: 'km', type: 'length', conversionToBase: 1000, baseUnit: null },
  { name: 'Inch', abbreviation: 'in', type: 'length', conversionToBase: 0.0254, baseUnit: null },
  { name: 'Foot', abbreviation: 'ft', type: 'length', conversionToBase: 0.3048, baseUnit: null },
  
  // Area units (square meter as base)
  { name: 'Square Meter', abbreviation: 'sq m', type: 'area', conversionToBase: 1, baseUnit: null },
  { name: 'Square Foot', abbreviation: 'sq ft', type: 'area', conversionToBase: 0.092903, baseUnit: null },
  { name: 'Acre', abbreviation: 'ac', type: 'area', conversionToBase: 4046.86, baseUnit: null },
  { name: 'Hectare', abbreviation: 'ha', type: 'area', conversionToBase: 10000, baseUnit: null },
];

async function seedMeasurementUnits() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB');

    // Check if units already exist
    const count = await MeasurementUnit.countDocuments();
    if (count > 0) {
      console.log(`${count} measurement units already exist. Skipping seed.`);
      process.exit(0);
    }

    console.log('Seeding measurement units...');
    await MeasurementUnit.insertMany(units);
    console.log(`Successfully seeded ${units.length} measurement units!`);

    process.exit(0);
  } catch (error) {
    console.error('Error seeding measurement units:', error);
    process.exit(1);
  }
}

seedMeasurementUnits();

