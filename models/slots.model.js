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
      "SOWING_PRIMARY", // Primary location sowing
      "SOWING_OFFICE", // Office location sowing
      "SOWING_EXCESSIVE", // Excessive sowing
      "EXCESSIVE_SOWING_ADDED",
      "STOCK_REQUEST_CREATED",
      "STOCK_REQUEST_ISSUED",
      "STOCK_REQUEST_CANCELLED",
      "GAP_COVERED", // Gap coverage from later slots
      "SOWING_IN_PROGRESS_CLEARED", // Clearing in-progress entries
      "PACKETS_RETURNED", // Packets returned after sowing
      "PACKETS_USED", // Packets marked as used
      "SOWING_READY_DATE_MAPPED", // Entry slot mapped to expected ready-date slot
    ],
    required: true,
  },
  activityName: {
    type: String,
    required: true, // Human-readable activity name
  },
  quantity: {
    type: Number,
    required: true,
  },
  // Plus values (what was added)
  plus: {
    primarySowed: { type: Number, default: 0 },
    officeSowed: { type: Number, default: 0 },
    totalPlants: { type: Number, default: 0 },
    availablePlants: { type: Number, default: 0 },
    excessivePlants: { type: Number, default: 0 }, // Excessive sowing plants
    packetsUsed: { type: Number, default: 0 },
    plantsSowed: { type: Number, default: 0 },
    gapCovered: { type: Number, default: 0 }, // Plants used to cover gaps
  },
  // Minus values (what was subtracted)
  minus: {
    packetsRemaining: { type: Number, default: 0 }, // Packets returned/subtracted
    inProgressEntries: { type: Number, default: 0 }, // Number of in-progress entries cleared
  },
  // Before state (snapshot of values before change)
  before: {
    primarySowed: { type: Number, default: 0 },
    officeSowed: { type: Number, default: 0 },
    totalPlants: { type: Number, default: 0 },
    availablePlants: { type: Number, default: 0 },
    excessivePlants: { type: Number, default: 0 },
    plantsSowed: { type: Number, default: 0 },
    totalBookedPlants: { type: Number, default: 0 },
    inProgressCount: { type: Number, default: 0 }, // Number of in-progress entries
  },
  // After state (snapshot of values after change)
  after: {
    primarySowed: { type: Number, default: 0 },
    officeSowed: { type: Number, default: 0 },
    totalPlants: { type: Number, default: 0 },
    availablePlants: { type: Number, default: 0 },
    excessivePlants: { type: Number, default: 0 },
    plantsSowed: { type: Number, default: 0 },
    totalBookedPlants: { type: Number, default: 0 },
    inProgressCount: { type: Number, default: 0 },
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
  // Sowing-specific fields
  sowingId: {
    type: Schema.Types.ObjectId,
    ref: "Sowing",
  },
  sowingLocation: {
    type: String,
    enum: ["PRIMARY", "OFFICE"],
  },
  batchNumber: {
    type: String,
  },
  sowingDate: {
    type: String, // DD-MM-YYYY format
  },
  plantReadyDate: {
    type: String, // DD-MM-YYYY format
  },
  isExcessiveSowing: {
    type: Boolean,
    default: false,
  },
  orderId: {
    type: Schema.Types.ObjectId,
    ref: "Order",
  },
  sowingRequestId: {
    type: Schema.Types.ObjectId,
    ref: "SowingRequest",
  },
  requestNumber: {
    type: String, // Sowing request number
  },
  // Gap coverage details
  gapCoverageDetails: {
    fromSlotId: { type: Schema.Types.ObjectId },
    fromSlotDate: { type: String },
    plantsCovered: { type: Number, default: 0 },
    toSlotId: { type: Schema.Types.ObjectId },
    toSlotDate: { type: String },
  },
  performedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  notes: {
    type: String,
  },
  // Additional metadata for debugging/recovery
  metadata: {
    type: Map,
    of: Schema.Types.Mixed,
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
  // Gap coverage tracking - when later slots cover previous gaps
  gapCovered: [{
    fromSlotId: {
      type: Schema.Types.ObjectId,
      required: true,
    }, // Which slot's sowing covered this gap
    fromSlotDate: {
      type: String,
      required: true,
    }, // Date of the slot that covered gap (DD-MM-YYYY)
    plantsCovered: {
      type: Number,
      required: true,
      default: 0,
    }, // How many plants covered from that slot
    coverageDate: {
      type: Date,
      default: Date.now,
    }, // When gap was covered
    sowingBatchNumber: {
      type: String,
    }, // Batch number reference from the sowing
    sowingId: {
      type: Schema.Types.ObjectId,
      ref: 'Sowing',
    }, // Reference to sowing record
  }],
  gapFullyCovered: {
    type: Boolean,
    default: false,
  }, // True if gap completely covered by later sowings
  // Product stock tracking - for products ordered from other nurseries
  productStock: [{
    productName: {
      type: String,
      required: true,
      trim: true,
    }, // Reference name like "Ghatude" (independent of actual product)
    available: {
      type: Number,
      default: 0,
    }, // Quantity received via GRN (ready to book)
    booked: {
      type: Number,
      default: 0,
    }, // Quantity booked via orders (taken from available/poQuantity)
    poQuantity: {
      type: Number,
      default: 0,
    }, // Quantity from PO (not yet received, but 99% will come)
    received: {
      type: Boolean,
      default: false,
    }, // True when GRN approved, false when only PO exists
    // Ready Plants Product fields
    dateRange: {
      startDate: {
        type: String, // DD-MM-YYYY format
        validate: {
          validator: function (value) {
            if (!value) return true; // Optional for backward compatibility
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
        validate: {
          validator: function (value) {
            if (!value) return true; // Optional for backward compatibility
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
      trim: true,
      // Display title for ready plants products (e.g., "Banana G9 - Premium Ready Plants")
    },
    productMappingId: {
      type: Schema.Types.ObjectId,
      ref: "PlantProductMapping",
      // Reference to PlantProductMapping
    },
  }],
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
        
        // Generate activity name from action
        const activityNameMap = {
          'ADD': 'Plants Added',
          'SUBTRACT': 'Plants Subtracted',
          'BUFFER_APPLIED': 'Buffer Applied',
          'BUFFER_RELEASED': 'Buffer Released',
          'ADD_WITH_BUFFER': 'Plants Added with Buffer',
          'ADD_WITH_BUFFER_RELEASE': 'Plants Added with Buffer Release',
          'SUBTRACT_WITH_BUFFER': 'Plants Subtracted with Buffer',
          'SUBTRACT_WITH_BUFFER_RELEASE': 'Plants Subtracted with Buffer Release',
          'UPDATE': 'Slot Updated'
        };

        const trailEntry = {
          action,
          activityName: activityNameMap[action] || action.replace(/_/g, ' '),
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
          bufferChange: bufferDifference,
          // Ensure plus/minus/before/after are properly initialized
          plus: {
            primarySowed: 0,
            officeSowed: 0,
            totalPlants: totalPlantsDifference > 0 ? totalPlantsDifference : 0,
            availablePlants: 0,
            excessivePlants: 0,
            packetsUsed: 0,
            plantsSowed: 0,
            gapCovered: 0,
          },
          minus: {
            packetsRemaining: 0,
            inProgressEntries: 0,
          },
          before: {
            primarySowed: this._original?.primarySowed || 0,
            officeSowed: this._original?.officeSowed || 0,
            totalPlants: previousTotalPlants,
            availablePlants: this._original?.availablePlants || 0,
            excessivePlants: this._original?.excessiveSowing?.plants || 0,
            plantsSowed: this._original?.plantsSowed || 0,
            totalBookedPlants: this._original?.totalBookedPlants || 0,
            inProgressCount: this._original?.sowingInProgress?.length || 0,
          },
          after: {
            primarySowed: this.primarySowed || 0,
            officeSowed: this.officeSowed || 0,
            totalPlants: currentTotalPlants,
            availablePlants: this.availablePlants || 0,
            excessivePlants: this.excessiveSowing?.plants || 0,
            plantsSowed: this.plantsSowed || 0,
            totalBookedPlants: this.totalBookedPlants || 0,
            inProgressCount: this.sowingInProgress?.length || 0,
          },
          metadata: {},
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
          
          // Generate activity name from action
          const activityNameMap = {
            'ADD': 'Plants Added',
            'SUBTRACT': 'Plants Subtracted',
            'BUFFER_APPLIED': 'Buffer Applied',
            'BUFFER_RELEASED': 'Buffer Released',
            'UPDATE': 'Slot Updated'
          };

          const trailEntry = {
            action,
            activityName: activityNameMap[action] || action.replace(/_/g, ' '),
            quantity,
            previousTotalPlants,
            newTotalPlants: currentTotalPlants,
            previousAvailablePlants: this._original?.availablePlants || 0,
            newAvailablePlants: this.availablePlants || 0,
            bufferPercentage: this.effectiveBuffer || this.buffer || 0,
            bufferAmount: this.bufferAmount || 0,
            reason: `Manual ${action.toLowerCase()} of plants`,
            performedBy: this._performedBy || null,
            notes: `Changed from ${previousTotalPlants} to ${currentTotalPlants} plants`,
            // Ensure plus/minus/before/after are properly initialized
            plus: {
              primarySowed: 0,
              officeSowed: 0,
              totalPlants: difference > 0 ? difference : 0,
              availablePlants: 0,
              excessivePlants: 0,
              packetsUsed: 0,
              plantsSowed: 0,
              gapCovered: 0,
            },
            minus: {
              packetsRemaining: 0,
              inProgressEntries: 0,
            },
            before: {
              primarySowed: this._original?.primarySowed || 0,
              officeSowed: this._original?.officeSowed || 0,
              totalPlants: previousTotalPlants,
              availablePlants: this._original?.availablePlants || 0,
              excessivePlants: this._original?.excessiveSowing?.plants || 0,
              plantsSowed: this._original?.plantsSowed || 0,
              totalBookedPlants: this._original?.totalBookedPlants || 0,
              inProgressCount: this._original?.sowingInProgress?.length || 0,
            },
            after: {
              primarySowed: this.primarySowed || 0,
              officeSowed: this.officeSowed || 0,
              totalPlants: currentTotalPlants,
              availablePlants: this.availablePlants || 0,
              excessivePlants: this.excessiveSowing?.plants || 0,
              plantsSowed: this.plantsSowed || 0,
              totalBookedPlants: this.totalBookedPlants || 0,
              inProgressCount: this.sowingInProgress?.length || 0,
            },
            metadata: {},
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
          
          // Generate activity name from action
          const activityNameMap = {
            'BUFFER_APPLIED': 'Buffer Applied',
            'BUFFER_RELEASED': 'Buffer Released'
          };

          const trailEntry = {
            action,
            activityName: activityNameMap[action] || action.replace(/_/g, ' '),
            quantity: bufferAmount,
            previousTotalPlants: currentTotalPlants,
            newTotalPlants: currentTotalPlants,
            previousAvailablePlants: this._original?.availablePlants || 0,
            newAvailablePlants: this.availablePlants || 0,
            bufferPercentage: currentBuffer,
            bufferAmount: Math.round((currentTotalPlants * currentBuffer) / 100),
            reason: `Buffer ${bufferDifference > 0 ? 'applied' : 'released'}`,
            performedBy: this._performedBy || null,
            notes: `Buffer changed from ${previousBuffer}% to ${currentBuffer}%`,
            // Ensure plus/minus/before/after are properly initialized
            plus: {
              primarySowed: 0,
              officeSowed: 0,
              totalPlants: 0,
              availablePlants: 0,
              excessivePlants: 0,
              packetsUsed: 0,
              plantsSowed: 0,
              gapCovered: 0,
            },
            minus: {
              packetsRemaining: 0,
              inProgressEntries: 0,
            },
            before: {
              primarySowed: this._original?.primarySowed || 0,
              officeSowed: this._original?.officeSowed || 0,
              totalPlants: currentTotalPlants,
              availablePlants: this._original?.availablePlants || 0,
              excessivePlants: this._original?.excessiveSowing?.plants || 0,
              plantsSowed: this._original?.plantsSowed || 0,
              totalBookedPlants: this._original?.totalBookedPlants || 0,
              inProgressCount: this._original?.sowingInProgress?.length || 0,
            },
            after: {
              primarySowed: this.primarySowed || 0,
              officeSowed: this.officeSowed || 0,
              totalPlants: currentTotalPlants,
              availablePlants: this.availablePlants || 0,
              excessivePlants: this.excessiveSowing?.plants || 0,
              plantsSowed: this.plantsSowed || 0,
              totalBookedPlants: this.totalBookedPlants || 0,
              inProgressCount: this.sowingInProgress?.length || 0,
            },
            metadata: {},
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
  const activityNameMap = {
    'ORDER_CANCELLED': 'Order Cancelled',
    'ORDER_RETURNED': 'Order Returned',
    'SUBTRACT': 'Order Booked'
  };

  const trailEntry = {
    action,
    activityName: activityNameMap[action] || action.replace(/_/g, ' '),
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
    notes: `Order ${action === 'SUBTRACT' ? 'booked' : 'cancelled/returned'} - ${quantity} plants`,
    // Ensure plus/minus/before/after are properly initialized
    plus: {
      primarySowed: 0,
      officeSowed: 0,
      totalPlants: 0,
      availablePlants: 0,
      excessivePlants: 0,
      packetsUsed: 0,
      plantsSowed: 0,
      gapCovered: 0,
    },
    minus: {
      packetsRemaining: 0,
      inProgressEntries: 0,
    },
    before: {
      primarySowed: this.primarySowed || 0,
      officeSowed: this.officeSowed || 0,
      totalPlants: this.totalPlants,
      availablePlants: this.availablePlants + (action === 'SUBTRACT' ? quantity : -quantity),
      excessivePlants: this.excessiveSowing?.plants || 0,
      plantsSowed: this.plantsSowed || 0,
      totalBookedPlants: this.totalBookedPlants || 0,
      inProgressCount: this.sowingInProgress?.length || 0,
    },
    after: {
      primarySowed: this.primarySowed || 0,
      officeSowed: this.officeSowed || 0,
      totalPlants: this.totalPlants,
      availablePlants: this.availablePlants,
      excessivePlants: this.excessiveSowing?.plants || 0,
      plantsSowed: this.plantsSowed || 0,
      totalBookedPlants: this.totalBookedPlants || 0,
      inProgressCount: this.sowingInProgress?.length || 0,
    },
    metadata: {},
  };
  
  this.slotTrail.unshift(trailEntry);
};

// Method to set performer for tracking
slotSchema.methods.setPerformer = function(userId) {
  this._performedBy = userId;
};

// Method to log comprehensive sowing activity
slotSchema.methods.logSowingActivity = function(activityData) {
  const {
    action,
    activityName,
    quantity = 0,
    plus = {},
    minus = {},
    before = {},
    after = {},
    sowingId,
    sowingLocation,
    batchNumber,
    sowingDate,
    plantReadyDate,
    isExcessiveSowing = false,
    orderId,
    sowingRequestId,
    requestNumber,
    gapCoverageDetails,
    performedBy,
    reason,
    notes,
    metadata = {},
  } = activityData;

  // Get current slot state for before/after comparison
  const currentBefore = {
    primarySowed: this.primarySowed || 0,
    officeSowed: this.officeSowed || 0,
    totalPlants: this.totalPlants || 0,
    availablePlants: this.availablePlants || 0,
    excessivePlants: this.excessiveSowing?.plants || 0,
    plantsSowed: this.plantsSowed || 0,
    totalBookedPlants: this.totalBookedPlants || 0,
    inProgressCount: this.sowingInProgress?.length || 0,
  };

  // Merge provided before/after with current state
  const finalBefore = { ...currentBefore, ...before };
  const finalAfter = { ...currentBefore, ...after };

  // Build comprehensive trail entry
  const trailEntry = {
    action,
    activityName: activityName || action, // Fallback to action if name not provided
    quantity,
    plus: {
      primarySowed: plus.primarySowed || 0,
      officeSowed: plus.officeSowed || 0,
      totalPlants: plus.totalPlants || 0,
      availablePlants: plus.availablePlants || 0,
      excessivePlants: plus.excessivePlants || 0,
      packetsUsed: plus.packetsUsed || 0,
      plantsSowed: plus.plantsSowed || 0,
      gapCovered: plus.gapCovered || 0,
    },
    minus: {
      packetsRemaining: minus.packetsRemaining || 0,
      inProgressEntries: minus.inProgressEntries || 0,
    },
    before: finalBefore,
    after: finalAfter,
    previousTotalPlants: finalBefore.totalPlants,
    newTotalPlants: finalAfter.totalPlants,
    previousAvailablePlants: finalBefore.availablePlants,
    newAvailablePlants: finalAfter.availablePlants,
    bufferPercentage: this.slotBuffer || 0,
    bufferAmount: this.bufferAmount || 0,
    reason: reason || `Sowing activity: ${activityName || action}`,
    sowingId,
    sowingLocation,
    batchNumber,
    sowingDate,
    plantReadyDate,
    isExcessiveSowing,
    orderId,
    sowingRequestId,
    requestNumber,
    gapCoverageDetails,
    performedBy: performedBy || this._performedBy || null,
    notes: notes || '',
    metadata: metadata || {},
  };

  // Initialize slotTrail if it doesn't exist
  if (!this.slotTrail) {
    this.slotTrail = [];
  }

  // Add to trail array (newest first for easy access)
  this.slotTrail.unshift(trailEntry);

  // Keep only last 1000 entries to prevent unbounded growth
  if (this.slotTrail.length > 1000) {
    this.slotTrail = this.slotTrail.slice(0, 1000);
  }

  return trailEntry;
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

// Compound indexes for optimized queries
plantSlotSchema.index({ plantId: 1, year: 1 }); // Compound index for getSlotsByPlantAndSubtype query
plantSlotSchema.index({ "subtypeSlots.subtypeId": 1 }); // Index for filtering by subtypeId
plantSlotSchema.index({ "subtypeSlots.slots._id": 1 }); // Index for finding slots by _id

const PlantSlot = model("PlantSlot", plantSlotSchema);

export default PlantSlot;
