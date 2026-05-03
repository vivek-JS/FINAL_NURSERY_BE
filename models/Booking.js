import mongoose from "mongoose";

/**
 * Standalone bookings collection for reporting (e.g. WATI today booking PDF).
 * Adjust fields to match your real ingestion pipeline if you sync from orders elsewhere.
 */
const bookingSchema = new mongoose.Schema(
  {
    /** Farmer / customer name for booking reports (optional on legacy rows). */
    farmerName: {
      type: String,
      trim: true,
      default: "",
    },
    plantName: {
      type: String,
      required: true,
      trim: true,
    },
    /** Optional label e.g. tissue / graft — shown in PDF when set. */
    plantType: {
      type: String,
      trim: true,
      default: "",
    },
    subtype: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    collection: "bookings",
    timestamps: true,
  }
);

bookingSchema.index({ createdAt: 1 });
bookingSchema.index({ plantName: 1, subtype: 1, createdAt: 1 });

const Booking = mongoose.models.Booking || mongoose.model("Booking", bookingSchema);

export default Booking;
