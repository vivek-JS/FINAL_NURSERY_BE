import { Schema, model } from "mongoose";
import mongoose from 'mongoose';
import Batch from './batch.model.js';

// Lab Schema for outward entries
const labSchema = new Schema({
  outwardDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  size: {
    type: String,
    required: true,
    enum: ['R1', 'R2', 'R3']
  },
  bottles: {
    type: Number,
    required: true,
    min: 1
  }, 
  plants: {
    type: Number,
    required: true,
    min: 1
  },
  rootingDate: {
    type: Date,
    required: true
  }
});

// Primary Inward Schema
const primaryInwardSchema = new Schema({
  primaryInwardDate: {
    type: Date,
    required: true
  },
  primaryOutwardExpectedDate: {
    type: Date
  },
  numberOfBottles: {
    type: Number,
    required: true,
    min: 1
  },
  size: {
    type: String,
    required: true,
    enum: ['R1', 'R2', 'R3']
  },
  cavity: {
    type: Number,
    required: true,
    min: 1
  },
  numberOfTrays: {
    type: Number,
    required: true,
    min: 1
  },
  totalQuantity: {
    type: Number,
    required: true,
    min: 1
  },
  pollyhouse: {
    type: String,
    required: true
  },
  laboursEngaged: {
    type: Number,
    required: true,
    min: 1
  }
});

// Summary Schema updated with available plants
const summarySchema = new Schema({
  R1: {
    totalBottles: { 
      type: Number, 
      default: 0 
    },
    availableBottles: {
      type: Number,
      default: 0
    },
    totalPlants: { 
      type: Number, 
      default: 0 
    },
    availablePlants: {  // Added new field
      type: Number,
      default: 0
    },
    primaryInwardBottles: { 
      type: Number, 
      default: 0 
    },
    primaryInwardPlants: { 
      type: Number, 
      default: 0 
    }
  },
  R2: {
    totalBottles: { 
      type: Number, 
      default: 0 
    },
    availableBottles: {
      type: Number,
      default: 0
    },
    totalPlants: { 
      type: Number, 
      default: 0 
    },
    availablePlants: {  // Added new field
      type: Number,
      default: 0
    },
    primaryInwardBottles: { 
      type: Number, 
      default: 0 
    },
    primaryInwardPlants: { 
      type: Number, 
      default: 0 
    }
  },
  R3: {
    totalBottles: { 
      type: Number, 
      default: 0 
    },
    availableBottles: {
      type: Number,
      default: 0
    },
    totalPlants: { 
      type: Number, 
      default: 0 
    },
    availablePlants: {  // Added new field
      type: Number,
      default: 0
    },
    primaryInwardBottles: { 
      type: Number, 
      default: 0 
    },
    primaryInwardPlants: { 
      type: Number, 
      default: 0 
    }
  },
  total: {
    bottles: { 
      type: Number, 
      default: 0 
    },
    availableBottles: {
      type: Number,
      default: 0
    },
    plants: { 
      type: Number, 
      default: 0 
    },
    availablePlants: {  // Added new field
      type: Number,
      default: 0
    },
    primaryInwardBottles: { 
      type: Number, 
      default: 0 
    },
    primaryInwardPlants: { 
      type: Number, 
      default: 0 
    }
  }
}, { _id: false });

// Main Plant Outward Schema
const plantOutwardSchema = new Schema({
  batchId: {
    type: Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  },
  dateAdded: {
    type: Date,
    required: true,
    default: Date.now
  },
  primaryInward: [primaryInwardSchema],
  outward: [labSchema],
  summary: {
    type: summarySchema,
    default: () => ({
      R1: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      R2: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      R3: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      total: { bottles: 0, availableBottles: 0, plants: 0, availablePlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 }
    })
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Helper function to calculate outward summary
function calculateOutwardSummary(outwardArray) {
  return outwardArray.reduce((summary, lab) => {
    summary[lab.size].totalBottles += lab.bottles;
    summary[lab.size].availableBottles += lab.bottles;
    summary[lab.size].totalPlants += lab.plants;
    summary[lab.size].availablePlants += lab.plants;  // Initialize available plants
    
    summary.total.bottles += lab.bottles;
    summary.total.availableBottles += lab.bottles;
    summary.total.plants += lab.plants;
    summary.total.availablePlants += lab.plants;  // Initialize available plants
    
    return summary;
  }, {
    R1: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0 },
    R2: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0 },
    R3: { totalBottles: 0, availableBottles: 0, totalPlants: 0, availablePlants: 0 },
    total: { bottles: 0, availableBottles: 0, plants: 0, availablePlants: 0 }
  });
}

// Helper function to calculate primary inward summary
function calculatePrimaryInwardSummary(primaryInwardArray) {
  return primaryInwardArray.reduce((summary, item) => {
    const totalPlants = item.cavity * item.numberOfTrays;
    
    // Add to primary inward counts
    summary[item.size].primaryInwardBottles += item.numberOfBottles;
    summary[item.size].primaryInwardPlants += totalPlants;
    summary[item.size].availableBottles -= item.numberOfBottles;
    summary[item.size].availablePlants -= totalPlants;  // Decrease available plants
    
    // Update totals
    summary.total.primaryInwardBottles += item.numberOfBottles;
    summary.total.primaryInwardPlants += totalPlants;
    summary.total.availableBottles -= item.numberOfBottles;
    summary.total.availablePlants -= totalPlants;  // Decrease available plants
    
    return summary;
  }, {
    R1: { primaryInwardBottles: 0, primaryInwardPlants: 0, availableBottles: 0, availablePlants: 0 },
    R2: { primaryInwardBottles: 0, primaryInwardPlants: 0, availableBottles: 0, availablePlants: 0 },
    R3: { primaryInwardBottles: 0, primaryInwardPlants: 0, availableBottles: 0, availablePlants: 0 },
    total: { primaryInwardBottles: 0, primaryInwardPlants: 0, availableBottles: 0, availablePlants: 0 }
  });
}

// Helper function to combine summaries
function combineSummaries(outwardSummary, primaryInwardSummary) {
  const sizes = ['R1', 'R2', 'R3', 'total'];
  const combined = {};
  
  sizes.forEach(size => {
    const totalBottles = outwardSummary[size].totalBottles || 0;
    const totalPlants = outwardSummary[size].totalPlants || 0;
    const primaryInwardBottles = primaryInwardSummary[size].primaryInwardBottles || 0;
    const primaryInwardPlants = primaryInwardSummary[size].primaryInwardPlants || 0;
    
    const availableBottles = Math.max(0, totalBottles - primaryInwardBottles);
    const availablePlants = Math.max(0, totalPlants - primaryInwardPlants);
    
    combined[size] = {
      totalBottles: totalBottles,
      availableBottles: availableBottles,
      totalPlants: totalPlants,
      availablePlants: availablePlants,
      primaryInwardBottles: primaryInwardBottles,
      primaryInwardPlants: primaryInwardPlants
    };
  });
  
  return combined;
}

// Pre-save middleware
plantOutwardSchema.pre('save', function(next) {
  if (this.isModified('outward') || this.isModified('primaryInward')) {
    const outwardSummary = calculateOutwardSummary(this.outward || []);
    const primaryInwardSummary = calculatePrimaryInwardSummary(this.primaryInward || []);
    this.summary = combineSummaries(outwardSummary, primaryInwardSummary);
  }
  next();
});

// Pre-findOneAndUpdate middleware
plantOutwardSchema.pre('findOneAndUpdate', async function(next) {
  try {
    const update = this.getUpdate();
    const doc = await this.model.findOne(this.getQuery());
    
    if (!doc) return next();

    const batch = await Batch.findById(doc.batchId);
    if (!batch) {
      throw new Error('Associated batch not found');
    }

    let newOutward = [...(doc.outward || [])];
    let newPrimaryInward = [...(doc.primaryInward || [])];

    // Handle outward updates
    if (update.$push?.outward) {
      newOutward.push(update.$push.outward);
    } else if (update.$pull?.outward) {
      newOutward = newOutward.filter(item => !item._id.equals(update.$pull.outward._id));
    } else if (update.$set?.outward) {
      newOutward = update.$set.outward;
    }

    // Handle primaryInward updates with validation
    if (update.$push?.primaryInward) {
      const newInward = { ...update.$push.primaryInward };
      const size = newInward.size;
      const requiredPlants = newInward.cavity * newInward.numberOfTrays;
      
      // Calculate current available resources
      const outwardSummary = calculateOutwardSummary(newOutward);
      const currentPrimaryInwardSummary = calculatePrimaryInwardSummary(newPrimaryInward);
      const currentSummary = combineSummaries(outwardSummary, currentPrimaryInwardSummary);
      
      // Check if enough resources are available
      if (newInward.numberOfBottles > currentSummary[size].availableBottles) {
        throw new Error(`Not enough available bottles of size ${size}. Required: ${newInward.numberOfBottles}, Available: ${currentSummary[size].availableBottles}`);
      }
      
      if (requiredPlants > currentSummary[size].availablePlants) {
        throw new Error(`Not enough available plants of size ${size}. Required: ${requiredPlants}, Available: ${currentSummary[size].availablePlants}`);
      }

      // Set expected date
      const primaryInwardDate = new Date(newInward.primaryInwardDate);
      newInward.primaryOutwardExpectedDate = new Date(primaryInwardDate);
      newInward.primaryOutwardExpectedDate.setDate(
        primaryInwardDate.getDate() + batch.primaryPlantReadyDays
      );
      
      update.$push.primaryInward = newInward;
      newPrimaryInward.push(newInward);
    } else if (update.$pull?.primaryInward) {
      newPrimaryInward = newPrimaryInward.filter(item => !item._id.equals(update.$pull.primaryInward._id));
    } else if (update.$set?.primaryInward) {
      const updatedPrimaryInward = update.$set.primaryInward.map(inward => {
        const primaryInwardDate = new Date(inward.primaryInwardDate);
        const expectedDate = new Date(primaryInwardDate);
        expectedDate.setDate(primaryInwardDate.getDate() + batch.primaryPlantReadyDays);
        return {
          ...inward,
          primaryOutwardExpectedDate: expectedDate
        };
      });
      update.$set.primaryInward = updatedPrimaryInward;
      newPrimaryInward = updatedPrimaryInward;
    }

    // Calculate new summary
    const outwardSummary = calculateOutwardSummary(newOutward);
    const primaryInwardSummary = calculatePrimaryInwardSummary(newPrimaryInward);
    const newSummary = combineSummaries(outwardSummary, primaryInwardSummary);

    // Update the summary
    this.setUpdate({
      ...update,
      $set: {
        ...(update.$set || {}),
        summary: newSummary
      }
    });

    next();
  } catch (error) {
    next(error);
  }
});

// Static method for safe updates with transactions
plantOutwardSchema.statics.updateWithTransaction = async function(filter, update, options = {}) {
  const session = await this.db.startSession();
  session.startTransaction();

  try {
    const result = await this.findOneAndUpdate(
      filter,
      update,
      { 
        new: true,
        runValidators: true,
        session,
        ...options
      }
    );

    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Create the model
const PlantOutward = model("PlantOutward", plantOutwardSchema);

export default PlantOutward;