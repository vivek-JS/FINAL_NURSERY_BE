import express from 'express';
import { check } from 'express-validator';
import * as sellOrderController from '../controllers/sellOrder.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import checkErrors from '../middlewares/checkErrors.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Sell Order routes
router.post(
  '/',
  [
    check('merchant').notEmpty().withMessage('Merchant is required'),
    check('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  ],
  checkErrors,
  sellOrderController.createSellOrder
);

router.get('/', sellOrderController.getAllSellOrders);
router.get('/all', sellOrderController.getAllSellOrders);
router.get('/pending-payments', sellOrderController.getPendingPayments);
router.get('/farmer-ledger', sellOrderController.getFarmerLedger);
router.get('/:id', sellOrderController.getSellOrderById);
router.put('/:id', sellOrderController.updateSellOrder);
router.post('/:id/payment', sellOrderController.addPayment);
router.post('/:id/approve', sellOrderController.approveSellOrder);
router.patch('/:id/payment/:paymentId/status', sellOrderController.updateSellOrderPaymentStatus);
router.delete('/:id', sellOrderController.deleteSellOrder);

export default router;

