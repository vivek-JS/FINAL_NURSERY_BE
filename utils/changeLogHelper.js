import InventoryChangeLog from '../models/inventoryChangeLog.model.js';

// Helper function to create change log entry
export const createChangeLog = async (data) => {
  try {
    const changeLog = await InventoryChangeLog.create({
      entityType: data.entityType,
      entityId: data.entityId,
      action: data.action,
      changedBy: data.changedBy,
      changes: data.changes || [],
      metadata: data.metadata || {},
      description: data.description || '',
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
    });
    return changeLog;
  } catch (error) {
    console.error('Error creating change log:', error);
    // Don't throw error to avoid breaking the main operation
    return null;
  }
};

// Helper function to compare objects and generate changes array
export const generateChangesArray = (oldData, newData, fieldsToTrack = []) => {
  const changes = [];

  // If fieldsToTrack is empty, track all fields
  const fields = fieldsToTrack.length > 0 ? fieldsToTrack : Object.keys(newData);

  fields.forEach((field) => {
    const oldValue = oldData?.[field];
    const newValue = newData[field];

    // Skip if values are the same (deep comparison for objects/arrays)
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
      return;
    }

    changes.push({
      field,
      oldValue: oldValue !== undefined ? oldValue : null,
      newValue: newValue !== undefined ? newValue : null,
    });
  });

  return changes;
};


