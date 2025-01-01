import { validationResult } from "express-validator";
import AppError from "../utility/appError.js";

const checkErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log("Validation Errors:", errors.array());  // Log validation errors

    const messages = errors
      .array()
      .map((error) => {
        
        return error.msg;
      })
      .join(", ");
    return next(new AppError(messages, 400));
  }
  next();
};

export default checkErrors;
