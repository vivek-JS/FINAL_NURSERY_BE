import express from "express";
import { check } from "express-validator";
import checkErrors from "../middlewares/checkErrors.middleware.js";
import { authenticateToken } from "../middlewares/auth.middleware.js";
import {
  getTodayNote,
  upsertTodayNote,
  upsertNote,
  getNoteByDate,
  listNotes,
  updateNote,
  deleteNote,
} from "../controllers/dailyNote.controller.js";

const router = express.Router();
const NOTE_ID = ":id([0-9a-fA-F]{24})";

router.use(authenticateToken);

router.get("/today", getTodayNote);

router.put(
  "/today",
  [
    check("content").notEmpty().withMessage("Content is required"),
    check("title").optional().isString().isLength({ max: 200 }),
    check("mood")
      .optional({ nullable: true })
      .isIn(["great", "good", "okay", "low", "stressed", null, ""])
      .withMessage("Invalid mood"),
  ],
  checkErrors,
  upsertTodayNote
);

router.post(
  "/",
  [
    check("content").notEmpty().withMessage("Content is required"),
    check("noteDate")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("noteDate must be YYYY-MM-DD"),
  ],
  checkErrors,
  upsertNote
);

router.get("/", listNotes);

router.get(
  "/by-date/:date",
  [
    check("date")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be YYYY-MM-DD"),
  ],
  checkErrors,
  getNoteByDate
);

router.put(
  `/${NOTE_ID}`,
  [check("id").isMongoId().withMessage("Invalid note ID")],
  checkErrors,
  updateNote
);

router.delete(
  `/${NOTE_ID}`,
  [check("id").isMongoId().withMessage("Invalid note ID")],
  checkErrors,
  deleteNote
);

export default router;
