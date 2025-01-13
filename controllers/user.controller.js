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

    const users = await User.find(query).select("-password");

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (error) {
    console.error("Error in getUsers:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
};
const encryptPassword = async (req, res, next) => {
  const password = req.body.password || "12345";
  req.body.password = await bcrypt.hash(password, 10);
  next();
};

const findUser = catchAsync(async (req, res, next) => {
  const { phoneNumber } = req.body;

  const user = await User.findOne({ phoneNumber });

  if (user) {
    return next(
      new AppError("User with same mobile number already exists", 409)
    );
  }

  next();
});

const generateToken = (data) => {
  const token = jwt.sign(
    {
      data,
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
    const { password } = req.body;
    let phoneNumber = Number(req.body?.phoneNumber);

    const user = await User.findOne({ phoneNumber: phoneNumber });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return next(new AppError("Wrong credentails", 400));
    }

    user.password = undefined;

    const token = generateToken(user);
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

// Controller used to reset password
const resetPassword = catchAsync(async (req, res, next) => {
  const { _id } = req.user;

  let password = req.body.password || "12345";
  password = await bcrypt.hash(password, 10);

  const user = await User.findByIdAndUpdate(_id, { password });

  if (!user) {
    return next(new AppError("User not found", 404));
  }

  return res.status(200).json({
    success: true,
    message: "User password updated successfully",
  });

});

// Controller which gives info about themselves
const aboutMe = catchAsync(async (req, res, next) => {
  const { _id } = req.user;

  const user = await User.findById(_id);

  if (!user) {
    return next(new AppError("User not found", 404));
  }

  return res.status(200).json({
    success: true,
    message: "User found successfully",
    data: user,
  });
});

export {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  findUser,
  login,
  encryptPassword,
  resetPassword,
  aboutMe,
};
