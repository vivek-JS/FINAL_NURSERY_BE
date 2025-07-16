import State from "../models/state.model.js";
import AppError from "../utility/appError.js";
import catchAsync from "../utility/catchAsync.js";
import { getAll, updateOne, deleteOne } from "./factory.controller.js";

const getStates = getAll(State, "State");
const updateState = updateOne(State, "State");
const deleteState = deleteOne(State, "State");

// Get all states with basic info
export const getAllStates = catchAsync(async (req, res, next) => {
  const states = await State.find({ isActive: true })
    .select("name code")
    .sort({ name: 1 });

  res.status(200).json({
    status: "success",
    data: states,
  });
});

// Get districts by state
export const getDistrictsByState = catchAsync(async (req, res, next) => {
  const { stateId } = req.params;

  const state = await State.findById(stateId)
    .select("name districts.name districts.code")
    .sort({ "districts.name": 1 });

  if (!state) {
    return next(new AppError("State not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
      },
      districts: state.districts.map((district) => ({
        id: district._id,
        name: district.name,
        code: district.code,
      })),
    },
  });
});

// Get talukas by state and district
export const getTalukasByStateAndDistrict = catchAsync(async (req, res, next) => {
  const { stateId, districtId } = req.params;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code,
      },
      talukas: district.talukas.map((taluka) => ({
        id: taluka._id,
        name: taluka.name,
        code: taluka.code,
      })),
    },
  });
});

// Get villages by state, district, and taluka
export const getVillagesByStateDistrictAndTaluka = catchAsync(async (req, res, next) => {
  const { stateId, districtId, talukaId } = req.params;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }

  const taluka = district.talukas.id(talukaId);
  if (!taluka) {
    return next(new AppError("Taluka not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code,
      },
      taluka: {
        id: taluka._id,
        name: taluka.name,
        code: taluka.code,
      },
      villages: taluka.villages.map((village) => ({
        id: village._id,
        name: village.name,
        code: village.code,
      })),
    },
  });
});

// Create a new state
export const createState = catchAsync(async (req, res, next) => {
  const state = await State.create(req.body);

  res.status(201).json({
    status: "success",
    data: state,
  });
});

// Add district to state
export const addDistrictToState = catchAsync(async (req, res, next) => {
  const { stateId } = req.params;
  const { name, code } = req.body;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  // Check if district already exists
  const existingDistrict = state.districts.find(
    (district) => district.name.toLowerCase() === name.toLowerCase()
  );
  if (existingDistrict) {
    return next(new AppError("District already exists in this state", 400));
  }

  state.districts.push({ name, code });
  await state.save();

  res.status(201).json({
    status: "success",
    data: state.districts[state.districts.length - 1],
  });
});

// Add taluka to district
export const addTalukaToDistrict = catchAsync(async (req, res, next) => {
  const { stateId, districtId } = req.params;
  const { name, code } = req.body;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }

  // Check if taluka already exists
  const existingTaluka = district.talukas.find(
    (taluka) => taluka.name.toLowerCase() === name.toLowerCase()
  );
  if (existingTaluka) {
    return next(new AppError("Taluka already exists in this district", 400));
  }

  district.talukas.push({ name, code });
  await state.save();

  res.status(201).json({
    status: "success",
    data: district.talukas[district.talukas.length - 1],
  });
});

// Add village to taluka
export const addVillageToTaluka = catchAsync(async (req, res, next) => {
  const { stateId, districtId, talukaId } = req.params;
  const { name, code } = req.body;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }

  const taluka = district.talukas.id(talukaId);
  if (!taluka) {
    return next(new AppError("Taluka not found", 404));
  }

  // Check if village already exists
  const existingVillage = taluka.villages.find(
    (village) => village.name.toLowerCase() === name.toLowerCase()
  );
  if (existingVillage) {
    return next(new AppError("Village already exists in this taluka", 400));
  }

  taluka.villages.push({ name, code });
  await state.save();

  res.status(201).json({
    status: "success",
    data: taluka.villages[taluka.villages.length - 1],
  });
});

// Get complete location hierarchy for a specific location
export const getLocationHierarchy = catchAsync(async (req, res, next) => {
  const { stateId, districtId, talukaId, villageId } = req.params;

  const state = await State.findById(stateId);
  if (!state) {
    return next(new AppError("State not found", 404));
  }

  const district = state.districts.id(districtId);
  if (!district) {
    return next(new AppError("District not found", 404));
  }

  const taluka = district.talukas.id(talukaId);
  if (!taluka) {
    return next(new AppError("Taluka not found", 404));
  }

  const village = taluka.villages.id(villageId);
  if (!village) {
    return next(new AppError("Village not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      state: {
        id: state._id,
        name: state.name,
        code: state.code,
      },
      district: {
        id: district._id,
        name: district.name,
        code: district.code,
      },
      taluka: {
        id: taluka._id,
        name: taluka.name,
        code: taluka.code,
      },
      village: {
        id: village._id,
        name: village.name,
        code: village.code,
      },
    },
  });
});

export {
  getStates,
  updateState,
  deleteState,
}; 