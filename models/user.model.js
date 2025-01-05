import { Schema, model } from "mongoose";
import DealerBooking from "./dealerBooking.model.js";
const userSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: Number,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
    default: "12345678",
  },
  jobTitle: {
    type: String,
    enum: ["Manager", "HR", "SALES", "PRIMARY", "OFFICE_STAFF", 'DRIVER', 'LABORATORY_MANAGER', 'DEALER','OFFICE_ADMIN'],
  },
  isDisabled: {
    type: Boolean,
    default: false,
  },
  defaultState: {
    type: String,
  },
  defaultDistrict: {
    type: String,
  },
  defaultTaluka: {
    type: String,
  },
  defaultVillage: {
    type: String,
  },
  isOnboarded: {
    type: Boolean,
    default: false,
  },
  birthDate: {
    type: Date,
  },
});

// Middleware to handle DealerBooking creation for new dealers
userSchema.post('save', async function(doc) {
  try {
    // Only proceed if the user is a DEALER
    if (doc.jobTitle === 'DEALER') {
      const DealerBooking = model('DealerBooking');
      
      // Check if a DealerBooking already exists for this dealer
      const existingBooking = await DealerBooking.findOne({ dealer: doc._id });
      
      if (!existingBooking) {
        // Create new DealerBooking record
        await DealerBooking.create({
          dealer: doc._id,
          orders: [],
          farmerOrders: [],
          summary: {
            totalAvailable: 0,
            totalBooked: 0,
            totalBalance: 0,
            paymentRemaining: 0,
            totalOrderPayments: 0
          }
        });
      }
    }
  } catch (error) {
    console.error('Error creating DealerBooking:', error);
    // Don't throw error to prevent disrupting the user creation
  }
});

// Middleware to handle DealerBooking creation when user is updated to DEALER
userSchema.pre('findOneAndUpdate', async function() {
  const update = this.getUpdate();
  if (update?.jobTitle === 'DEALER') {
    const DealerBooking = model('DealerBooking');
    
    // Get the user ID from the query
    const userId = this.getQuery()._id;
    
    // Check if a DealerBooking already exists
    const existingBooking = await DealerBooking.findOne({ dealer: userId });
    
    if (!existingBooking) {
      // Create new DealerBooking record
      await DealerBooking.create({
        dealer: userId,
        orders: [],
        farmerOrders: [],
        summary: {
          totalAvailable: 0,
          totalBooked: 0,
          totalBalance: 0,
          paymentRemaining: 0,
          totalOrderPayments: 0
        }
      });
    }
  }
});

const User = model("User", userSchema);

export default User;