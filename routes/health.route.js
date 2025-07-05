import express from 'express';
import { 
  healthCheck, 
  detailedHealthCheck, 
  readinessCheck, 
  livenessCheck 
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

export default router; 