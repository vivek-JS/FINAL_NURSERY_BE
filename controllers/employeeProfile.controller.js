import User from "../models/user.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
// Imported for its mongoose.model("Department", ...) registration side-effect —
// required before `.populate("department", ...)` below will resolve.
import "../models/department.model.js";

/**
 * GET /api/v1/employee/profile
 * Returns the logged-in employee's own profile, used by the attendance app's
 * profile screen (name, employee code, department, face-registration status).
 *
 * `registeredPoseCount` is looked up lazily via a dynamic import of
 * FaceEmbedding so this controller has no hard dependency on the face
 * registration module load order.
 */
export const getMyProfile = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id)
    .select("-password")
    .populate("department", "name code shiftStartTime")
    .lean();

  if (!user) {
    return next(new AppError("User not found", 404));
  }

  let registeredPoseCount = 0;
  try {
    const { default: FaceEmbedding } = await import("../models/faceEmbedding.model.js");
    registeredPoseCount = await FaceEmbedding.countDocuments({ user: user._id });
  } catch {
    // Face registration module not yet initialized — treat as zero.
  }

  return res.status(200).json(
    generateResponse(
      "Success",
      "Profile fetched successfully",
      {
        ...user,
        faceRegistration: {
          status: user.faceRegistrationStatus || "NOT_REGISTERED",
          registeredPoseCount,
        },
      },
      undefined
    )
  );
});
