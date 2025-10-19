import express from 'express';
import * as purchaseOrderController from '../controllers/purchaseOrder.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Purchase Order routes
router.post('/', purchaseOrderController.createPurchaseOrder);
router.get('/', purchaseOrderController.getAllPurchaseOrders);
router.get('/:id', purchaseOrderController.getPurchaseOrderById);
router.put('/:id', purchaseOrderController.updatePurchaseOrder);
router.post('/:id/approve', purchaseOrderController.approvePurchaseOrder);
router.post('/:id/cancel', purchaseOrderController.cancelPurchaseOrder);
router.delete('/:id', purchaseOrderController.deletePurchaseOrder);

export default router;

