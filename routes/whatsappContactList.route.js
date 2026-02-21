import express from "express";
import {
  getAllContactLists,
  getContactListById,
  createContactList,
  updateContactList,
  deleteContactList,
  extractFarmersFromList,
} from "../controllers/whatsappContactList.controller.js";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";

const router = express.Router();

router
  .get("/", getAllContactLists)
  .get("/:id", getContactListById)
  // Accept any body (including raw 'null') by parsing as text to avoid JSON parse errors from malformed clients
  .post("/:id/extract-farmers", express.text({ type: "*/*" }), extractFarmersFromList)
  .post(
    "/",
    [
      check("name").notEmpty().withMessage("List name is required"),
      check("contacts")
        .isArray()
        .withMessage("Contacts must be an array")
        .notEmpty()
        .withMessage("At least one contact is required"),
    ],
    checkErrors,
    createContactList
  )
  .patch(
    "/:id",
    [check("id").isMongoId().withMessage("Please enter valid list ID")],
    checkErrors,
    updateContactList
  )
  .delete(
    "/:id",
    [check("id").isMongoId().withMessage("Please enter valid list ID")],
    checkErrors,
    deleteContactList
  );

export default router;
