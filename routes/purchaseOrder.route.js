import express from "express"
import multer from "multer"
import * as purchaseOrderController from "../controllers/purchaseOrder.controller.js"
import { authenticateToken } from "../middlewares/auth.middleware.js"

const router = express.Router()

const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf",
    ].includes(file.mimetype)
    cb(ok ? null : new Error("Only JPG/PNG/WEBP/PDF allowed for supplier invoice"), ok)
  },
})

router.use(authenticateToken)

router.post(
  "/",
  invoiceUpload.single("supplierInvoiceFile"),
  purchaseOrderController.createPurchaseOrder
)
router.get("/", purchaseOrderController.getAllPurchaseOrders)
router.get("/:id", purchaseOrderController.getPurchaseOrderById)
router.put(
  "/:id",
  invoiceUpload.single("supplierInvoiceFile"),
  purchaseOrderController.updatePurchaseOrder
)
router.post("/:id/approve", purchaseOrderController.approvePurchaseOrder)
router.post("/:id/cancel", purchaseOrderController.cancelPurchaseOrder)
router.delete("/:id", purchaseOrderController.deletePurchaseOrder)

export default router
