import Employee from "../models/user.model.js";
import FollowUpComment from "../models/followUpComment.model.js";
import Task from "../models/task.model.js";
import generateResponse from "../utility/responseFormat.js";
import { randomUUID } from "crypto";
import mongoose from "mongoose";

const getClientIp = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    "unknown"
  );
};

const maskIp = (ip) => {
  if (!ip || ip === "unknown") return "***.***.***.***";
  const parts = ip.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`;
  }
  return "***.***.***.***";
};

export const createFollowUp = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { title, description, followUpDate, dueTime, priority } = req.body;

    if (!title || !followUpDate) {
      return res.status(400).json(
        generateResponse("error", "Title and follow-up date are required", null, null)
      );
    }

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json(
        generateResponse("error", `Employee not found with ID: ${employeeId}`, null, null)
      );
    }

    const publicToken = randomUUID();

    const newFollowUp = {
      title,
      description: description || "",
      followUpDate,
      dueTime: dueTime || "",
      priority: priority || "medium",
      status: "pending",
      publicToken,
      createdBy: req.user?._id,
      createdAt: new Date(),
    };

    employee.followUps.push(newFollowUp);
    await employee.save();

    const createdFollowUp = employee.followUps[employee.followUps.length - 1];

    return res.status(201).json(
      generateResponse(
        "success",
        "Follow-up created successfully",
        {
          followUp: createdFollowUp,
          publicToken: publicToken,
        },
        null
      )
    );
  } catch (error) {
    console.error("Error creating follow-up:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to create follow-up", null, error.message)
    );
  }
};

export const getFollowUps = async (req, res) => {
  try {
    const { employeeId } = req.params;

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    const employee = await Employee.findById(employeeId).select("followUps name employee_id");
    if (!employee) {
      return res.status(404).json(
        generateResponse("error", `Employee not found with ID: ${employeeId}`, null, null)
      );
    }

    const followUps = employee.followUps || [];

    const followUpsWithLinks = followUps.map((followUp) => ({
      ...followUp.toObject(),
      publicToken: followUp.publicToken,
    }));

    const groupedByDate = followUpsWithLinks.reduce((acc, followUp) => {
      const date = followUp.followUpDate;
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(followUp);
      return acc;
    }, {});

    return res.status(200).json(
      generateResponse(
        "success",
        "Follow-ups retrieved successfully",
        {
          employee: {
            _id: employee._id,
            name: employee.name,
            employee_id: employee.employee_id,
          },
          followUps: followUpsWithLinks,
          groupedByDate,
        },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching follow-ups:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch follow-ups", null, error.message)
    );
  }
};

export const getAllFollowUps = async (req, res) => {
  try {
    const employees = await Employee.find({ "followUps.0": { $exists: true } })
      .select("name employee_id followUps")
      .lean();

    const allFollowUps = [];
    employees.forEach((employee) => {
      if (employee.followUps && employee.followUps.length > 0) {
        employee.followUps.forEach((followUp) => {
          allFollowUps.push({
            ...followUp,
            employeeName: employee.name,
            employeeId: employee._id,
            employee_id: employee.employee_id,
          });
        });
      }
    });

    // Calculate analytics
    const statusCounts = {
      pending: 0,
      completed: 0,
      incomplete: 0,
      not_done: 0,
    };

    const priorityCounts = {
      low: 0,
      medium: 0,
      high: 0,
      urgent: 0,
    };

    const dateWiseCounts = {};
    const employeeWiseCounts = {};

    allFollowUps.forEach((followUp) => {
      // Status counts
      if (statusCounts.hasOwnProperty(followUp.status)) {
        statusCounts[followUp.status]++;
      }

      // Priority counts
      if (priorityCounts.hasOwnProperty(followUp.priority)) {
        priorityCounts[followUp.priority]++;
      }

      // Date-wise counts
      const date = followUp.followUpDate;
      dateWiseCounts[date] = (dateWiseCounts[date] || 0) + 1;

      // Employee-wise counts
      const empName = followUp.employeeName || "Unknown";
      employeeWiseCounts[empName] = (employeeWiseCounts[empName] || 0) + 1;
    });

    // Prepare chart data
    const statusChartData = Object.keys(statusCounts).map((status) => ({
      name: status,
      value: statusCounts[status],
    }));

    const priorityChartData = Object.keys(priorityCounts).map((priority) => ({
      name: priority,
      value: priorityCounts[priority],
    }));

    const dateChartData = Object.keys(dateWiseCounts)
      .sort()
      .map((date) => ({
        date,
        count: dateWiseCounts[date],
      }));

    const employeeChartData = Object.keys(employeeWiseCounts)
      .map((name) => ({
        name,
        count: employeeWiseCounts[name],
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10 employees

    return res.status(200).json(
      generateResponse(
        "success",
        "All follow-ups retrieved successfully",
        {
          total: allFollowUps.length,
          followUps: allFollowUps,
          analytics: {
            statusCounts,
            priorityCounts,
            statusChartData,
            priorityChartData,
            dateChartData,
            employeeChartData,
          },
        },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching all follow-ups:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch follow-ups", null, error.message)
    );
  }
};

export const updateFollowUp = async (req, res) => {
  try {
    const { employeeId, followUpId } = req.params;
    const { title, description, followUpDate, dueTime, priority, status } = req.body;

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    if (!followUpId || !mongoose.Types.ObjectId.isValid(followUpId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid follow-up ID format", null, null)
      );
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json(
        generateResponse("error", `Employee not found with ID: ${employeeId}`, null, null)
      );
    }

    const followUp = employee.followUps.id(followUpId);
    if (!followUp) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    if (title !== undefined) followUp.title = title;
    if (description !== undefined) followUp.description = description;
    if (followUpDate !== undefined) followUp.followUpDate = followUpDate;
    if (dueTime !== undefined) followUp.dueTime = dueTime;
    if (priority !== undefined) followUp.priority = priority;
    if (status !== undefined) {
      followUp.status = status;
      if (status === "completed" && !followUp.completedAt) {
        followUp.completedAt = new Date();
      }
    }

    await employee.save();

    return res.status(200).json(
      generateResponse(
        "success",
        "Follow-up updated successfully",
        { followUp },
        null
      )
    );
  } catch (error) {
    console.error("Error updating follow-up:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to update follow-up", null, error.message)
    );
  }
};

export const deleteFollowUp = async (req, res) => {
  try {
    const { employeeId, followUpId } = req.params;

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid employee ID format", null, null)
      );
    }

    if (!followUpId || !mongoose.Types.ObjectId.isValid(followUpId)) {
      return res.status(400).json(
        generateResponse("error", "Invalid follow-up ID format", null, null)
      );
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json(
        generateResponse("error", `Employee not found with ID: ${employeeId}`, null, null)
      );
    }

    const followUp = employee.followUps.id(followUpId);
    if (!followUp) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    // Delete associated comments
    await FollowUpComment.deleteMany({
      employeeId: employee._id,
      followUpId: followUp._id,
    });

    // Remove follow-up from employee's array
    employee.followUps.pull(followUpId);
    await employee.save();

    return res.status(200).json(
      generateResponse(
        "success",
        "Follow-up deleted successfully",
        null,
        null
      )
    );
  } catch (error) {
    console.error("Error deleting follow-up:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to delete follow-up", null, error.message)
    );
  }
};

export const getPublicFollowUp = async (req, res) => {
  try {
    const { token } = req.params;

    const employee = await Employee.findOne({
      "followUps.publicToken": token,
    }).select("name employee_id followUps");

    if (!employee) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    const followUp = employee.followUps.find(
      (fu) => fu.publicToken === token
    );

    if (!followUp) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    const comments = await FollowUpComment.find({
      employeeId: employee._id,
      followUpId: followUp._id,
    })
      .sort({ createdAt: -1 })
      .select("name comment statusUpdate createdAt ip userAgent");

    const maskedComments = comments.map((comment) => ({
      ...comment.toObject(),
      ip: maskIp(comment.ip),
    }));

    // Fetch tasks assigned to this employee
    const employeeTasks = await Task.find({
      assignedEmployees: employee._id,
    })
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Fetch all global tasks (tasks with multiple employees or all tasks)
    const allTasks = await Task.find({})
      .populate("assignedEmployees", "name employee_id email phoneNumber department")
      .populate("createdBy", "name phoneNumber")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Filter global tasks (tasks assigned to multiple employees or all employees)
    const globalTasks = allTasks.filter(
      (task) => task.assignedEmployees.length > 1 || 
      (task.assignedEmployees.length === 1 && task.assignedEmployees[0]._id.toString() !== employee._id.toString())
    );

    return res.status(200).json(
      generateResponse(
        "success",
        "Follow-up retrieved successfully",
        {
          followUp: {
            _id: followUp._id,
            title: followUp.title,
            description: followUp.description,
            followUpDate: followUp.followUpDate,
            dueTime: followUp.dueTime,
            priority: followUp.priority,
            status: followUp.status,
            createdAt: followUp.createdAt,
            completedAt: followUp.completedAt,
          },
          employee: {
            name: employee.name,
            employee_id: employee.employee_id,
            _id: employee._id,
          },
          comments: maskedComments,
          tasks: {
            assigned: employeeTasks,
            global: globalTasks,
          },
        },
        null
      )
    );
  } catch (error) {
    console.error("Error fetching public follow-up:", error);
    return res.status(500).json(
      generateResponse("error", "Failed to fetch follow-up", null, error.message)
    );
  }
};

export const addPublicComment = async (req, res) => {
  try {
    const { token } = req.params;
    const { name, comment, statusUpdate } = req.body;

    if (!name || !comment) {
      return res.status(400).json(
        generateResponse("error", "Name and comment are required", null, null)
      );
    }

    const employee = await Employee.findOne({
      "followUps.publicToken": token,
    });

    if (!employee) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    const followUp = employee.followUps.find(
      (fu) => fu.publicToken === token
    );

    if (!followUp) {
      return res.status(404).json(
        generateResponse("error", "Follow-up not found", null, null)
      );
    }

    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    const newComment = new FollowUpComment({
      employeeId: employee._id,
      followUpId: followUp._id,
      name,
      comment,
      statusUpdate: statusUpdate || undefined,
      ip,
      userAgent,
    });

    await newComment.save();

    if (statusUpdate && statusUpdate !== followUp.status) {
      followUp.status = statusUpdate;
      if (statusUpdate === "completed" && !followUp.completedAt) {
        followUp.completedAt = new Date();
      }
      await employee.save();
    }

    return res.status(201).json(
      generateResponse(
        "success",
        "Comment added successfully",
        {
          comment: {
            ...newComment.toObject(),
            ip: maskIp(newComment.ip),
          },
        },
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







