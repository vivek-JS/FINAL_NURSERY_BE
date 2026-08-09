import User from "../models/user.model.js";
import AttendanceDaily from "../models/attendanceDaily.model.js";
import "../models/department.model.js";
import "../models/employeeOfficeGroup.model.js";
import "../models/nurserySite.model.js";
import { getIstTodayYmd } from "../utility/istCalendar.js";
import { resolveOfficeHours, isWeeklyOff } from "./attendanceRules.service.js";

const STAFF_FILTER = {
  jobTitle: { $exists: true, $ne: null },
  role: { $ne: "FARMER" },
  isDisabled: { $ne: true },
};

function formatHHmmDisplay(hhmm) {
  if (!hhmm) return "—";
  return hhmm;
}

function formatShiftRange(start, end) {
  if (!start) return "—";
  const s = start.replace(":", ".");
  const e = end ? end.replace(":", ".") : "";
  return e ? `${s} – ${e}` : s;
}

function formatIstTime(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function initials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function punchSource(punch) {
  const src = punch?.source || "MOBILE";
  if (src === "KIOSK") return "Kiosk";
  return "Mobile";
}

function mapRow(employee, daily, dateYmd) {
  const hours = resolveOfficeHours(employee);
  const weeklyOff = isWeeklyOff(hours, dateYmd);

  const checkInTs = daily?.check_in?.timestamp || null;
  const checkOutTs = daily?.check_out?.timestamp || null;
  const lateMinutes = daily?.late_by_minutes ?? 0;
  const hasCheckIn = !!checkInTs;
  const hasCheckOut = !!checkOutTs;

  let rowStatus = "ABSENT";
  if (weeklyOff) rowStatus = "WEEKLY_OFF";
  else if (!hasCheckIn) rowStatus = "ABSENT";
  else if (lateMinutes > 0 || daily?.attendance_status === "LATE") rowStatus = "LATE";
  else rowStatus = "PRESENT";

  const onTime = hasCheckIn && lateMinutes === 0 && rowStatus !== "ABSENT";

  let workingMinutes = daily?.total_working_minutes ?? 0;
  if (hasCheckIn && !hasCheckOut) {
    workingMinutes = Math.max(0, Math.round((Date.now() - new Date(checkInTs).getTime()) / 60000));
  }

  return {
    employee_id: String(employee._id),
    attendance_id: daily?._id ? String(daily._id) : null,
    name: employee.name,
    employee_code: employee.employeeCode || null,
    job_title: employee.jobTitle || null,
    branch_name: employee.nurserySite?.name || daily?.branch_id?.name || null,
    department_name: employee.department?.name || daily?.shift_id?.name || null,
    initials: initials(employee.name),
    shift_label: formatShiftRange(hours.officeStartTime, hours.officeEndTime),
    expected_in: formatHHmmDisplay(daily?.office_start_time || hours.officeStartTime),
    check_in_time: formatIstTime(checkInTs),
    check_in_raw: checkInTs,
    check_out_time: hasCheckOut ? formatIstTime(checkOutTs) : null,
    check_out_raw: checkOutTs,
    in_office: hasCheckIn && !hasCheckOut,
    on_time: onTime,
    late_minutes: lateMinutes,
    hours_label: formatDuration(workingMinutes),
    working_minutes: workingMinutes,
    row_status: rowStatus,
    attendance_status: daily?.attendance_status || rowStatus,
    source: hasCheckIn ? punchSource(daily.check_in) : null,
    face_match_score: daily?.check_in?.face_match_score ?? null,
    check_out_face_match_score: daily?.check_out?.face_match_score ?? null,
    check_in_photo_url: daily?.check_in?.audit_image_url || null,
    check_out_photo_url: daily?.check_out?.audit_image_url || null,
    is_regularized: daily?.status === "CORRECTED",
    correction_note: daily?.correction_reason || null,
    office_group_id: hours.office_group_id ? String(hours.office_group_id) : null,
    daily,
  };
}

function applyFilters(rows, { branch, department, status, search }) {
  let out = rows;
  if (branch) {
    out = out.filter(
      (r) =>
        String(r.employee?.nurserySite?._id || r.employee?.nurserySite || "") === String(branch) ||
        String(r.daily?.branch_id?._id || r.daily?.branch_id || "") === String(branch)
    );
  }
  if (department) {
    out = out.filter(
      (r) =>
        String(r.employee?.department?._id || r.employee?.department || "") === String(department) ||
        String(r.daily?.shift_id?._id || r.daily?.shift_id || "") === String(department)
    );
  }
  if (status === "ON_TIME") out = out.filter((r) => r.on_time);
  else if (status === "LATE") out = out.filter((r) => r.row_status === "LATE");
  else if (status === "ABSENT") out = out.filter((r) => r.row_status === "ABSENT");
  else if (status === "IN_OFFICE") out = out.filter((r) => r.in_office);
  if (search) {
    const q = String(search).trim().toLowerCase();
    out = out.filter(
      (r) =>
        r.name?.toLowerCase().includes(q) ||
        r.employee_code?.toLowerCase().includes(q) ||
        r.job_title?.toLowerCase().includes(q)
    );
  }
  return out;
}

export async function buildTodayDashboard({ date, branch, department, status, search }) {
  const dateYmd = date || getIstTodayYmd();

  const [employees, dailyRecords] = await Promise.all([
    User.find(STAFF_FILTER)
      .select("name employeeCode jobTitle department officeGroup nurserySite officeStartTimeOverride officeEndTimeOverride")
      .populate("department", "name code shiftStartTime shiftEndTime officeStartTime officeEndTime lateGraceMinutes weeklyOffDays")
      .populate("officeGroup", "name code officeStartTime officeEndTime lateGraceMinutes weeklyOffDays")
      .populate("nurserySite", "name code")
      .lean(),
    AttendanceDaily.find({ attendance_date: dateYmd })
      .populate("branch_id", "name code")
      .populate("shift_id", "name code")
      .lean(),
  ]);

  const dailyByEmployee = new Map(dailyRecords.map((d) => [String(d.employee_id), d]));

  const allRows = employees.map((emp) => {
    const daily = dailyByEmployee.get(String(emp._id)) || null;
    const row = mapRow(emp, daily, dateYmd);
    row.employee = emp;
    return row;
  });

  const filtered = applyFilters(allRows, { branch, department, status, search });

  const totalStaff = employees.length;
  const checkedIn = allRows.filter((r) => r.check_in_raw).length;
  const onTime = allRows.filter((r) => r.on_time).length;
  const late = allRows.filter((r) => r.row_status === "LATE").length;
  const absent = allRows.filter((r) => r.row_status === "ABSENT").length;
  const stillInOffice = allRows.filter((r) => r.in_office).length;

  return {
    date: dateYmd,
    synced_at: new Date().toISOString(),
    kpis: {
      total_staff: totalStaff,
      checked_in: checkedIn,
      on_time: onTime,
      late,
      absent,
      still_in_office: stillInOffice,
      checked_in_pct: totalStaff ? Math.round((checkedIn / totalStaff) * 100) : 0,
    },
    records: filtered.map(({ employee, ...rest }) => rest),
    total: filtered.length,
  };
}
