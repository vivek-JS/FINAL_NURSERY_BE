import Task from "../models/task.model.js";
import Employee from "../models/user.model.js";
import generateResponse from "../utility/responseFormat.js";
import mongoose from "mongoose";

export const createTask = async (req, res) => {
  try {
    const { title, description, dueDate, dueTime, priority, assignedEmployees } = req.body;

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

    // Validate all employee IDs
    const invalidIds = assignedEmployees.filter(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length > 0) {
      return res.status(400).json(
        generateResponse("error", `Invalid employee ID format: ${invalidIds.join(", ")}`, null, null)
      );
    }

    // Verify all employees exist
    const employees = await Employee.find({ _id: { $in: assignedEmployees } });
    if (employees.length !== assignedEmployees.length) {
      return res.status(404).json(
        generateResponse("error", "One or more assigned employees not found", null, null)
      );
    }

    const newTask = new Task({
      title,
      description: description || "",
      dueDate,
      dueTime: dueTime || "",
      priority: priority || "medium",
      status: "pending",
      assignedEmployees,
      createdBy: req.user?._id,
    });

    await newTask.save();

    // Populate employee details for response
    await newTask.populate("assignedEmployees", "name employee_id email phoneNumber");

    return res.status(201).json(
      generateResponse(
        "success",
        "Task created and assigned successfully",
        { task: newTask },
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
    const { status, employeeId, createdBy, priority } = req.query;

    const query = {};

    if (status) {
      query.status = status;
    }

    if (priority) {
      query.priority = priority;
    }

    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }
      query.assignedEmployees = employeeId;
    }

    if (createdBy) {
      if (!mongoose.Types.ObjectId.isValid(createdBy)) {
        return res.status(400).json(
          generateResponse("error", "Invalid creator ID format", null, null)
        );
      }
      query.createdBy = createdBy;
    }

    const tasks = await Task.find(query)
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .sort({ createdAt: -1 });

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
      .populate("comments.employeeId", "name employee_id");

    if (!task) {
      return res.status(404).json(
        generateResponse("error", "Task not found", null, null)
      );
    }

    return res.status(200).json(
      generateResponse(
        "success",
        "Task retrieved successfully",
        { task },
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
    const { taskId } = req.params;
    const { title, description, dueDate, dueTime, priority, status, assignedEmployees } = req.body;

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

    // Update fields
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (dueTime !== undefined) task.dueTime = dueTime;
    if (priority !== undefined) task.priority = priority;

    // Handle status update
    if (status !== undefined) {
      task.status = status;
      if (status === "completed" && !task.completedAt) {
        task.completedAt = new Date();
      } else if (status !== "completed" && task.completedAt) {
        task.completedAt = undefined;
      }
    }

    // Handle employee assignment update
    if (assignedEmployees !== undefined) {
      if (!Array.isArray(assignedEmployees) || assignedEmployees.length === 0) {
        return res.status(400).json(
          generateResponse("error", "At least one employee must be assigned", null, null)
        );
      }

      const invalidIds = assignedEmployees.filter(id => !mongoose.Types.ObjectId.isValid(id));
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
    }

    task.updatedAt = new Date();
    await task.save();

    await task.populate("assignedEmployees", "name employee_id email phoneNumber department");

    return res.status(200).json(
      generateResponse(
        "success",
        "Task updated successfully",
        { task },
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

    // Verify employee is assigned to task
    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }

      const isAssigned = task.assignedEmployees.some(
        id => id.toString() === employeeId.toString()
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

    // Update task status if provided
    if (statusUpdate && statusUpdate !== task.status) {
      task.status = statusUpdate;
      if (statusUpdate === "completed" && !task.completedAt) {
        task.completedAt = new Date();
        if (employeeId) {
          task.completedBy.push({
            employeeId,
            completedAt: new Date(),
          });
        }
      } else if (statusUpdate === "pending" || statusUpdate === "in_progress") {
        // When undoing completion, clear completedAt and completedBy
        task.completedAt = undefined;
        if (employeeId) {
          // Remove this employee's completion entry
          task.completedBy = task.completedBy.filter(
            entry => entry.employeeId?.toString() !== employeeId.toString()
          );
        }
      }
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

// Public task endpoints (no authentication required)
export const getPublicTasksByEmployee = async (req, res) => {
  try {
    const { employeeId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    // Get tasks assigned to this employee
    const assignedTasks = await Task.find({ assignedEmployees: employeeId })
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .populate("comments.employeeId", "name employee_id")
      .sort({ createdAt: -1 });

    // Get all global tasks (tasks assigned to multiple employees including this one)
    const allTasks = await Task.find({ 
      assignedEmployees: { $in: [employeeId] }
    })
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .populate("comments.employeeId", "name employee_id")
      .sort({ createdAt: -1 });

    return res.status(200).json(
      generateResponse(
        "success",
        "Tasks retrieved successfully",
        {
          assignedTasks,
          globalTasks: allTasks,
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

    // Verify employee is assigned to task if employeeId is provided
    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json(
          generateResponse("error", "Invalid employee ID format", null, null)
        );
      }

      const isAssigned = task.assignedEmployees.some(
        id => id.toString() === employeeId.toString()
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

        // Update task status if provided
        if (statusUpdate && statusUpdate !== task.status) {
          task.status = statusUpdate;
          if (statusUpdate === "completed" && !task.completedAt) {
            task.completedAt = new Date();
            if (employeeId) {
              task.completedBy.push({
                employeeId,
                completedAt: new Date(),
              });
            }
          } else if (statusUpdate === "pending" || statusUpdate === "in_progress") {
            // When undoing completion, clear completedAt and completedBy
            task.completedAt = undefined;
            if (employeeId) {
              // Remove this employee's completion entry
              task.completedBy = task.completedBy.filter(
                entry => entry.employeeId?.toString() !== employeeId.toString()
              );
            }
          }
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


