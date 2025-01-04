import express from "express";
import { 
  createDealerOrder, 
  getDealerOrdersByBooking,
  updateDealerOrderPayment 
} from "../controllers/dealer.controller.js";

const router = express.Router();

// Create new dealer order
router.post("/orders",createDealerOrder);

// Get all orders for authenticated dealer
router.get("/orders", getDealerOrdersByBooking);

// Update order payment
router.post("/orders/:orderId/payment", updateDealerOrderPayment);

export default router;

/* Usage in main app.js or index.js:
import dealerRoutes from './routes/dealer.routes.js';
app.use('/api/dealer', dealerRoutes);

This will create the following endpoints:
POST /api/dealer/orders - Create new order
GET /api/dealer/orders - Get all orders
POST /api/dealer/orders/:orderId/payment - Add payment to order
*/