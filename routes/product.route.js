import express from 'express';
import * as productController from '../controllers/product.controller.js';
import {
  getProductAgriLinkHandler,
  patchProductAgriLinkHandler,
  getProductStockLedgerHandler,
} from '../controllers/biotechSeedMaster.controller.js';

const router = express.Router();

// Auth + restrictRamAgriSalesManager are applied by app.js when this router is mounted at
// /api/v1/inventory/products (same as inventory routes).

// Product routes
router.post('/', productController.createProduct);
router.get('/summary', productController.getInventorySummary);
router.get('/low-stock', productController.getLowStockProducts);
router.get('/', productController.getAllProducts);
router.get('/:id/stock-ledger', getProductStockLedgerHandler);
router.get('/:id/agri-link', getProductAgriLinkHandler);
router.patch('/:id/agri-link', patchProductAgriLinkHandler);
router.get('/:id', productController.getProductById);
router.put('/:id', productController.updateProduct);
router.delete('/:id', productController.deleteProduct);

export default router;

