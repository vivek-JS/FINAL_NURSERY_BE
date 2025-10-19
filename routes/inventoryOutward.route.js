import express from 'express';
import * as inventoryOutwardController from '../controllers/inventoryOutward.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Inventory Outward routes
router.post('/', inventoryOutwardController.createOutward);
router.get('/', inventoryOutwardController.getAllOutwards);
router.get('/:id', inventoryOutwardController.getOutwardById);
router.put('/:id', inventoryOutwardController.updateOutward);
router.post('/:id/issue', inventoryOutwardController.issueOutward);
router.delete('/:id', inventoryOutwardController.deleteOutward);
router.get('/batches/:productId', inventoryOutwardController.getAvailableBatches);

export default router;

