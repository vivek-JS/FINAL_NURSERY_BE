import express from 'express';
import * as grnController from '../controllers/grn.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import multer from 'multer';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Multer for images (memory storage)
const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG/PNG/WEBP/AVIF/GIF allowed"), ok);
  },
});

// GRN routes
router.post('/', uploadImages.array('images', 10), grnController.createGRN); // Max 10 images
router.get('/', grnController.getAllGRNs);
router.get('/:id', grnController.getGRNById);
router.put('/:id', uploadImages.array('images', 10), grnController.updateGRN);
router.post('/:id/approve', grnController.approveGRN);
router.delete('/:id', grnController.deleteGRN);

export default router;

