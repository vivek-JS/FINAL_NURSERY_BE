import express from 'express';
import { 
  healthCheck, 
  detailedHealthCheck, 
  readinessCheck, 
  livenessCheck,
  mongoTest
} from '../controllers/health.controller.js';

const router = express.Router();

// Basic health check
router.get('/', healthCheck);

// Detailed health check
router.get('/detailed', detailedHealthCheck);

// Kubernetes readiness probe
router.get('/ready', readinessCheck);

// Kubernetes liveness probe
router.get('/live', livenessCheck);

// MongoDB connection test
router.get('/mongo', mongoTest);

export default router; 