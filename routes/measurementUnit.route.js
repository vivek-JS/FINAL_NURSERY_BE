import express from 'express';
import * as measurementUnitController from '../controllers/measurementUnit.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Measurement Unit routes
router.post('/', measurementUnitController.createMeasurementUnit);
router.get('/', measurementUnitController.getAllMeasurementUnits);
router.get('/:id', measurementUnitController.getMeasurementUnitById);
router.put('/:id', measurementUnitController.updateMeasurementUnit);
router.delete('/:id', measurementUnitController.deleteMeasurementUnit);

export default router;

