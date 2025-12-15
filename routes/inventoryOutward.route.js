import express from 'express';
import * as inventoryOutwardController from '../controllers/inventoryOutward.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Inventory Outward routes
// IMPORTANT: Specific routes must come BEFORE parameterized routes (/:id)
router.post('/', inventoryOutwardController.createOutward);
router.get('/', inventoryOutwardController.getAllOutwards);
router.get('/batches/:productId', inventoryOutwardController.getAvailableBatches);
router.get('/packets-for-sowing', inventoryOutwardController.getAllAvailablePacketsForSowing); // Must come before /:id
router.get('/packets-for-sowing/:productId', inventoryOutwardController.getAvailablePacketsForSowing);
router.post('/:id/issue', inventoryOutwardController.issueOutward);
// Parameterized routes come last
router.get('/:id', inventoryOutwardController.getOutwardById);
router.put('/:id', inventoryOutwardController.updateOutward);
router.delete('/:id', inventoryOutwardController.deleteOutward);

export default router;

