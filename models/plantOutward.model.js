import { Schema, model } from "mongoose";

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

// Summary Schema
const summarySchema = new Schema({
  R1: {
    totalBottles: { 
      type: Number, 
      default: 0 
    },
    totalPlants: { 
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
    totalPlants: { 
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
    totalPlants: { 
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
    plants: { 
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
      R1: { totalBottles: 0, totalPlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      R2: { totalBottles: 0, totalPlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      R3: { totalBottles: 0, totalPlants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 },
      total: { bottles: 0, plants: 0, primaryInwardBottles: 0, primaryInwardPlants: 0 }
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
    summary[lab.size].totalPlants += lab.plants;
    summary.total.bottles += lab.bottles;
    summary.total.plants += lab.plants;
    return summary;
  }, {
    R1: { totalBottles: 0, totalPlants: 0 },
    R2: { totalBottles: 0, totalPlants: 0 },
    R3: { totalBottles: 0, totalPlants: 0 },
    total: { bottles: 0, plants: 0 }
  });
}

// Helper function to calculate primary inward summary
function calculatePrimaryInwardSummary(primaryInwardArray) {
  return primaryInwardArray.reduce((summary, item) => {
    const totalPlants = item.cavity * item.numberOfTrays;
    summary[item.size].primaryInwardBottles += item.numberOfBottles;
    summary[item.size].primaryInwardPlants += totalPlants;
    summary.total.primaryInwardBottles += item.numberOfBottles;
    summary.total.primaryInwardPlants += totalPlants;
    return summary;
  }, {
    R1: { primaryInwardBottles: 0, primaryInwardPlants: 0 },
    R2: { primaryInwardBottles: 0, primaryInwardPlants: 0 },
    R3: { primaryInwardBottles: 0, primaryInwardPlants: 0 },
    total: { primaryInwardBottles: 0, primaryInwardPlants: 0 }
  });
}

// Helper function to combine summaries
function combineSummaries(outwardSummary, primaryInwardSummary) {
  const sizes = ['R1', 'R2', 'R3', 'total'];
  const combined = {};
  
  sizes.forEach(size => {
    combined[size] = {
      totalBottles: outwardSummary[size].totalBottles || 0,
      totalPlants: outwardSummary[size].totalPlants || 0,
      primaryInwardBottles: primaryInwardSummary[size].primaryInwardBottles || 0,
      primaryInwardPlants: primaryInwardSummary[size].primaryInwardPlants || 0
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
  const update = this.getUpdate();
  const doc = await this.model.findOne(this.getQuery());
  
  if (!doc) return next();

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

  // Handle primaryInward updates
  if (update.$push?.primaryInward) {
    newPrimaryInward.push(update.$push.primaryInward);
  } else if (update.$set?.['primaryInward.$']) {
    const primaryInwardId = this.getQuery()['primaryInward._id'];
    const index = newPrimaryInward.findIndex(item => item._id.equals(primaryInwardId));
    if (index !== -1) {
      newPrimaryInward[index] = update.$set['primaryInward.$'];
    }
  } else if (update.$set?.primaryInward) {
    newPrimaryInward = update.$set.primaryInward;
  }

  // Calculate new summary
  const outwardSummary = calculateOutwardSummary(newOutward);
  const primaryInwardSummary = calculatePrimaryInwardSummary(newPrimaryInward);
  const newSummary = combineSummaries(outwardSummary, primaryInwardSummary);

  // Set the new summary in the update operation
  this.setUpdate({
    ...update,
    $set: {
      ...(update.$set || {}),
      summary: newSummary
    }
  });

  next();
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