import { describe, it, expect } from "@jest/globals";
import { haversineDistanceMeters, validateGeofence } from "../services/geofence.service.js";
import {
  computeLateByMinutes,
  computeEarlyExitMinutes,
  isHoliday,
  validateMinCheckoutGap,
} from "../services/attendanceRules.service.js";

describe("geofence.service", () => {
  it("computes haversine distance", () => {
    const d = haversineDistanceMeters(19.076, 72.8777, 19.0761, 72.8778);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(20);
  });

  it("rejects outside geofence", () => {
    const result = validateGeofence(
      { latitude: 19.1, longitude: 73.0, gpsAccuracy: 10 },
      { latitude: 19.076, longitude: 72.8777, allowed_radius_meters: 200, max_gps_accuracy_meters: 50, is_attendance_enabled: true }
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("OUTSIDE_GEOFENCE");
  });

  it("accepts inside geofence", () => {
    const result = validateGeofence(
      { latitude: 19.076, longitude: 72.8777, gpsAccuracy: 10 },
      { latitude: 19.076, longitude: 72.8777, allowed_radius_meters: 200, max_gps_accuracy_meters: 50, is_attendance_enabled: true }
    );
    expect(result.ok).toBe(true);
  });
});

describe("attendanceRules.service", () => {
  it("detects holiday from env", () => {
    process.env.ATTENDANCE_HOLIDAYS = "2026-01-26";
    expect(isHoliday("2026-01-26")).toBe(true);
    expect(isHoliday("2026-01-27")).toBe(false);
  });

  it("enforces min checkout gap", () => {
    const checkIn = new Date("2026-08-04T09:00:00+05:30");
    const checkOut = new Date("2026-08-04T09:15:00+05:30");
    const result = validateMinCheckoutGap(checkIn, checkOut, { minMinutesBetweenCheckInAndOut: 30 });
    expect(result.ok).toBe(false);
  });

  it("computes late minutes", () => {
    const checkIn = new Date("2026-08-04T10:00:00+05:30");
    const late = computeLateByMinutes(checkIn, { shiftStartTime: "09:30", lateGraceMinutes: 10 });
    expect(late).toBeGreaterThan(0);
  });

  it("computes early exit", () => {
    const checkOut = new Date("2026-08-04T17:00:00+05:30");
    const early = computeEarlyExitMinutes(checkOut, { shiftEndTime: "18:00" });
    expect(early).toBe(60);
  });
});
