import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import User from "../models/user.model.js";
import {
  createOne,
  updateOne,
  deleteOne,
  isPhoneNumberExists,
  isDisabled,
} from "./factory.controller.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const createUser = [isPhoneNumberExists(User, "User"), createOne(User, "User")];
const updateUser = updateOne(User, "User");
const deleteUser = deleteOne(User, "User");
 const getUsers = async (req, res) => {
  try {
    const { jobTitle } = req.query;
    let query = { isDisabled: false };

    // Add jobTitle to query if provided
    if (jobTitle) {
      query.jobTitle = jobTitle;
    }

    const users = await User.find(query).select('-password');

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users
    });

  } catch (error) {
    console.error("Error in getUsers:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message
    });
  }
};
const encryptPassword = async (req, res, next) => {
  console.log(req.body.password)
  const password = req.body.password || "12345678";
  req.body.password = await bcrypt.hash(password, 10);
  next();
};

const findUser = catchAsync(async (req, res, next) => {
  const { phoneNumber } = req.body;
  console.log(phoneNumber)

  const user = await User.findOne({ phoneNumber });

  if (user) {
    return next(
      new AppError("User with same mobile number already exists", 409)
    );
  }

  next();
});

const generateToken = (id) => {
  const token = jwt.sign(
    {
      _id: id,
    },
    process.env.PRIVATE_KEY,
    {
      expiresIn: process.env.TOKEN_EXPIRY,
    }
  );

  return token;
};

const login = [
  isDisabled(User, "User"),
  catchAsync(async (req, res, next) => {
    const { phoneNumber, password } = req.body;
console.log(password,phoneNumber)
    const user = await User.findOne({ phoneNumber: phoneNumber });
    console.log(user)

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return next(new AppError("Wrong credentails", 400));
    }
 
    user.password = undefined;

    const token = generateToken(user._id);
    const response = generateResponse(
      "Success",
      "Login success",
      user,
      undefined
    );
    return res
      .status(200)
      .cookie("Authorization", token, { httpOnly: true })
      .json({ token: token, response });
  }),
];

export {getUsers, createUser, updateUser, deleteUser, findUser, login, encryptPassword };
