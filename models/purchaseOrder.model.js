import mongoose from 'mongoose';

const purchaseOrderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: function() {
      // Product is only required if it's not a Ram Agri product
      return !this.isRamAgriProduct;
    },
  },
  quantity: {
    type: Number,
    required: true,
  },
  unit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MeasurementUnit',
    required: true,
  },
  rate: {
    type: Number,
    required: true,
  },
  gst: {
    type: Number,
    default: 0,
  },
  discount: {
    type: Number,
    default: 0,
  },
  amount: {
    type: Number,
    required: true,
  },
  receivedQuantity: {
    type: Number,
    default: 0,
  },
  batchNumber: {
    type: String,
    trim: true,
  },
  expiryDate: {
    type: Date,
  },
  slotId: {
    type: mongoose.Schema.Types.ObjectId,
    // Reference to slot for updating availablePlants when GRN is approved
  },
  productName: {
    type: String,
    trim: true,
    // Reference name for plant products (e.g., "Ghatude") - independent of actual product
  },
  // Ready Plants Product fields
  isReadyPlantsProduct: {
    type: Boolean,
    default: false,
  },
  plantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlantCms',
    // Plant ID for ready plants products
  },
  subtypeId: {
    type: mongoose.Schema.Types.ObjectId,
    // Subtype ID for ready plants products
  },
  dateRange: {
    startDate: {
      type: String, // DD-MM-YYYY format
      validate: {
        validator: function (value) {
          if (!value) return true; // Optional
          return /^\d{2}-\d{2}-\d{4}$/.test(value);
        },
        message: (props) =>
          `${props.value} is not a valid date in the format dd-mm-yyyy`,
      },
    },
    endDate: {
      type: String, // DD-MM-YYYY format
      validate: {
        validator: function (value) {
          if (!value) return true; // Optional
          return /^\d{2}-\d{2}-\d{4}$/.test(value);
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
  plantProductMappingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PlantProductMapping',
    // Reference to PlantProductMapping if created from PO
  },
  // Ram Agri Inputs Product fields
  isRamAgriProduct: {
    type: Boolean,
    default: false,
  },
  ramAgriCropId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RamAgriInputsProduct',
    // Reference to Ram Agri crop
  },
  ramAgriVarietyId: {
    type: mongoose.Schema.Types.ObjectId,
    // Reference to variety within the crop (subdocument ID)
  },
  ramAgriCropName: {
    type: String,
    trim: true,
    // Crop name for display
  },
  ramAgriVarietyName: {
    type: String,
    trim: true,
    // Variety name for display
  },
  selectedUnitType: {
    type: String,
    enum: ['primary', 'secondary'],
    // 'primary' or 'secondary' - indicates which unit was used for the order
  },
  conversionFactor: {
    type: Number,
    default: 1,
    // Conversion factor for converting secondary unit to primary unit
  },
  notes: String,
});

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },
    poDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expectedDeliveryDate: {
      type: Date,
    },
    items: [purchaseOrderItemSchema],
    subtotal: {
      type: Number,
      required: true,
    },
    gstAmount: {
      type: Number,
      default: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },
    otherCharges: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'partial_received', 'received', 'cancelled'],
      default: 'draft',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'paid'],
      default: 'pending',
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
    terms: {
      type: String,
    },
    notes: {
      type: String,
    },
    autoGRN: {
      type: Boolean,
      default: false,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedDate: {
      type: Date,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
purchaseOrderSchema.index({ poNumber: 1 });
purchaseOrderSchema.index({ supplier: 1 });
purchaseOrderSchema.index({ status: 1 });
purchaseOrderSchema.index({ poDate: -1 });

// Generate PO number
purchaseOrderSchema.statics.generatePONumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  const lastPO = await this.findOne({
    poNumber: new RegExp(`^PO${year}${month}`)
  }).sort({ poNumber: -1 });
  
  let sequence = 1;
  if (lastPO) {
    const lastSequence = parseInt(lastPO.poNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `PO${year}${month}${sequence.toString().padStart(4, '0')}`;
};

const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);

export default PurchaseOrder;

