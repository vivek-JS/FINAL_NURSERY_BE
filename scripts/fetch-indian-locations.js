import mongoose from 'mongoose';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import State from '../models/state.model.js';

dotenv.config();

// MongoDB connection
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URL);
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

// Fetch data from GitHub repository
const fetchLocationData = async () => {
    try {
        console.log('Fetching location data from GitHub...');
        const response = await fetch('https://raw.githubusercontent.com/pranshumaheshwari/indian-cities-and-villages/refs/heads/master/data.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching data from GitHub:', error.message);
        throw error;
    }
};

// Helper function to generate code from name
const generateCode = (name) => {
    if (!name || typeof name !== 'string') {
        return 'Unknown';
    }
    return name
        .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('')
        .substring(0, 10); // Limit to 10 characters
};

// Process and insert data into database
const processLocationData = async (data) => {
    try {
        console.log(`Processing ${data.length} states...`);
        console.log('Sample state data:', JSON.stringify(data[0], null, 2));
        
        // Clear existing data
        await State.deleteMany({});
        console.log('Cleared existing state data');
        
        const statesToInsert = [];
        
        for (const stateData of data) {
            if (!stateData.state) {
                console.log('Skipping state with no name:', stateData);
                continue;
            }
            
            const state = {
                name: stateData.state,
                code: generateCode(stateData.state),
                districts: []
            };
            
            if (stateData.districts && Array.isArray(stateData.districts)) {
                for (const districtData of stateData.districts) {
                    const district = {
                        name: districtData.district,
                        code: generateCode(districtData.district),
                        talukas: []
                    };
                    
                    if (districtData.subDistricts && Array.isArray(districtData.subDistricts)) {
                        for (const talukaData of districtData.subDistricts) {
                            const taluka = {
                                name: talukaData.subDistrict,
                                code: generateCode(talukaData.subDistrict),
                                villages: []
                            };
                            
                            if (talukaData.villages && Array.isArray(talukaData.villages)) {
                                for (const villageName of talukaData.villages) {
                                    taluka.villages.push({
                                        name: villageName,
                                        code: generateCode(villageName)
                                    });
                                }
                            }
                            
                            district.talukas.push(taluka);
                        }
                    }
                    
                    state.districts.push(district);
                }
            }
            
            statesToInsert.push(state);
        }
        
        // Insert all states
        const result = await State.insertMany(statesToInsert);
        console.log(`Successfully inserted ${result.length} states with complete location data`);
        
        // Log summary
        let totalDistricts = 0;
        let totalTalukas = 0;
        let totalVillages = 0;
        
        result.forEach(state => {
            totalDistricts += state.districts.length;
            state.districts.forEach(district => {
                totalTalukas += district.talukas.length;
                district.talukas.forEach(taluka => {
                    totalVillages += taluka.villages.length;
                });
            });
        });
        
        console.log('\n=== DATA SUMMARY ===');
        console.log(`States: ${result.length}`);
        console.log(`Districts: ${totalDistricts}`);
        console.log(`Talukas: ${totalTalukas}`);
        console.log(`Villages: ${totalVillages}`);
        console.log('===================\n');
        
        return result;
        
    } catch (error) {
        console.error('Error processing location data:', error);
        throw error;
    }
};

// Main execution function
const main = async () => {
    try {
        await connectDB();
        
        const locationData = await fetchLocationData();
        await processLocationData(locationData);
        
        console.log('Location data import completed successfully!');
        process.exit(0);
        
    } catch (error) {
        console.error('Script execution failed:', error);
        process.exit(1);
    }
};

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { fetchLocationData, processLocationData }; 