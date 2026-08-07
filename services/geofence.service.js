const EARTH_RADIUS_M = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in meters between two GPS coordinates. */
export function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Validates employee GPS against branch geofence config.
 * @returns {{ ok: boolean, errorCode?: string, message?: string, distanceMeters?: number, locationVerified?: boolean }}
 */
export function validateGeofence({ latitude, longitude, gpsAccuracy }, branchLocation) {
  const geofenceEnabled = process.env.GEOFENCE_ENABLED !== "false";
  if (!geofenceEnabled) {
    return { ok: true, locationVerified: true, distanceMeters: null };
  }

  if (!branchLocation || !branchLocation.is_attendance_enabled) {
    return { ok: true, locationVerified: true, distanceMeters: null };
  }

  if (latitude == null || longitude == null) {
    return { ok: false, errorCode: "GPS_ACCURACY_LOW", message: "Location is required for attendance." };
  }

  const maxAccuracy = branchLocation.max_gps_accuracy_meters ?? Number(process.env.MAX_GPS_ACCURACY_METERS) ?? 50;
  if (gpsAccuracy != null && gpsAccuracy > maxAccuracy) {
    return {
      ok: false,
      errorCode: "GPS_ACCURACY_LOW",
      message: `GPS accuracy too low (${Math.round(gpsAccuracy)}m). Move to an open area and try again.`,
    };
  }

  const distance = haversineDistanceMeters(
    latitude,
    longitude,
    branchLocation.latitude,
    branchLocation.longitude
  );

  const allowedRadius = branchLocation.allowed_radius_meters ?? Number(process.env.DEFAULT_ALLOWED_RADIUS_METERS) ?? 200;

  if (distance > allowedRadius) {
    return {
      ok: false,
      errorCode: "OUTSIDE_GEOFENCE",
      message: `You are ${Math.round(distance)}m from the branch. Attendance is allowed within ${allowedRadius}m.`,
      distanceMeters: distance,
      locationVerified: false,
    };
  }

  return { ok: true, locationVerified: true, distanceMeters: distance };
}
