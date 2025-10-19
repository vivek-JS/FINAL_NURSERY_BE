import express from 'express';
import * as grnController from '../controllers/grn.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// GRN routes
router.post('/', grnController.createGRN);
router.get('/', grnController.getAllGRNs);
router.get('/:id', grnController.getGRNById);
router.put('/:id', grnController.updateGRN);
router.post('/:id/approve', grnController.approveGRN);
router.delete('/:id', grnController.deleteGRN);

export default router;

