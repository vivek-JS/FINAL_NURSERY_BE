import { Schema, model } from "mongoose";
import moment from "moment";

// Plant Product Mapping Schema
// Links products (from other nurseries) to plant types/subtypes with date ranges
const plantProductMappingSchema = new Schema({
  productId: {
    type: Schema.Types.ObjectId,
    ref: "Product", // Reference to Product model (from product.model.js)
    required: true,
    index: true,
  },
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms", // Reference to PlantCms model
    required: true,
    index: true,
  },
  subtypeId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  dateRange: {
    startDate: {
      type: String, // DD-MM-YYYY format
      required: true,
      validate: {
        validator: function (value) {
          return (
            /^\d{2}-\d{2}-\d{4}$/.test(value) &&
            moment(value, "DD-MM-YYYY", true).isValid()
          );
        },
        message: (props) =>
          `${props.value} is not a valid date in the format dd-mm-yyyy`,
      },
    },
    endDate: {
      type: String, // DD-MM-YYYY format
      required: true,
      validate: {
        validator: function (value) {
          return (
            /^\d{2}-\d{2}-\d{4}$/.test(value) &&
            moment(value, "DD-MM-YYYY", true).isValid()
          );
        },
        message: (props) =>
          `${props.value} is not a valid date in the format dd-mm-yyyy`,
      },
    },
  },
  displayTitle: {
    type: String,
    required: true,
    trim: true,
    // e.g., "Banana G9 - Premium Ready Plants"
  },
  totalQuantity: {
    type: Number,
    default: 0,
    min: 0,
    // Total stock quantity available for this mapping (from other nursery)
  },
  allocatedQuantity: {
    type: Number,
    default: 0,
    min: 0,
    // Quantity allocated to specific slots (sum of all slot allocations)
  },
  slotReferences: [{
    slotId: {
      type: Schema.Types.ObjectId,
      ref: "PlantSlot",
      required: true,
    },
    bookedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Track which slots have orders for this mapping and how much is booked in each
  }],
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

// Validate that endDate is after startDate
plantProductMappingSchema.pre('save', function(next) {
  if (this.dateRange && this.dateRange.startDate && this.dateRange.endDate) {
    const start = moment(this.dateRange.startDate, "DD-MM-YYYY");
    const end = moment(this.dateRange.endDate, "DD-MM-YYYY");
    
    if (!end.isAfter(start) && !end.isSame(start, 'day')) {
      return next(new Error('End date must be after or equal to start date'));
    }
  }
  next();
});

// Compound indexes for optimized queries
plantProductMappingSchema.index({ plantId: 1, subtypeId: 1 });
plantProductMappingSchema.index({ productId: 1, isActive: 1 });
plantProductMappingSchema.index({ "dateRange.startDate": 1, "dateRange.endDate": 1 });

// Method to check if a date is within the date range
plantProductMappingSchema.methods.isDateInRange = function(date) {
  if (!date || !this.dateRange) return false;
  
  const checkDate = moment(date);
  const start = moment(this.dateRange.startDate, "DD-MM-YYYY");
  const end = moment(this.dateRange.endDate, "DD-MM-YYYY");
  
  return checkDate.isSameOrAfter(start, "day") && checkDate.isSameOrBefore(end, "day");
};

// Static method to find active mappings for plant/subtype with date filter
plantProductMappingSchema.statics.findActiveByPlantAndSubtype = function(plantId, subtypeId, checkDate = null) {
  const query = {
    plantId,
    subtypeId,
    isActive: true,
  };
  
  // If checkDate is provided, filter by date range
  if (checkDate) {
    const dateStr = moment(checkDate).format("DD-MM-YYYY");
    query["dateRange.startDate"] = { $lte: dateStr };
    query["dateRange.endDate"] = { $gte: dateStr };
  }
  
  return this.find(query).populate('productId').sort({ createdAt: -1 });
};

// Method to recalculate allocatedQuantity from slotReferences (for dynamic calculation)
plantProductMappingSchema.methods.recalculateAllocatedQuantity = function() {
  if (this.slotReferences && Array.isArray(this.slotReferences)) {
    this.allocatedQuantity = this.slotReferences.reduce((total, ref) => {
      return total + (ref.bookedQuantity || 0);
    }, 0);
  } else {
    this.allocatedQuantity = 0;
  }
  return this.allocatedQuantity;
};

const PlantProductMapping = model("PlantProductMapping", plantProductMappingSchema);

export default PlantProductMapping;

