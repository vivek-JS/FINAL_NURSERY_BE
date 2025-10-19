import { Schema, model } from "mongoose";

const pricingSchema = new Schema({
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms",
    required: true,
  },
  subtypeId: {
    type: Schema.Types.ObjectId,
    // Note: This references a subdocument within PlantCms, cannot use .populate()
    // Use aggregation or manual lookup instead
    required: true,
  },
  plantName: {
    type: String,
    required: true,
  },
  subtypeName: {
    type: String,
    required: true,
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  salePrice: {
    type: Number,
    required: true,
    min: 0,
  },
  overhead: {
    type: Number,
    default: 0,
    min: 0,
  },
  margin: {
    type: Number,
    default: function() {
      return ((this.salePrice - this.costPrice) / this.salePrice * 100);
    },
  },
  profitPerUnit: {
    type: Number,
    default: function() {
      return this.salePrice - this.costPrice - (this.overhead || 0);
    },
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
}, {
  timestamps: true,
});

// Indexes for better performance
pricingSchema.index({ plantId: 1, subtypeId: 1 }, { unique: true });
pricingSchema.index({ plantId: 1 });
pricingSchema.index({ subtypeId: 1 });
pricingSchema.index({ isActive: 1 });

// Pre-save middleware to calculate derived fields
pricingSchema.pre('save', function(next) {
  // Calculate margin percentage
  if (this.salePrice && this.costPrice) {
    this.margin = ((this.salePrice - this.costPrice) / this.salePrice * 100);
  }
  
  // Calculate profit per unit
  this.profitPerUnit = this.salePrice - this.costPrice - (this.overhead || 0);
  
  // Update timestamp
  this.lastUpdated = new Date();
  
  next();
});

// Static method to get pricing for a plant-subtype combination
pricingSchema.statics.findByPlantSubtype = function(plantId, subtypeId) {
  return this.findOne({ plantId, subtypeId, isActive: true });
};

// Static method to get all pricing for a plant
pricingSchema.statics.findByPlant = function(plantId) {
  return this.find({ plantId, isActive: true });
};

// Method to calculate total cost including overhead
pricingSchema.methods.getTotalCost = function() {
  return this.costPrice + (this.overhead || 0);
};

// Method to calculate profit margin
pricingSchema.methods.getProfitMargin = function() {
  return ((this.salePrice - this.getTotalCost()) / this.salePrice * 100);
};

const Pricing = model("Pricing", pricingSchema);

export default Pricing; 