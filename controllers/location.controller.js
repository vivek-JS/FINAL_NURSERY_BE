import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import State from "../models/state.model.js";

// Simple in-memory cache for location data
const locationCache = {
  states: null,
  statesTimestamp: null,
  stateData: new Map(), // Cache for individual state data
  cacheDuration: 5 * 60 * 1000, // 5 minutes in milliseconds
  
  isExpired() {
    return !this.statesTimestamp || (Date.now() - this.statesTimestamp) > this.cacheDuration;
  },
  
  setStates(data) {
    this.states = data;
    this.statesTimestamp = Date.now();
  },
  
  getStates() {
    return this.isExpired() ? null : this.states;
  },
  
  setStateData(stateName, data) {
    this.stateData.set(stateName.toLowerCase(), {
      data,
      timestamp: Date.now()
    });
  },
  
  getStateData(stateName) {
    const cached = this.stateData.get(stateName.toLowerCase());
    if (cached && (Date.now() - cached.timestamp) < this.cacheDuration) {
      return cached.data;
    }
    return null;
  },
  
  clear() {
    this.states = null;
    this.statesTimestamp = null;
    this.stateData.clear();
  }
};

// Helper function to find state by name or ID (optimized)
const findState = async (stateIdentifier) => {
  // Check cache first for name-based searches
  if (!stateIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
    const cachedState = locationCache.getStateData(stateIdentifier);
    if (cachedState) {
      return cachedState;
    }
  }
  
  let state;
  
  // Check if it's a valid ObjectId
  if (stateIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
    state = await State.findById(stateIdentifier).lean();
  } else {
    // Try exact match first (much faster)
    state = await State.findOne({ 
      name: stateIdentifier 
    }).lean();
    
    // If exact match fails, try case-insensitive match
    if (!state) {
      state = await State.findOne({ 
        name: { $regex: new RegExp(`^${stateIdentifier}$`, 'i') } 
      }).lean();
    }
  }
  
  // Cache the result for name-based searches
  if (state && !stateIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
    locationCache.setStateData(stateIdentifier, state);
  }
  
  return state;
};

// Helper function to find district by name or ID within a state
const findDistrict = (state, districtIdentifier) => {
  if (!state || !state.districts) return null;
  
  // Check if it's a valid ObjectId
  if (districtIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
    return state.districts.id(districtIdentifier);
  } else {
    // Search by name
    return state.districts.find(district => 
      district.name.toLowerCase() === districtIdentifier.toLowerCase()
    );
  }
};

// Helper function to find taluka by name or ID within a district
const findTaluka = (district, talukaIdentifier) => {
  if (!district || !district.talukas) return null;
  
  // Check if it's a valid ObjectId
  if (talukaIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
    return district.talukas.id(talukaIdentifier);
  } else {
    // Search by name
    return district.talukas.find(taluka => 
      taluka.name.toLowerCase() === talukaIdentifier.toLowerCase()
    );
  }
};

// Get all states (optimized for frontend)
export const getAllStates = catchAsync(async (req, res, next) => {
  try {
    // Only fetch states with basic info, no nested data
    const states = await State.find({})
      .select('name code')
      .sort({ name: 1 })
      .lean(); // Use lean() for better performance
    
    res.status(200).json({
      status: "success",
      results: states.length,
      data: states.map(state => ({
        id: state._id,
        name: state.name,
        code: state.code
      }))
    });
  } catch (error) {
    console.error("Error fetching states:", error);
    return next(new AppError("Failed to fetch states", 500));
  }
});

// Get state by name or ID
export const getState = catchAsync(async (req, res, next) => {
  const { stateIdentifier } = req.params;
  
  const state = await findState(stateIdentifier);
  
  if (!state) {
    return next(new AppError("State not found", 404));
  }
  
  res.status(200).json({
    status: "success",
    data: {
      id: state._id,
      name: state.name,
      code: state.code,
      districtsCount: state.districts?.length || 0
    }
  });
});

// Get districts for a state (by name or ID)
export const getDistricts = catchAsync(async (req, res, next) => {
  const { stateIdentifier } = req.params;
  
  const state = await findState(stateIdentifier);
  
  if (!state) {
    return next(new AppError("State not found", 404));
  }
  
  const districts = state.districts?.map(district => ({
    id: district._id,
    name: district.name,
    code: district.code,
    talukasCount: district.talukas?.length || 0
  })) || [];
  
  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
        code: state.code
      },
      districts,
      total: districts.length
    }
  });
});

// Get talukas for a district (by name or ID)
export const getTalukas = catchAsync(async (req, res, next) => {
  const { stateIdentifier, districtIdentifier } = req.params;
  
  const state = await findState(stateIdentifier);
  
  if (!state) {
    return next(new AppError("State not found", 404));
  }
  
  const district = findDistrict(state, districtIdentifier);
  
  if (!district) {
    return next(new AppError("District not found", 404));
  }
  
  const talukas = district.talukas?.map(taluka => ({
    id: taluka._id,
    name: taluka.name,
    code: taluka.code,
    villagesCount: taluka.villages?.length || 0
  })) || [];
  
  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
        code: state.code
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code
      },
      talukas,
      total: talukas.length
    }
  });
});

// Get villages for a taluka (by name or ID)
export const getVillages = catchAsync(async (req, res, next) => {
  const { stateIdentifier, districtIdentifier, talukaIdentifier } = req.params;
  
  const state = await findState(stateIdentifier);
  
  if (!state) {
    return next(new AppError("State not found", 404));
  }
  
  const district = findDistrict(state, districtIdentifier);
  
  if (!district) {
    return next(new AppError("District not found", 404));
  }
  
  const taluka = findTaluka(district, talukaIdentifier);
  
  if (!taluka) {
    return next(new AppError("Taluka not found", 404));
  }
  
  const villages = taluka.villages?.map(village => ({
    id: village._id,
    name: village.name,
    code: village.code
  })) || [];
  
  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
        code: state.code
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code
      },
      taluka: {
        id: taluka._id,
        name: taluka.name,
        code: taluka.code
      },
      villages,
      total: villages.length
    }
  });
});

// Flexible cascading location API - accepts names or IDs (optimized)
export const getCascadingLocation = catchAsync(async (req, res, next) => {
  const { state, district, taluka } = req.body;
  
  if (!state) {
    return next(new AppError("State identifier is required", 400));
  }
  
  const startTime = Date.now();
  
  try {
    // Find state with caching
    const stateData = await findState(state);
    
    if (!stateData) {
      return next(new AppError("State not found", 404));
    }
    
    const response = {
      state: {
        id: stateData._id,
        name: stateData.name,
        code: stateData.code
      }
    };
    
    // If only state is provided, return districts
    if (!district) {
      const districts = stateData.districts?.map(dist => ({
        id: dist._id,
        name: dist.name,
        code: dist.code,
        talukasCount: dist.talukas?.length || 0
      })) || [];
      
      const duration = Date.now() - startTime;
      console.log(`Cascading API (districts): ${duration}ms for state: ${state}`);
      
      return res.status(200).json({
        status: "success",
        data: {
          ...response,
          districts,
          total: districts.length
        },
        performance: {
          duration: `${duration}ms`,
          cached: !!locationCache.getStateData(state)
        }
      });
    }
    
    // Find district
    const districtData = findDistrict(stateData, district);
    
    if (!districtData) {
      return next(new AppError("District not found", 404));
    }
    
    response.district = {
      id: districtData._id,
      name: districtData.name,
      code: districtData.code
    };
    
    // If only state and district are provided, return talukas
    if (!taluka) {
      const talukas = districtData.talukas?.map(tal => ({
        id: tal._id,
        name: tal.name,
        code: tal.code,
        villagesCount: tal.villages?.length || 0
      })) || [];
      
      const duration = Date.now() - startTime;
      console.log(`Cascading API (talukas): ${duration}ms for state: ${state}, district: ${district}`);
      
      return res.status(200).json({
        status: "success",
        data: {
          ...response,
          talukas,
          total: talukas.length
        },
        performance: {
          duration: `${duration}ms`,
          cached: !!locationCache.getStateData(state)
        }
      });
    }
    
    // Find taluka
    const talukaData = findTaluka(districtData, taluka);
    
    if (!talukaData) {
      return next(new AppError("Taluka not found", 404));
    }
    
    response.taluka = {
      id: talukaData._id,
      name: talukaData.name,
      code: talukaData.code
    };
    
    // Return villages
    const villages = talukaData.villages?.map(village => ({
      id: village._id,
      name: village.name,
      code: village.code
    })) || [];
    
    const duration = Date.now() - startTime;
    console.log(`Cascading API (villages): ${duration}ms for state: ${state}, district: ${district}, taluka: ${taluka}`);
    
    res.status(200).json({
      status: "success",
      data: {
        ...response,
        villages,
        total: villages.length
      },
      performance: {
        duration: `${duration}ms`,
        cached: !!locationCache.getStateData(state)
      }
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`Error in cascading location API (${duration}ms):`, error);
    return next(new AppError("Failed to fetch location data", 500));
  }
});

// Search locations by name (fuzzy search)
export const searchLocations = catchAsync(async (req, res, next) => {
  const { query, type } = req.query;
  
  if (!query) {
    return next(new AppError("Search query is required", 400));
  }
  
  const searchRegex = new RegExp(query, 'i');
  let results = [];
  
  if (!type || type === 'all' || type === 'states') {
    const states = await State.find({ name: searchRegex }).select('name code');
    results.push(...states.map(state => ({
      type: 'state',
      id: state._id,
      name: state.name,
      code: state.code
    })));
  }
  
  if (!type || type === 'all' || type === 'districts') {
    const statesWithDistricts = await State.find({
      'districts.name': searchRegex
    }).select('name districts.name districts.code districts._id');
    
    statesWithDistricts.forEach(state => {
      const matchingDistricts = state.districts.filter(district => 
        district.name.match(searchRegex)
      );
      
      matchingDistricts.forEach(district => {
        results.push({
          type: 'district',
          id: district._id,
          name: district.name,
          code: district.code,
          state: {
            id: state._id,
            name: state.name,
            code: state.code
          }
        });
      });
    });
  }
  
  if (!type || type === 'all' || type === 'talukas') {
    const statesWithTalukas = await State.find({
      'districts.talukas.name': searchRegex
    }).select('name districts.name districts._id districts.talukas.name districts.talukas.code districts.talukas._id');
    
    statesWithTalukas.forEach(state => {
      state.districts.forEach(district => {
        const matchingTalukas = district.talukas?.filter(taluka => 
          taluka.name.match(searchRegex)
        ) || [];
        
        matchingTalukas.forEach(taluka => {
          results.push({
            type: 'taluka',
            id: taluka._id,
            name: taluka.name,
            code: taluka.code,
            district: {
              id: district._id,
              name: district.name,
              code: district.code
            },
            state: {
              id: state._id,
              name: state.name,
              code: state.code
            }
          });
        });
      });
    });
  }
  
  if (!type || type === 'all' || type === 'villages') {
    const statesWithVillages = await State.find({
      'districts.talukas.villages.name': searchRegex
    }).select('name districts.name districts._id districts.talukas.name districts.talukas._id districts.talukas.villages.name districts.talukas.villages.code districts.talukas.villages._id');
    
    statesWithVillages.forEach(state => {
      state.districts.forEach(district => {
        district.talukas?.forEach(taluka => {
          const matchingVillages = taluka.villages?.filter(village => 
            village.name.match(searchRegex)
          ) || [];
          
          matchingVillages.forEach(village => {
            results.push({
              type: 'village',
              id: village._id,
              name: village.name,
              code: village.code,
              taluka: {
                id: taluka._id,
                name: taluka.name,
                code: taluka.code
              },
              district: {
                id: district._id,
                name: district.name,
                code: district.code
              },
              state: {
                id: state._id,
                name: state.name,
                code: state.code
              }
            });
          });
        });
      });
    });
  }
  
  // Limit results to prevent overwhelming response
  results = results.slice(0, 50);
  
  res.status(200).json({
    status: "success",
    data: {
      query,
      type: type || 'all',
      results,
      total: results.length
    }
  });
});

// Get complete location hierarchy by IDs
export const getLocationHierarchy = catchAsync(async (req, res, next) => {
  const { stateId, districtId, talukaId, villageId } = req.params;
  
  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }
  
  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }
  
  const taluka = district.talukas.id(talukaId);
  if (!taluka) {
    return next(new AppError("Taluka not found", 404));
  }
  
  const village = taluka.villages.id(villageId);
  if (!village) {
    return next(new AppError("Village not found", 404));
  }
  
  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
        code: state.code,
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code,
      },
      taluka: {
        id: taluka._id,
        name: taluka.name,
        code: taluka.code,
      },
      village: {
        id: village._id,
        name: village.name,
        code: village.code,
      },
    },
  });
}); 

// Get just states (optimized for frontend dropdown)
export const getStatesOnly = catchAsync(async (req, res, next) => {
  try {
    // Check cache first
    const cachedStates = locationCache.getStates();
    if (cachedStates) {
      return res.status(200).json({
        status: "success",
        data: cachedStates,
        cached: true
      });
    }
    
    // Only fetch states with basic info, no nested data
    const states = await State.find({})
      .select('name code')
      .sort({ name: 1 })
      .lean(); // Use lean() for better performance
    
    const formattedStates = states.map(state => ({
      id: state._id,
      name: state.name,
      code: state.code
    }));
    
    // Cache the result
    locationCache.setStates(formattedStates);
    
    res.status(200).json({
      status: "success",
      data: formattedStates,
      cached: false
    });
  } catch (error) {
    console.error("Error fetching states:", error);
    return next(new AppError("Failed to fetch states", 500));
  }
});

// Get all location data in a unified format (for admin/export purposes)
export const getAllLocationData = catchAsync(async (req, res, next) => {
  const { includeEmpty = false, format = 'nested' } = req.query;
  
  try {
    let query = {};
    
    // If includeEmpty is false, only get states with districts
    if (includeEmpty === 'false') {
      query = { 'districts.0': { $exists: true } };
    }
    
    const states = await State.find(query).select('name code districts.name districts.code districts.talukas.name districts.talukas.code districts.talukas.villages.name districts.talukas.villages.code');
    
    if (format === 'flat') {
      // Return flat structure
      const flatData = {
        states: states.map(state => ({
          id: state._id,
          name: state.name,
          code: state.code,
          districtsCount: state.districts?.length || 0
        })),
        districts: [],
        talukas: [],
        villages: []
      };
      
      states.forEach(state => {
        state.districts?.forEach(district => {
          flatData.districts.push({
            id: district._id,
            name: district.name,
            code: district.code,
            stateId: state._id,
            stateName: state.name,
            talukasCount: district.talukas?.length || 0
          });
          
          district.talukas?.forEach(taluka => {
            flatData.talukas.push({
              id: taluka._id,
              name: taluka.name,
              code: taluka.code,
              districtId: district._id,
              districtName: district.name,
              stateId: state._id,
              stateName: state.name,
              villagesCount: taluka.villages?.length || 0
            });
            
            taluka.villages?.forEach(village => {
              flatData.villages.push({
                id: village._id,
                name: village.name,
                code: village.code,
                talukaId: taluka._id,
                talukaName: taluka.name,
                districtId: district._id,
                districtName: district.name,
                stateId: state._id,
                stateName: state.name
              });
            });
          });
        });
      });
      
      return res.status(200).json({
        status: "success",
        data: flatData,
        summary: {
          totalStates: flatData.states.length,
          totalDistricts: flatData.districts.length,
          totalTalukas: flatData.talukas.length,
          totalVillages: flatData.villages.length
        }
      });
    } else {
      // Return nested structure (default)
      const nestedData = states.map(state => ({
        id: state._id,
        name: state.name,
        code: state.code,
        districtsCount: state.districts?.length || 0,
        districts: state.districts?.map(district => ({
          id: district._id,
          name: district.name,
          code: district.code,
          talukasCount: district.talukas?.length || 0,
          talukas: district.talukas?.map(taluka => ({
            id: taluka._id,
            name: taluka.name,
            code: taluka.code,
            villagesCount: taluka.villages?.length || 0,
            villages: taluka.villages?.map(village => ({
              id: village._id,
              name: village.name,
              code: village.code
            })) || []
          })) || []
        })) || []
      }));
      
      const summary = {
        totalStates: nestedData.length,
        totalDistricts: nestedData.reduce((sum, state) => sum + state.districtsCount, 0),
        totalTalukas: nestedData.reduce((sum, state) => 
          sum + state.districts.reduce((dSum, district) => dSum + district.talukasCount, 0), 0),
        totalVillages: nestedData.reduce((sum, state) => 
          sum + state.districts.reduce((dSum, district) => 
            dSum + district.talukas.reduce((tSum, taluka) => tSum + taluka.villagesCount, 0), 0), 0)
      };
      
      return res.status(200).json({
        status: "success",
        data: nestedData,
        summary
      });
    }
  } catch (error) {
    console.error("Error fetching location data:", error);
    return next(new AppError("Failed to fetch location data", 500));
  }
});

// Clear location cache (for admin use)
export const clearLocationCache = catchAsync(async (req, res, next) => {
  try {
    locationCache.clear();
    res.status(200).json({
      status: "success",
      message: "Location cache cleared successfully"
    });
  } catch (error) {
    console.error("Error clearing location cache:", error);
    return next(new AppError("Failed to clear location cache", 500));
  }
});

// Preload commonly used states into cache (for admin use)
export const preloadLocationCache = catchAsync(async (req, res, next) => {
  try {
    const commonStates = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Kerala', 'Andhra Pradesh', 'Telangana', 'Gujarat', 'Rajasthan', 'Madhya Pradesh', 'Uttar Pradesh'];
    
    const preloadedStates = [];
    
    for (const stateName of commonStates) {
      const state = await State.findOne({ name: stateName }).lean();
      if (state) {
        locationCache.setStateData(stateName, state);
        preloadedStates.push(stateName);
      }
    }
    
    res.status(200).json({
      status: "success",
      message: `Cache preloaded with ${preloadedStates.length} states`,
      preloadedStates
    });
  } catch (error) {
    console.error("Error preloading location cache:", error);
    return next(new AppError("Failed to preload location cache", 500));
  }
});

// Get location statistics
export const getLocationStats = catchAsync(async (req, res, next) => {
  try {
    const stats = await State.aggregate([
      {
        $project: {
          name: 1,
          code: 1,
          districtsCount: { $size: { $ifNull: ["$districts", []] } },
          totalTalukas: {
            $reduce: {
              input: { $ifNull: ["$districts", []] },
              initialValue: 0,
              in: { $add: ["$$value", { $size: { $ifNull: ["$$this.talukas", []] } }] }
            }
          },
          totalVillages: {
            $reduce: {
              input: { $ifNull: ["$districts", []] },
              initialValue: 0,
              in: {
                $add: [
                  "$$value",
                  {
                    $reduce: {
                      input: { $ifNull: ["$$this.talukas", []] },
                      initialValue: 0,
                      in: { $add: ["$$value", { $size: { $ifNull: ["$$this.villages", []] } }] }
                    }
                  }
                ]
              }
            }
          }
        }
      },
      {
        $sort: { name: 1 }
      }
    ]);
    
    const summary = {
      totalStates: stats.length,
      totalDistricts: stats.reduce((sum, state) => sum + state.districtsCount, 0),
      totalTalukas: stats.reduce((sum, state) => sum + state.totalTalukas, 0),
      totalVillages: stats.reduce((sum, state) => sum + state.totalVillages, 0),
      statesWithData: stats.filter(state => state.districtsCount > 0).length,
      statesWithoutData: stats.filter(state => state.districtsCount === 0).length
    };
    
    res.status(200).json({
      status: "success",
      data: {
        states: stats,
        summary
      }
    });
  } catch (error) {
    console.error("Error fetching location stats:", error);
    return next(new AppError("Failed to fetch location statistics", 500));
  }
}); 