import EmployeeDevice from "../models/employeeDevice.model.js";

const enforceSingleDevice = () => process.env.ENFORCE_SINGLE_DEVICE !== "false";

/**
 * Validates and registers/updates the employee device.
 * @returns {{ ok: boolean, errorCode?: string, message?: string, device?: object }}
 */
export async function validateAndRegisterDevice(employeeId, { deviceId, deviceName, platform, appVersion }) {
  if (!deviceId) {
    return { ok: true, device: null };
  }

  const existing = await EmployeeDevice.findOne({ employee_id: employeeId, device_id: deviceId });

  if (existing) {
    existing.last_used_at = new Date();
    if (deviceName) existing.device_name = deviceName;
    if (platform) existing.platform = platform;
    if (appVersion) existing.app_version = appVersion;
    if (!existing.is_active && enforceSingleDevice()) {
      const activeOther = await EmployeeDevice.findOne({
        employee_id: employeeId,
        is_active: true,
        device_id: { $ne: deviceId },
      });
      if (activeOther) {
        return {
          ok: false,
          errorCode: "DEVICE_NOT_REGISTERED",
          message: "This device is not the registered attendance device. Contact admin to reset.",
        };
      }
      existing.is_active = true;
    }
    await existing.save();
    return { ok: true, device: existing };
  }

  if (enforceSingleDevice()) {
    const activeDevice = await EmployeeDevice.findOne({ employee_id: employeeId, is_active: true });
    if (activeDevice && activeDevice.device_id !== deviceId) {
      return {
        ok: false,
        errorCode: "DEVICE_NOT_REGISTERED",
        message: "Attendance must be marked from your registered device. Contact admin to reset.",
      };
    }
  }

  const created = await EmployeeDevice.create({
    employee_id: employeeId,
    device_id: deviceId,
    device_name: deviceName || null,
    platform: platform || null,
    app_version: appVersion || null,
    is_active: true,
    registered_at: new Date(),
    last_used_at: new Date(),
  });

  return { ok: true, device: created };
}

export async function resetEmployeeDevice(employeeId) {
  await EmployeeDevice.updateMany({ employee_id: employeeId }, { $set: { is_active: false } });
}
