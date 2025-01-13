import jwt from "jsonwebtoken";
import generateResponse from "../utility/responseFormat.js";
import User from "../models/user.model.js";
import AppError from "../utility/appError.js";

const verifyToken = async (req, res, next) => {
  try {
    let token = req.cookies?.accessToken;
    
    // Check Authorization header if token not in cookies
    const authHeader = req.headers.authorization;
    if (!token && authHeader) {
      // Make sure we handle cases where Bearer might be missing
      token = authHeader.startsWith('Bearer ') 
        ? authHeader.replace('Bearer ', '') 
        : authHeader;
    }

    // if token not found
    if (!token) {
      const response = generateResponse(
        "error",
        "Unauthorized request",
        undefined,
        undefined
      );

      return res.status(401).json(response);
    }

    // decoding token
    const { data } = jwt.verify(token, process.env.PRIVATE_KEY);

    // document find by id
    const user = await User.findById(data._id);

    // if not found then send error
    if(!user){
      return next(new AppError("Invalid Token", 401));
    }

    req.user = user;

    // TODO: add code of role wise management here

    next();
  } catch (error) {
    const response = generateResponse(
      "error",
      "Unauthorized request",
      undefined,
      undefined
    );

    return res.status(401).json(response);
  }
};

export default verifyToken;
