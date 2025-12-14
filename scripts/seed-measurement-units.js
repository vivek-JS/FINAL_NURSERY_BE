import mongoose from 'mongoose';
import dotenv from 'dotenv';
import MeasurementUnit from '../models/measurementUnit.model.js';
import User from '../models/user.model.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

const defaultUnits = [
  // Weight units
  {
    name: 'Kilogram',
    abbreviation: 'kg',
    type: 'weight',
    conversionToBase: 1,
  },
  {
    name: 'Gram',
    abbreviation: 'g',
    type: 'weight',
    conversionToBase: 0.001,
  },
  {
    name: 'Quintal',
    abbreviation: 'qtl',
    type: 'weight',
    conversionToBase: 100,
  },
  {
    name: 'Ton',
    abbreviation: 'ton',
    type: 'weight',
    conversionToBase: 1000,
  },
  
  // Volume units
  {
    name: 'Liter',
    abbreviation: 'L',
    type: 'volume',
    conversionToBase: 1,
  },
  {
    name: 'Milliliter',
    abbreviation: 'ml',
    type: 'volume',
    conversionToBase: 0.001,
  },
  
  // Quantity units
  {
    name: 'Piece',
    abbreviation: 'pcs',
    type: 'quantity',
    conversionToBase: 1,
  },
  {
    name: 'Packet',
    abbreviation: 'pkt',
    type: 'quantity',
    conversionToBase: 1,
  },
  {
    name: 'Box',
    abbreviation: 'box',
    type: 'quantity',
    conversionToBase: 1,
    requiresSecondaryUnit: true,
  },
  {
    name: 'Bag',
    abbreviation: 'bag',
    type: 'quantity',
    conversionToBase: 1,
    requiresSecondaryUnit: true,
  },
  {
    name: 'Bundle',
    abbreviation: 'bundle',
    type: 'quantity',
    conversionToBase: 1,
  },
  {
    name: 'Dozen',
    abbreviation: 'dozen',
    type: 'quantity',
    conversionToBase: 12,
  },
  {
    name: 'Seeds',
    abbreviation: 'seeds',
    type: 'quantity',
    conversionToBase: 1,
    requiresSecondaryUnit: true,
  },
  
  // Area units
  {
    name: 'Square Meter',
    abbreviation: 'sqm',
    type: 'area',
    conversionToBase: 1,
  },
  {
    name: 'Hectare',
    abbreviation: 'ha',
    type: 'area',
    conversionToBase: 10000,
  },
];

async function seedMeasurementUnits() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get a user for createdBy fields
    let user = await User.findOne({ role: 'SUPER_ADMIN' });
    if (!user) {
      user = await User.findOne({ role: 'ADMIN' });
    }
    if (!user) {
      user = await User.findOne();
    }
    if (!user) {
      console.error('❌ No user found. Please create a user first.');
      process.exit(1);
    }

    console.log(`✅ Using user: ${user.name || user.email} (${user.role})\n`);

    let createdCount = 0;
    let existingCount = 0;

    for (const unitData of defaultUnits) {
      const existingUnit = await MeasurementUnit.findOne({ 
        $or: [
          { name: unitData.name },
          { abbreviation: unitData.abbreviation }
        ]
      });
      
      if (existingUnit) {
        console.log(`ℹ️  Unit "${unitData.name} (${unitData.abbreviation})" already exists`);
        existingCount++;
      } else {
        const unitToCreate = {
          ...unitData,
          createdBy: user._id,
        };
        // Remove requiresSecondaryUnit if not provided (for backward compatibility)
        if (unitToCreate.requiresSecondaryUnit === undefined) {
          delete unitToCreate.requiresSecondaryUnit;
        }
        await MeasurementUnit.create(unitToCreate);
        console.log(`✅ Created unit: ${unitData.name} (${unitData.abbreviation})${unitData.requiresSecondaryUnit ? ' [Requires Secondary UOM]' : ''}`);
        createdCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ MEASUREMENT UNIT SEEDING COMPLETED!');
    console.log('='.repeat(60));
    console.log(`📊 Created: ${createdCount}`);
    console.log(`📊 Already existed: ${existingCount}`);
    console.log(`📊 Total: ${defaultUnits.length}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Error seeding measurement units:', error);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedMeasurementUnits();
}

export default seedMeasurementUnits;





