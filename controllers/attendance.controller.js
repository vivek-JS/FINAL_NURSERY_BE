import Attendance from "../models/attendance.model.js";
import { createOne, updateOne, deleteOne } from "./factory.controller.js";

const createAttendance = createOne(Attendance, "Attendance");
const updateAttendance = updateOne(Attendance, "Attendance");
const deleteAttendance = deleteOne(Attendance, "Attendance");
const getAttendance = () => {};

export { createAttendance, updateAttendance, deleteAttendance, getAttendance };
