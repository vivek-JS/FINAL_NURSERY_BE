import express from 'express';
import {
  createPlantProductMapping,
  getAllPlantProductMappings,
  getMappingsByPlantAndSubtype,
  getPlantProductMappingById,
  updatePlantProductMapping,
  deletePlantProductMapping,
} from '../controllers/plantProductMapping.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// CRUD routes
router.post('/', createPlantProductMapping);
router.get('/', getAllPlantProductMappings);
router.get('/plant/:plantId/subtype/:subtypeId', getMappingsByPlantAndSubtype);
router.get('/:id', getPlantProductMappingById);
router.put('/:id', updatePlantProductMapping);
router.delete('/:id', deletePlantProductMapping);

export default router;

