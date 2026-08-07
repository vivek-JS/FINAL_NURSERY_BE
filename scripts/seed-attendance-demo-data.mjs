/**
 * Seeds demo Departments, employees, and ~2 weeks of attendance history so the
 * Face Recognition Attendance app's dashboard/calendar/admin screens have
 * something to show on a fresh local database. Idempotent — safe to re-run.
 *
 * Note: this cannot fabricate real face embeddings (they require actual
 * photos run through the face detector), so seeded employees are left with
 * faceRegistrationStatus = NOT_REGISTERED. Register their face for real
 * through the mobile app, or via POST /api/v1/face-attendance/register-face,
 * before testing the verify-face / mark-attendance flow with them.
 *
 * Usage:
 *   node scripts/seed-attendance-demo-data.mjs            # MONGO_URL / STAGE_MONGO_URL
 *   node scripts/seed-attendance-demo-data.mjs --prod-db   # PROD_MONGO_URL (asks for confirmation)
 */
import dotenv from "dotenv";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const USE_PROD = process.argv.includes("--prod-db");
const DEMO_PHONE_BASE = 9000000900;
const DEMO_EMPLOYEE_COUNT = 4;

function resolveMongoUrl() {
  if (USE_PROD) {
    if (!process.env.PROD_MONGO_URL) throw new Error("PROD_MONGO_URL is not set");
    return process.env.PROD_MONGO_URL;
  }
  const url = process.env.MONGO_URL || process.env.STAGE_MONGO_URL || process.env.MONGODB_URI;
  if (!url) throw new Error("MONGO_URL (or STAGE_MONGO_URL / MONGODB_URI) is not set");
  return url;
}

function confirmProd() {
  if (!USE_PROD) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("⚠️  --prod-db was passed. Type 'yes' to seed demo data into PRODUCTION: ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function seedDepartments() {
  const { default: Department } = await import("../models/department.model.js");

  const specs = [
    { name: "Nursery Operations", code: "NURSERY", shiftStartTime: "09:00", lateGraceMinutes: 10 },
    { name: "Office Admin", code: "OFFICE", shiftStartTime: "09:30", lateGraceMinutes: 15 },
  ];

  const departments = [];
  for (const spec of specs) {
    const dept = await Department.findOneAndUpdate(
      { code: spec.code },
      { $setOnInsert: spec },
      { upsert: true, new: true }
    );
    departments.push(dept);
  }
  return departments;
}

async function seedEmployees(departments) {
  const { default: User } = await import("../models/user.model.js");
  const [nursery, office] = departments;
  const hashedPassword = await bcrypt.hash("Demo@1234", 10);

  const specs = [
    { name: "Demo Employee One", jobTitle: "OFFICE_STAFF", role: "OFFICE_STAFF", department: office._id },
    { name: "Demo Employee Two", jobTitle: "MANAGER", role: "Manager", department: nursery._id },
    { name: "Demo Employee Three", jobTitle: "OFFICE_STAFF", role: "OFFICE_STAFF", department: nursery._id },
    { name: "Demo Employee Four", jobTitle: "HR", role: "HR", department: office._id },
  ];

  const employees = [];
  for (let i = 0; i < DEMO_EMPLOYEE_COUNT; i += 1) {
    const spec = specs[i];
    const phoneNumber = DEMO_PHONE_BASE + i + 1;
    const employee = await User.findOneAndUpdate(
      { phoneNumber },
      {
        $setOnInsert: {
          name: spec.name,
          phoneNumber,
          jobTitle: spec.jobTitle,
          role: spec.role,
          employeeCode: `DEMO-00${i + 1}`,
          department: spec.department,
          faceRegistrationStatus: "NOT_REGISTERED",
        },
        $set: {
          password: hashedPassword,
          isPasswordSet: true,
        },
      },
      { upsert: true, new: true }
    );
    employees.push(employee);
  }
  return employees;
}

/** ~14 days of varied attendance history for the first demo employee only. */
async function seedAttendanceHistory(employee, department) {
  const { default: AttendanceRecord } = await import("../models/attendanceRecord.model.js");

  await AttendanceRecord.deleteMany({ employee: employee._id }); // re-seed cleanly on every run

  const [shiftHour, shiftMinute] = (department.shiftStartTime || "09:30").split(":").map(Number);
  const records = [];
  const today = new Date();

  for (let daysAgo = 13; daysAgo >= 1; daysAgo -= 1) {
    const day = new Date(today);
    day.setDate(day.getDate() - daysAgo);
    const dow = day.getDay();
    if (dow === 0) continue; // Sunday — weekend, no attendance expected

    const dateYmd = ymd(day);
    const isAbsentDemoDay = daysAgo === 6; // one deliberate absence for the "leaves" stat
    if (isAbsentDemoDay) continue;

    const isLateDemoDay = daysAgo === 3 || daysAgo === 9;
    const checkInHour = isLateDemoDay ? shiftHour + 1 : shiftHour;
    const checkInMinute = isLateDemoDay ? shiftMinute + 15 : Math.max(0, shiftMinute - 10);

    const checkIn = new Date(day);
    checkIn.setHours(checkInHour, checkInMinute % 60, 0, 0);
    const checkOut = new Date(checkIn);
    checkOut.setHours(checkIn.getHours() + 8, checkIn.getMinutes() + 15, 0, 0);

    const device = { name: "Demo Seed Device", id: "seed-device-01", os: "Android 14", isCompromised: false };

    records.push(
      {
        employee: employee._id,
        type: "CHECK_IN",
        date: dateYmd,
        time: checkIn,
        device,
        faceMatchScore: 0.92,
        livenessPassed: true,
        livenessChallenge: "BLINK_TWICE",
        source: "ONLINE",
        isLate: isLateDemoDay,
      },
      {
        employee: employee._id,
        type: "CHECK_OUT",
        date: dateYmd,
        time: checkOut,
        device,
        faceMatchScore: 0.9,
        livenessPassed: true,
        livenessChallenge: "SMILE",
        source: "ONLINE",
        isLate: false,
      }
    );
  }

  if (records.length) await AttendanceRecord.insertMany(records);
  return records.length;
}

async function main() {
  const proceed = await confirmProd();
  if (!proceed) {
    console.log("Aborted.");
    return;
  }

  const mongoUrl = resolveMongoUrl();
  await mongoose.connect(mongoUrl);
  console.log(`Connected to: ${mongoose.connection.name}@${mongoose.connection.host} ${USE_PROD ? "(PRODUCTION)" : ""}`);

  const departments = await seedDepartments();
  console.log(`Departments ready: ${departments.map((d) => d.code).join(", ")}`);

  const employees = await seedEmployees(departments);
  console.log(`Employees ready: ${employees.map((e) => `${e.employeeCode} (+91${e.phoneNumber})`).join(", ")}`);

  const employeeDept = departments.find((d) => String(d._id) === String(employees[0].department)) || departments[0];
  const recordCount = await seedAttendanceHistory(employees[0], employeeDept);
  console.log(`Seeded ${recordCount} attendance records for ${employees[0].employeeCode} (last ~2 weeks).`);

  console.log("\nDone. Demo employees have faceRegistrationStatus = NOT_REGISTERED —");
  console.log("register their face via the mobile app or POST /face-attendance/register-face before testing verify-face with them.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});
