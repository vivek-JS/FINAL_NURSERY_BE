import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Category from '../models/category.model.js';
import User from '../models/user.model.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nursery';

const defaultCategories = [
  {
    name: 'seeds',
    displayName: 'Seeds',
    description: 'Plant seeds and seed varieties',
  },
  {
    name: 'fertilizer',
    displayName: 'Fertilizer',
    description: 'Fertilizers and plant nutrients',
  },
  {
    name: 'raw_material',
    displayName: 'Raw Material',
    description: 'Raw materials for production',
  },
  {
    name: 'packaging',
    displayName: 'Packaging',
    description: 'Packaging materials',
  },
  {
    name: 'finished_good',
    displayName: 'Finished Good',
    description: 'Finished products ready for sale',
  },
  {
    name: 'consumable',
    displayName: 'Consumable',
    description: 'Consumable items',
  },
  {
    name: 'other',
    displayName: 'Other',
    description: 'Other products',
  },
];

async function seedCategories() {
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

    for (const categoryData of defaultCategories) {
      const existingCategory = await Category.findOne({ name: categoryData.name });
      
      if (existingCategory) {
        console.log(`ℹ️  Category "${categoryData.displayName}" already exists`);
        existingCount++;
      } else {
        await Category.create({
          ...categoryData,
          createdBy: user._id,
        });
        console.log(`✅ Created category: ${categoryData.displayName}`);
        createdCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ CATEGORY SEEDING COMPLETED!');
    console.log('='.repeat(60));
    console.log(`📊 Created: ${createdCount}`);
    console.log(`📊 Already existed: ${existingCount}`);
    console.log(`📊 Total: ${defaultCategories.length}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Error seeding categories:', error);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedCategories();
}

export default seedCategories;



