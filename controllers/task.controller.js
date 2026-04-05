import Task from "../models/task.model.js";
import Employee from "../models/user.model.js";
import CallAssignmentList from "../models/callAssignmentList.model.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";

const MANAGE_ROLES = new Set(["SUPER_ADMIN", "SUPERADMIN", "ADMIN"]);

function roleKey(user) {
  return user?.role || user?.jobTitle || "";
}

export function canManageTasks(user) {
  return MANAGE_ROLES.has(roleKey(user));
}

function canSeeAllTasks(user) {
  return MANAGE_ROLES.has(roleKey(user));
}

export function ensureAssignmentsArray(task) {
  const t = task;
  if (t.assignments && t.assignments.length > 0) return;
  const ids = t.assignedEmployees || [];
  t.assignments = ids.map((id) => ({
    employeeId: id,
    status: "pending",
  }));
}

export function rollupTaskStatusFromAssignments(task) {
  const a = task.assignments || [];
  if (a.length === 0) return;
  const allDone = a.every((x) => x.status === "completed");
  const anyStarted = a.some((x) => x.status === "in_progress" || x.status === "completed");
  if (allDone) {
    task.status = "completed";
    if (!task.completedAt) task.completedAt = new Date();
  } else if (anyStarted) {
    task.status = "in_progress";
    task.completedAt = undefined;
  } else {
    task.status = "pending";
    task.completedAt = undefined;
  }
}

function progressMeta(task) {
  const a = task.assignments || [];
  const total = a.length || (task.assignedEmployees?.length ?? 0) || 1;
  const done = a.filter((x) => x.status === "completed").length;
  return { progressDone: done, progressTotal: total };
}

export const createTask = async (req, res) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json(
        generateResponse("error", "Only administrators can create tasks", null, null)
      );
    }

    const {
      title,
      description,
      dueDate,
      dueTime,
      priority,
      assignedEmployees,
      tags,
      sourceType,
      callAssignmentListId,
    } = req.body;

    if (!title || !dueDate) {
      return res.status(400).json(
        generateResponse("error", "Title and due date are required", null, null)
      );
    }

    if (!assignedEmployees || !Array.isArray(assignedEmployees) || assignedEmployees.length === 0) {
      return res.status(400).json(
        generateResponse("error", "At least one employee must be assigned", null, null)
      );
    }

    const invalidIds = assignedEmployees.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length > 0) {
      return res.status(400).json(
        generateResponse("error", `Invalid employee ID format: ${invalidIds.join(", ")}`, null, null)
      );
    }

    const employees = await Employee.find({ _id: { $in: assignedEmployees } });
    if (employees.length !== assignedEmployees.length) {
      return res.status(404).json(
        generateResponse("error", "One or more assigned employees not found", null, null)
      );
    }

    const tagList = Array.isArray(tags)
      ? tags
      : typeof tags === "string"
        ? tags.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    const normalizedSourceType =
      sourceType === "call_assignment" ? "call_assignment" : "manual";
    let linkedListId = null;
    if (normalizedSourceType === "call_assignment") {
      if (!callAssignmentListId || !mongoose.Types.ObjectId.isValid(callAssignmentListId)) {
        return res.status(400).json(
          generateResponse("error", "Valid callAssignmentListId is required for call-assignment tasks", null, null)
        );
      }
      const list = await CallAssignmentList.findById(callAssignmentListId).select("_id assignedTo").lean();
      if (!list) {
        return res.status(404).json(
          generateResponse("error", "Call assignment list not found", null, null)
        );
      }
      linkedListId = list._id;
    }

    const assignments = assignedEmployees.map((id) => ({
      employeeId: id,
      status: "pending",
    }));

    const newTask = new Task({
      title,
      description: description || "",
      dueDate,
      dueTime: dueTime || "",
      priority: priority || "medium",
      status: "pending",
      assignedEmployees,
      assignments,
      tags:
        normalizedSourceType === "call_assignment"
          ? [...new Set([...tagList, "call-assignment"])]
          : tagList,
      sourceType: normalizedSourceType,
      callAssignmentListId: linkedListId,
      createdBy: req.user?._id,
    });

    rollupTaskStatusFromAssignments(newTask);
    await newTask.save();

    await newTask.populate("assignedEmployees", "name employee_id email phoneNumber department");
    await newTask.populate("assignments.employeeId", "name employee_id email phoneNumber department");

    const meta = progressMeta(newTask);
    return res.status(201).json(
      generateResponse(
        "success",
        "Task created and assigned successfully",
        { task: { ...newTask.toObject(), ...meta } },
        null
      )
    );
  } catch (error) {
    console.error("Error creating task:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to create task", null, error.message)
    );
  }
};


export const getTasks = async (req, res) => {
  try {
    const {
      status,
      employeeId,
      createdBy,
      priority,
      sourceType,
      dueFrom,
      dueTo,
      createdFrom,
      createdTo,
      assignmentStatus,
    } = req.query;

    const query = {};

    if (!canSeeAllTasks(req.user)) {
      const uid = req.user._id;
      query.$or = [{ assignedEmployees: uid }, { "assignments.employeeId": uid }];
    }

    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (sourceType) query.sourceType = sourceType;

    if (employeeId && canSeeAllTasks(req.user)) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }
      query.assignedEmployees = employeeId;
    }

    if (createdBy && canSeeAllTasks(req.user)) {
      if (!mongoose.Types.ObjectId.isValid(createdBy)) {
        return res.status(400).json(
          generateResponse("error", "Invalid creator ID format", null, null)
        );
      }
      query.createdBy = createdBy;
    }

    if (dueFrom || dueTo) {
      query.dueDate = {};
      if (dueFrom) query.dueDate.$gte = dueFrom;
      if (dueTo) query.dueDate.$lte = dueTo;
    }

    if (createdFrom || createdTo) {
      query.createdAt = {};
      if (createdFrom) query.createdAt.$gte = new Date(createdFrom);
      if (createdTo) query.createdAt.$lte = new Date(createdTo);
    }

    let tasks = await Task.find(query)
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .populate("assignments.employeeId", "name employee_id email phoneNumber department")
      .populate("comments.employeeId", "name employee_id")
      .sort({ createdAt: -1 });

    tasks = tasks.map((doc) => {
      const o = doc.toObject();
      ensureAssignmentsArray(o);
      const m = progressMeta(o);
      return { ...o, ...m };
    });

    if (assignmentStatus) {
      const uid = req.user._id.toString();
      tasks = tasks.filter((t) => {
        const row = (t.assignments || []).find((a) => a.employeeId?.toString() === uid);
        return row && row.status === assignmentStatus;
      });
    }

    return res.status(200).json(
      generateResponse(
        "success",
        "Tasks retrieved successfully",
        { tasks, count: tasks.length },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching tasks:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch tasks", null, error.message)
    );
  }
};

export const getTaskStats = async (req, res) => {
  try {
    const base = {};
    if (!canSeeAllTasks(req.user)) {
      const uid = req.user._id;
      base.$or = [{ assignedEmployees: uid }, { "assignments.employeeId": uid }];
    }

    const tasks = await Task.find(base).lean();
    const today = new Date().toISOString().slice(0, 10);
    const uidStr = req.user._id.toString();

    let total = 0;
    let todo = 0;
    let inProgress = 0;
    let completed = 0;
    let urgent = 0;
    let overdue = 0;
    let pendingForMe = 0;

    for (const t of tasks) {
      ensureAssignmentsArray(t);
      total += 1;
      if (t.priority === "urgent") urgent += 1;
      if (t.status === "completed") completed += 1;
      else if (t.status === "in_progress") inProgress += 1;
      else todo += 1;

      if (t.status !== "completed" && t.dueDate && t.dueDate < today) overdue += 1;

      if (t.status !== "cancelled") {
        const row = (t.assignments || []).find((a) => {
          const eid = a.employeeId?.toString?.() || String(a.employeeId);
          return eid === uidStr;
        });
        if (row?.status === "pending") pendingForMe += 1;
      }
    }

    return res.status(200).json(
      generateResponse(
        "success",
        "Stats",
        { total, todo, inProgress, completed, urgent, overdue, pendingForMe },
        null
      )
    );
  } catch (error) {
    console.error("Error task stats:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch stats", null, error.message)
    );
  }
};

export const updateMyAssignment = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { status: nextStatus } = req.body;
    const uid = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    if (!["pending", "in_progress", "completed"].includes(nextStatus)) {
      return res.status(400).json(
        generateResponse("error", "Invalid assignment status", null, null)
      );
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    ensureAssignmentsArray(task);
    const row = task.assignments.find((a) => a.employeeId.toString() === uid.toString());
    if (!row) {
      return res.status(403).json(
        generateResponse("error", "You are not assigned to this task", null, null)
      );
    }

    row.status = nextStatus;
    if (nextStatus === "in_progress" && !row.startedAt) row.startedAt = new Date();
    if (nextStatus === "completed") {
      row.completedAt = new Date();
      task.completedBy = task.completedBy.filter((x) => x.employeeId?.toString() !== uid.toString());
      task.completedBy.push({ employeeId: uid, completedAt: new Date() });
    } else {
      row.completedAt = undefined;
      if (nextStatus === "pending") row.startedAt = undefined;
    }

    rollupTaskStatusFromAssignments(task);
    task.updatedAt = new Date();
    await task.save();

    await task.populate("assignedEmployees", "name employee_id email phoneNumber department");
    await task.populate("assignments.employeeId", "name employee_id email phoneNumber department");

    const meta = progressMeta(task);
    return res.status(200).json(
      generateResponse("success", "Assignment updated", { task: { ...task.toObject(), ...meta } }, null)
    );
  } catch (error) {
    console.error("Error updateMyAssignment:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to update assignment", null, error.message)
    );
  }
};


export const getTaskById = async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    const task = await Task.findById(taskId)
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .populate("comments.employeeId", "name employee_id")
      .populate("assignments.employeeId", "name employee_id email phoneNumber department");

    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    if (!canSeeAllTasks(req.user)) {
      const uid = req.user._id.toString();
      const ok = (task.assignedEmployees || []).some((id) => id.toString() === uid) ||
        (task.assignments || []).some((a) => a.employeeId?.toString() === uid);
      if (!ok) {
        return res.status(403).json(
          generateResponse("error", "Not authorized", null, null)
        );
      }
    }

    const o = task.toObject();
    ensureAssignmentsArray(o);
    return res.status(200).json(
      generateResponse(
        "success",
        "Task retrieved successfully",
        { task: { ...o, ...progressMeta(o) } },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching task:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch task", null, error.message)
    );
  }
};

export const updateTask = async (req, res) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json(
        generateResponse("error", "Only administrators can update tasks", null, null)
      );
    }

    const { taskId } = req.params;
    const { title, description, dueDate, dueTime, priority, status, assignedEmployees, tags } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (dueTime !== undefined) task.dueTime = dueTime;
    if (priority !== undefined) task.priority = priority;

    if (tags !== undefined) {
      task.tags = Array.isArray(tags)
        ? tags
        : String(tags).split(",").map((s) => s.trim()).filter(Boolean);
    }

    if (status !== undefined) {
      task.status = status;
      if (status === "completed" && !task.completedAt) {
        task.completedAt = new Date();
      } else if (status !== "completed" && task.completedAt) {
        task.completedAt = undefined;
      }
    }

    if (assignedEmployees !== undefined) {
      if (!Array.isArray(assignedEmployees) || assignedEmployees.length === 0) {
        return res.status(400).json(
          generateResponse("error", "At least one employee must be assigned", null, null)
        );
      }

      const invalidIds = assignedEmployees.filter((id) => !mongoose.Types.ObjectId.isValid(id));
      if (invalidIds.length > 0) {
        return res.status(400).json(
          generateResponse("error", `Invalid employee ID format: ${invalidIds.join(", ")}`, null, null)
        );
      }

      const employees = await Employee.find({ _id: { $in: assignedEmployees } });
      if (employees.length !== assignedEmployees.length) {
        return res.status(404).json(
          generateResponse("error", "One or more assigned employees not found", null, null)
        );
      }

      task.assignedEmployees = assignedEmployees;
      task.assignments = assignedEmployees.map((id) => ({
        employeeId: id,
        status: "pending",
      }));
    }

    rollupTaskStatusFromAssignments(task);
    task.updatedAt = new Date();
    await task.save();

    await task.populate("assignedEmployees", "name employee_id email phoneNumber department");
    await task.populate("assignments.employeeId", "name employee_id email phoneNumber department");

    return res.status(200).json(
      generateResponse(
        "success",
        "Task updated successfully",
        { task: { ...task.toObject(), ...progressMeta(task) } },
        null
      )
    );
  } catch (error) {
    console.error("Error updating task:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to update task", null, error.message)
    );
  }
};

export const addTaskComment = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name, comment, statusUpdate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    if (!name || !comment) {
      return res.status(400).json(
        generateResponse("error", "Name and comment are required", null, null)
      );
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }

      const isAssigned = task.assignedEmployees.some(
        (id) => id.toString() === employeeId.toString()
      );
      if (!isAssigned) {
        return res.status(403).json(
          generateResponse("error", "Employee is not assigned to this task", null, null)
        );
      }
    }

    const newComment = {
      employeeId: employeeId || null,
      name,
      comment,
      statusUpdate: statusUpdate || undefined,
      createdAt: new Date(),
    };

    task.comments.push(newComment);

    if (statusUpdate && statusUpdate !== task.status) {
      task.status = statusUpdate;
      rollupTaskStatusFromAssignments(task);
    }

    task.updatedAt = new Date();
    await task.save();

    await task.populate("assignedEmployees", "name employee_id email phoneNumber department");
    await task.populate("comments.employeeId", "name employee_id");

    return res.status(201).json(
      generateResponse(
        "success",
        "Comment added successfully",
        { task },
        null
      )
    );
  } catch (error) {
    console.error("Error adding comment:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to add comment", null, error.message)
    );
  }
};

export const deleteTask = async (req, res) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json(
        generateResponse("error", "Only administrators can delete tasks", null, null)
      );
    }

    const { taskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    const task = await Task.findByIdAndDelete(taskId);
    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    return res.status(200).json(
      generateResponse(
        "success",
        "Task deleted successfully",
        null,
        null
      )
    );
  } catch (error) {
    console.error("Error deleting task:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to delete task", null, error.message)
    );
  }
};

export const getPublicTasksByEmployee = async (req, res) => {
  try {
    const { employeeId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    const allTasks = await Task.find({
      assignedEmployees: { $in: [employeeId] },
    })
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .populate("comments.employeeId", "name employee_id")
      .sort({ createdAt: -1 });

    const list = allTasks.map((doc) => {
      const o = doc.toObject();
      ensureAssignmentsArray(o);
      return { ...o, ...progressMeta(o) };
    });

    return res.status(200).json(
      generateResponse(
        "success",
        "Tasks retrieved successfully",
        {
          assignedTasks: list,
          globalTasks: list,
        },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching public tasks:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch tasks", null, error.message)
    );
  }
};

export const addPublicTaskComment = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name, comment, statusUpdate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid task ID format", null, null)
      );
    }

    if (!name || !comment) {
      return res.status(400).json(
        generateResponse("error", "Name and comment are required", null, null)
      );
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }

      const isAssigned = task.assignedEmployees.some(
        (id) => id.toString() === employeeId.toString()
      );
      if (!isAssigned) {
        return res.status(403).json(
          generateResponse("error", "Employee is not assigned to this task", null, null)
        );
      }
    }

    const newComment = {
      employeeId: employeeId || null,
      name,
      comment,
      statusUpdate: statusUpdate || undefined,
      createdAt: new Date(),
    };

    task.comments.push(newComment);

    if (statusUpdate && statusUpdate !== task.status) {
      task.status = statusUpdate;
      rollupTaskStatusFromAssignments(task);
    }

    task.updatedAt = new Date();
    await task.save();

    await task.populate("assignedEmployees", "name employee_id email phoneNumber department");
    await task.populate("comments.employeeId", "name employee_id");

    return res.status(201).json(
      generateResponse(
        "success",
        "Comment added successfully",
        { task },
        null
      )
    );
  } catch (error) {
    console.error("Error adding public task comment:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to add comment", null, error.message)
    );
  }
};
