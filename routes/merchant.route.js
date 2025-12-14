import express from 'express';
import { check } from 'express-validator';
import * as merchantController from '../controllers/merchant.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';
import checkErrors from '../middlewares/checkErrors.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Merchant routes
router.post(
  '/',
  [
    check('name').notEmpty().withMessage('Merchant name is required'),
    check('phone').notEmpty().withMessage('Phone number is required'),
  ],
  checkErrors,
  merchantController.createMerchant
);

router.get('/', merchantController.getAllMerchants);
router.get('/all', merchantController.getAllMerchants);
router.get('/:id', merchantController.getMerchantById);
router.get('/:id/ledger', merchantController.getMerchantLedger);
router.put('/:id', merchantController.updateMerchant);
router.delete('/:id', merchantController.deleteMerchant);

export default router;





