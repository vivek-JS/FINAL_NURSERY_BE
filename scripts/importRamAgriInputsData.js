/**
 * Script to import Ram Agri Inputs Product Master data
 * Run with: node scripts/importRamAgriInputsData.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Import model
const RamAgriInputsProduct = (await import('../models/ramAgriInputsProduct.model.js')).default;

// Crop and Variety data from the image
const cropVarietyData = [
  {
    cropName: 'Watermelon',
    varieties: [
      'Veejay',
      'Virat',
      'Bhujang',
      'Bhujang Plus',
      'Simmba',
      'Simmba 8630',
      'Candy',
      'Prachand',
      'Aarohi',
      'Navkiran',
      'Mannat',
      'Jannat',
      'Runner',
      'Girish - Supreet',
      'Max',
      'Impact',
      'Force-9',
      'Singham',
      'Melody',
      'Nitya Simmba',
    ],
  },
  {
    cropName: 'Muskmelon',
    varieties: [
      'Madhumati',
      'Aalia',
      'Kundan',
      'Mridula',
      'Lyallpur',
      'Sagar-60',
      'Marval',
      'Marval - 25 GM',
      'Marval - 8333 Seed',
      'Vijay',
    ],
  },
  {
    cropName: 'Cucumber',
    varieties: ['WS 557', 'Sujata', 'Ruchita', 'Suchitra', 'Shruti'],
  },
  {
    cropName: 'Papaya',
    varieties: ['WS 46', 'Red Baby', 'Golden Lady', 'Red Lady'],
  },
  {
    cropName: 'Okra',
    varieties: ['Anushri', 'Samiksha', 'Saransh', 'Ridhima'],
  },
  {
    cropName: 'Tomato',
    varieties: ['Roohl', 'Goldy'],
  },
  {
    cropName: 'Gourd',
    varieties: ['US1315', 'Micromight', 'Robusta'],
  },
  {
    cropName: 'Chilly',
    varieties: ['WS 3238', 'US 1003'],
  },
  {
    cropName: 'Cauliflower',
    varieties: ['Utapati', 'Monsoon', 'WS 936'],
  },
  {
    cropName: 'Cabbage',
    varieties: ['Dollar'],
  },
  {
    cropName: 'Ridge Gourd',
    varieties: ['Rajnish'],
  },
  {
    cropName: 'Winter Squash',
    varieties: ['Deesha'],
  },
  {
    cropName: 'Sunflower',
    varieties: ['Sunshine Orange'],
  },
];

async function importData() {
  try {
    // Connect to MongoDB - try multiple possible env variable names
    const mongoUri = process.env.MONGO_URL 
      || process.env.MONGODB_URI 
      || process.env.MONGO_URI 
      || process.env.DATABASE_URL 
      || process.env.DB_URI;
    
    if (!mongoUri) {
      console.error('MongoDB connection string not found in environment variables');
      console.error('Please set one of: MONGO_URL, MONGODB_URI, MONGO_URI, DATABASE_URL, or DB_URI');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Get a default user ID (you may need to adjust this)
    const User = (await import('../models/user.model.js')).default;
    const defaultUser = await User.findOne();
    
    if (!defaultUser) {
      console.error('No user found in database. Please create a user first.');
      process.exit(1);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const cropData of cropVarietyData) {
      try {
        // Check if crop already exists
        let crop = await RamAgriInputsProduct.findOne({
          cropName: cropData.cropName,
        });

        const varietiesArray = cropData.varieties.map((v) => ({
          name: v,
          description: '',
          isActive: true,
        }));

        if (crop) {
          // Update existing crop with new varieties (merge, don't overwrite)
          const existingVarietyNames = crop.varieties.map((v) => v.name.toLowerCase());
          
          const newVarieties = varietiesArray.filter(
            (v) => !existingVarietyNames.includes(v.name.toLowerCase())
          );

          if (newVarieties.length > 0) {
            crop.varieties.push(...newVarieties);
            await crop.save();
            updatedCount++;
            console.log(`Updated: ${cropData.cropName} (added ${newVarieties.length} varieties)`);
          } else {
            skippedCount++;
            console.log(`Skipped: ${cropData.cropName} (already exists with all varieties)`);
          }
        } else {
          // Create new crop
          crop = await RamAgriInputsProduct.create({
            cropName: cropData.cropName,
            description: '',
            varieties: varietiesArray,
            isActive: true,
            createdBy: defaultUser._id,
          });
          createdCount++;
          console.log(`Created: ${cropData.cropName} (${cropData.varieties.length} varieties)`);
        }
      } catch (error) {
        console.error(`Error processing ${cropData.cropName}:`, error.message);
      }
    }

    console.log('\n=== Import Summary ===');
    console.log(`Created: ${createdCount} crops`);
    console.log(`Updated: ${updatedCount} crops`);
    console.log(`Skipped: ${skippedCount} crops`);
    console.log(`Total processed: ${cropVarietyData.length} crops`);

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('Error importing data:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the import
importData();

