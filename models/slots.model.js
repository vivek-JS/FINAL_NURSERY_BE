import { Schema, model } from "mongoose";
import moment from "moment"; // Optional: Use moment.js or other libraries for date validation/formatting

// Define a schema for slot trail tracking
const slotTrailSchema = new Schema({
  action: {
    type: String,
    enum: [
      "ADD", 
      "SUBTRACT", 
      "BUFFER_APPLIED", 
      "BUFFER_RELEASED", 
      "ORDER_CANCELLED", 
      "ORDER_RETURNED",
      "ADD_WITH_BUFFER",
      "ADD_WITH_BUFFER_RELEASE",
      "SUBTRACT_WITH_BUFFER",
      "SUBTRACT_WITH_BUFFER_RELEASE",
      "UPDATE",
      "SOWING_STARTED",
      "STOCK_REQUEST_ISSUED",
      "SOWING_COMPLETED",
      "SOWING_CANCELLED",
      "SOWING_COMPLETED",
      "EXCESSIVE_SOWING_ADDED",
      "STOCK_REQUEST_CREATED",
      "STOCK_REQUEST_ISSUED",
      "STOCK_REQUEST_CANCELLED"
    ],
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
  },
  previousTotalPlants: {
    type: Number,
    required: true,
  },
  newTotalPlants: {
    type: Number,
    required: true,
  },
  previousAvailablePlants: {
    type: Number,
    required: true,
  },
  newAvailablePlants: {
    type: Number,
    required: true,
  },
  bufferPercentage: {
    type: Number,
    default: 0,
  },
  bufferAmount: {
    type: Number,
    default: 0,
  },
  reason: {
    type: String,
    required: true,
  },
  orderId: {
    type: Schema.Types.ObjectId,
    ref: "Order",
  },
  sowingRequestId: {
    type: Schema.Types.ObjectId,
    ref: "SowingRequest",
  },
  performedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  notes: {
    type: String,
  },
}, { timestamps: true });

// Define the schema for slots
const slotSchema = new Schema({
  startDay: {
    type: String, // Store date in "dd-mm-yyyy" format
    required: true,
    validate: {
      validator: function (value) {
        // Regular expression to validate "dd-mm-yyyy" format
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  endDay: {
    type: String, // Store date in "dd-mm-yyyy" format
    required: true,
    validate: {
      validator: function (value) {
        // Regular expression to validate "dd-mm-yyyy" format
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  totalPlants: {
    type: Number,
    default: 0,
  },
  // Note: totalBookedPlants is now calculated dynamically from orders
  // This field is kept for backward compatibility but should not be used
  totalBookedPlants: {
    type: Number,
    default: 0,
  },
  // Buffer-adjusted available plants (stored in database)
  availablePlants: {
    type: Number,
    default: function() {
      return this.totalPlants;
    }
  },
  buffer: {
    type: Number,
    default: 0,
  }, // Buffer at slot level
  // Buffer-adjusted fields for cascading buffer system
  effectiveBuffer: {
    type: Number,
    default: 0,
  }, // Effective buffer percentage after cascading
  bufferAdjustedCapacity: {
    type: Number,
    default: 0,
  }, // Total capacity after buffer deduction
  bufferAmount: {
    type: Number,
    default: 0,
  }, // Actual number of plants reserved as buffer
  originalTotalPlants: {
    type: Number,
    default: 0,
  }, // Original total plants before buffer adjustment
  // Flag to indicate if this slot is in overflow state
  isOverflow: {
    type: Boolean,
    default: false,
  },
  orders: {
    type: [Schema.Types.ObjectId], // Array of references to an Order model
    default: [],
  },
  // Array to store salesman IDs who can access this slot (empty = all can access)
  allowedSalesmen: {
    type: [Schema.Types.ObjectId],
    ref: "User", // Reference to User model
    default: [],
  },
  // Flag to enable/disable salesman restrictions
  restrictToSalesmen: {
    type: Boolean,
    default: false,
  },
  overflow: {
    type: Boolean,
    default: false,
  },
  status: {
    type: Boolean,
    default: false,
  },
  month: {
    type: String, // Field to store the name of the month
    required: true,
    enum: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ], // Restricting values to valid month names
  },
  isManual: {
    type: Boolean,
    default: false,
  },
  plantReadyDays: {
    type: Number,
    default: 0,
    min: 0,
  }, // Days required for plants in this slot to be ready
  // Sowing management fields
  plantsSowed: {
    type: Number,
    default: 0,
  }, // Total number of plants sowed (office + primary)
  officeSowed: {
    type: Number,
    default: 0,
  }, // Number of plants sowed at office location
  primarySowed: {
    type: Number,
    default: 0,
  }, // Number of plants sowed at primary location
  sowingDate: {
    type: String, // Store date in "dd-mm-yyyy" format
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow empty value
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  }, // Date when plants were sowed
  plantReadyDate: {
    type: String, // Store date in "dd-mm-yyyy" format (calculated from sowingDate + plantReadyDays)
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow empty value
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  }, // Date when plants will be ready
  reminderBeforePlantReadyDays: {
    type: Number,
    default: 0,
  }, // Days before plant ready date to send reminder
  // Excessive sowing tracking
  excessiveSowing: {
    packets: {
      type: Number,
      default: 0,
    }, // Excessive packets sowed (packets beyond orders)
    plants: {
      type: Number,
      default: 0,
    }, // Excessive plants sowed (plants beyond orders)
  },
  // Sowing completion tracking
  sowingCompleted: {
    type: Boolean,
    default: false,
  }, // Flag to indicate if sowing is completed for this slot
  sowingCompletedDate: {
    type: String, // Store date in "dd-mm-yyyy" format
    validate: {
      validator: function (value) {
        if (!value) return true; // Allow empty value
        return (
          /^\d{2}-\d{2}-\d{4}$/.test(value) &&
          moment(value, "DD-MM-YYYY", true).isValid()
        );
      },
      message: (props) =>
        `${props.value} is not a valid date in the format dd-mm-yyyy`,
    },
  },
  sowingInProgress: [{
    requestNumber: {
      type: String,
    },
    packetsIssued: {
      type: Number,
      default: 0,
    },
    plantsExpected: {
      type: Number,
      default: 0,
    },
    outwardId: {
      type: Schema.Types.ObjectId,
      ref: 'InventoryOutward',
    },
    sowingRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'SowingRequest',
    },
    isExcessiveSowing: {
      type: Boolean,
      default: false,
    },
    issuedDate: {
      type: Date,
    },
  }], // Array to track multiple sowing requests in progress for this slot
  linkedSowingRequests: [{
    type: Schema.Types.ObjectId,
    ref: 'SowingRequest',
  }], // Track all sowing requests linked to this slot
  // Slot trail tracking
  slotTrail: [slotTrailSchema],
});

// Virtual field to calculate totalBookedPlants from orders
slotSchema.virtual('calculatedTotalBookedPlants').get(function() {
  // This will be populated when we fetch the slot with orders
  return 0; // Default value, will be calculated when populated
});

// Pre-save middleware to track slot changes
slotSchema.pre('save', function(next) {
  // Only track changes if this is an update (not a new document)
  if (!this.isNew) {
    const modifiedPaths = this.modifiedPaths();
    
    // Check if both totalPlants and buffer are being modified together
    const hasTotalPlantsChange = modifiedPaths.includes('totalPlants');
    const hasBufferChange = modifiedPaths.includes('buffer') || modifiedPaths.includes('effectiveBuffer');
    
    // Get current values
    const currentTotalPlants = this.totalPlants || 0;
    const currentBuffer = this.buffer || 0;
    
    // Try to get previous values from different sources
    const previousTotalPlants = this._original?.totalPlants || 0;
    const previousBuffer = this._original?.buffer || 0;
    
    // If both are changing, create a combined entry
    if (hasTotalPlantsChange && hasBufferChange) {
      const totalPlantsDifference = currentTotalPlants - previousTotalPlants;
      const bufferDifference = currentBuffer - previousBuffer;
      
      if (totalPlantsDifference !== 0 || bufferDifference !== 0) {
        let action = 'UPDATE';
        let reason = 'Slot updated';
        let notes = '';
        
        if (totalPlantsDifference > 0 && bufferDifference > 0) {
          action = 'ADD_WITH_BUFFER';
          reason = 'Plants added with buffer applied';
          notes = `Added ${totalPlantsDifference} plants and applied ${bufferDifference}% buffer`;
        } else if (totalPlantsDifference > 0 && bufferDifference < 0) {
          action = 'ADD_WITH_BUFFER_RELEASE';
          reason = 'Plants added with buffer released';
          notes = `Added ${totalPlantsDifference} plants and released ${Math.abs(bufferDifference)}% buffer`;
        } else if (totalPlantsDifference < 0 && bufferDifference > 0) {
          action = 'SUBTRACT_WITH_BUFFER';
          reason = 'Plants subtracted with buffer applied';
          notes = `Subtracted ${Math.abs(totalPlantsDifference)} plants and applied ${bufferDifference}% buffer`;
        } else if (totalPlantsDifference < 0 && bufferDifference < 0) {
          action = 'SUBTRACT_WITH_BUFFER_RELEASE';
          reason = 'Plants subtracted with buffer released';
          notes = `Subtracted ${Math.abs(totalPlantsDifference)} plants and released ${Math.abs(bufferDifference)}% buffer`;
        } else if (totalPlantsDifference !== 0) {
          action = totalPlantsDifference > 0 ? 'ADD' : 'SUBTRACT';
          reason = `Manual ${action.toLowerCase()} of plants`;
          notes = `Changed from ${previousTotalPlants} to ${currentTotalPlants} plants`;
        } else if (bufferDifference !== 0) {
          action = bufferDifference > 0 ? 'BUFFER_APPLIED' : 'BUFFER_RELEASED';
          reason = `Buffer ${bufferDifference > 0 ? 'applied' : 'released'}`;
          notes = `Buffer changed from ${previousBuffer}% to ${currentBuffer}%`;
        }
        
        const trailEntry = {
          action,
          quantity: Math.abs(totalPlantsDifference) || Math.abs(bufferDifference),
          previousTotalPlants,
          newTotalPlants: currentTotalPlants,
          previousAvailablePlants: this._original?.availablePlants || 0,
          newAvailablePlants: this.availablePlants || 0,
          bufferPercentage: currentBuffer,
          bufferAmount: Math.round((currentTotalPlants * currentBuffer) / 100),
          reason,
          performedBy: this._performedBy || null,
          notes,
          totalPlantsChange: totalPlantsDifference,
          bufferChange: bufferDifference
        };
        
        // Initialize slotTrail if it doesn't exist
        if (!this.slotTrail) {
          this.slotTrail = [];
        }
        
        // Add to trail array (newest first)
        this.slotTrail.unshift(trailEntry);
      }
    } else {
      // Handle individual changes
      if (hasTotalPlantsChange) {
        const difference = currentTotalPlants - previousTotalPlants;
        
        if (difference !== 0) {
          const action = difference > 0 ? 'ADD' : 'SUBTRACT';
          const quantity = Math.abs(difference);
          
          const trailEntry = {
            action,
            quantity,
            previousTotalPlants,
            newTotalPlants: currentTotalPlants,
            previousAvailablePlants: this._original?.availablePlants || 0,
            newAvailablePlants: this.availablePlants || 0,
            bufferPercentage: this.effectiveBuffer || this.buffer || 0,
            bufferAmount: this.bufferAmount || 0,
            reason: `Manual ${action.toLowerCase()} of plants`,
            performedBy: this._performedBy || null,
            notes: `Changed from ${previousTotalPlants} to ${currentTotalPlants} plants`
          };
          
          if (!this.slotTrail) {
            this.slotTrail = [];
          }
          
          this.slotTrail.unshift(trailEntry);
        }
      }
      
      if (hasBufferChange) {
        const bufferDifference = currentBuffer - previousBuffer;
        
        if (bufferDifference !== 0) {
          const action = bufferDifference > 0 ? 'BUFFER_APPLIED' : 'BUFFER_RELEASED';
          const bufferAmount = Math.abs(bufferDifference);
          
          const trailEntry = {
            action,
            quantity: bufferAmount,
            previousTotalPlants: currentTotalPlants,
            newTotalPlants: currentTotalPlants,
            previousAvailablePlants: this._original?.availablePlants || 0,
            newAvailablePlants: this.availablePlants || 0,
            bufferPercentage: currentBuffer,
            bufferAmount: Math.round((currentTotalPlants * currentBuffer) / 100),
            reason: `Buffer ${bufferDifference > 0 ? 'applied' : 'released'}`,
            performedBy: this._performedBy || null,
            notes: `Buffer changed from ${previousBuffer}% to ${currentBuffer}%`
          };
          
          if (!this.slotTrail) {
            this.slotTrail = [];
          }
          
          this.slotTrail.unshift(trailEntry);
        }
      }
    }
  }
  
  next();
});

// Method to track order-related changes
slotSchema.methods.trackOrderChange = function(action, orderId, quantity, performedBy, reason) {
  const trailEntry = {
    action,
    quantity,
    previousTotalPlants: this.totalPlants,
    newTotalPlants: this.totalPlants,
    previousAvailablePlants: this.availablePlants + (action === 'SUBTRACT' ? quantity : -quantity),
    newAvailablePlants: this.availablePlants,
    bufferPercentage: this.effectiveBuffer || this.buffer || 0,
    bufferAmount: this.bufferAmount || 0,
    reason,
    orderId,
    performedBy,
    notes: `Order ${action === 'SUBTRACT' ? 'booked' : 'cancelled/returned'} - ${quantity} plants`
  };
  
  this.slotTrail.unshift(trailEntry);
};

// Method to set performer for tracking
slotSchema.methods.setPerformer = function(userId) {
  this._performedBy = userId;
};

// Ensure virtual fields are included when converting to JSON
slotSchema.set('toJSON', { virtuals: true });
slotSchema.set('toObject', { virtuals: true });

const subtypeSlotSchema = new Schema({
  subtypeId: {
    type: Schema.Types.ObjectId,
    // Note: This references a subdocument within PlantCms, cannot use .populate()
    // Use aggregation or manual lookup instead
    required: true,
  },
  slots: {
    type: [slotSchema], // Array of slot schemas
    default: [],
  },
});

const plantSlotSchema = new Schema({
  plantId: {
    type: Schema.Types.ObjectId,
    ref: "PlantCms", // Reference to the main plant in the PlantCms model
    required: true,
    index: true,
  },
  year: {
    type: Number, // Field to store the year
    required: true,
    index: true,
  },
  subtypeSlots: {
    type: [subtypeSlotSchema], // Array of subtype slot schemas
    default: [],
    index: true,
  },
});

const PlantSlot = model("PlantSlot", plantSlotSchema);

export default PlantSlot;
