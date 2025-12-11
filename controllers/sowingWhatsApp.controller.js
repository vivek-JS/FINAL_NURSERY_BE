import moment from "moment";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import PlantCms from "../models/plantCms.model.js";
import Order from "../models/order.model.js";
import Sowing from "../models/sowing.model.js";
import Farmer from "../models/farmer.model.js";
import catchAsync from "../utility/catchAsync.js";
import { sendWatiTemplateMessage } from "../utility/watiMessaging.js";

/**
 * Send sowing reminders via WhatsApp
 * Gets plant-wise reminders and formats them as WhatsApp messages
 */
export const sendSowingRemindersWhatsApp = catchAsync(async (req, res) => {
  try {
    const { plantId, farmerIds, includeAvailable } = req.body;

    if (!plantId) {
      return res.status(400).json({
        success: false,
        message: "Plant ID is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(plantId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Plant ID format",
      });
    }

    const today = moment().startOf("day");

    // Get plant-wise reminders with subtype breakdown
    const reminders = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      // Dynamically calculate totalBookedPlants from actual orders
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $addFields: {
          bookingGap: {
            $max: [
              0,
              {
                $subtract: [
                  "$totalBookedPlants",
                  "$primarySowed",
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotEndISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotEndISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $round: [
              {
                $divide: [
                  { $subtract: ["$sowByDateISO", today.toDate()] },
                  1000 * 60 * 60 * 24,
                ],
              },
              0,
            ],
          },
          priority: {
            $cond: [
              { $lt: [{ $round: [{ $divide: [{ $subtract: ["$sowByDateISO", today.toDate()] }, 1000 * 60 * 60 * 24] }, 0] }, 0] },
              "overdue",
              {
                $cond: [
                  { $lte: [{ $round: [{ $divide: [{ $subtract: ["$sowByDateISO", today.toDate()] }, 1000 * 60 * 60 * 24] }, 0] }, 2] },
                  "urgent",
                  "future",
                ],
              },
            ],
          },
        },
      },
      {
        $match: {
          bookingGap: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: {
            subtypeId: "$subtypeSlots.subtypeId",
            priority: "$priority",
          },
          subtypeName: { $first: { $ifNull: ["$subtypeDetails.name", "Subtype"] } },
          totalGap: { $sum: "$bookingGap" },
          slotCount: { $sum: 1 },
          sowByDates: { $push: "$sowByDateISO" },
        },
      },
      {
        $group: {
          _id: "$_id.subtypeId",
          subtypeName: { $first: "$subtypeName" },
          overdueGap: {
            $sum: {
              $cond: [{ $eq: ["$_id.priority", "overdue"] }, "$totalGap", 0]
            }
          },
          urgentGap: {
            $sum: {
              $cond: [{ $eq: ["$_id.priority", "urgent"] }, "$totalGap", 0]
            }
          },
          futureGap: {
            $sum: {
              $cond: [{ $eq: ["$_id.priority", "future"] }, "$totalGap", 0]
            }
          },
          totalGap: { $sum: "$totalGap" },
        },
      },
      {
        $sort: { overdueGap: -1, urgentGap: -1 },
      },
    ]);

    // Get date-wise sowing information for today and next 2 days
    const next3DaysSowing = await PlantSlot.aggregate([
      {
        $match: {
          plantId: new mongoose.Types.ObjectId(plantId),
        },
      },
      {
        $unwind: "$subtypeSlots",
      },
      {
        $unwind: "$subtypeSlots.slots",
      },
      {
        $lookup: {
          from: "plantcms",
          localField: "plantId",
          foreignField: "_id",
          as: "plantInfo",
        },
      },
      {
        $addFields: {
          plantInfo: { $arrayElemAt: ["$plantInfo", 0] },
        },
      },
      {
        $match: {
          "plantInfo.sowingAllowed": true,
        },
      },
      {
        $addFields: {
          subtypeDetails: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ["$plantInfo.subtypes", []] },
                  as: "subtype",
                  cond: { $eq: ["$$subtype._id", "$subtypeSlots.subtypeId"] },
                },
              },
              0,
            ],
          },
          slotId: "$subtypeSlots.slots._id",
          primarySowed: { $ifNull: ["$subtypeSlots.slots.primarySowed", 0] },
          totalPlants: { $ifNull: ["$subtypeSlots.slots.totalPlants", 0] },
          slotReadyDays: {
            $cond: [
              { $gt: [{ $ifNull: ["$subtypeSlots.slots.plantReadyDays", 0] }, 0] },
              "$subtypeSlots.slots.plantReadyDays",
              { $ifNull: ["$subtypeDetails.plantReadyDays", 0] },
            ],
          },
        },
      },
      {
        $lookup: {
          from: "orders",
          let: { slotId: "$slotId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingSlot", "$$slotId"] },
                    { $not: { $in: ["$orderStatus", ["CANCELLED", "REJECTED"]] } },
                    {
                      $or: [
                        { $ne: ["$quotaSource", "dealer"] },
                        { $not: { $ifNull: ["$quotaSource", false] } }
                      ]
                    }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                totalBookedPlants: { $sum: "$numberOfPlants" }
              }
            }
          ],
          as: "orderStats"
        }
      },
      {
        $addFields: {
          totalBookedPlants: {
            $ifNull: [
              { $arrayElemAt: ["$orderStats.totalBookedPlants", 0] },
              0
            ]
          }
        }
      },
      {
        $project: {
          orderStats: 0
        }
      },
      {
        $addFields: {
          bookingGap: {
            $max: [
              0,
              {
                $subtract: [
                  "$totalBookedPlants",
                  "$primarySowed",
                ],
              },
            ],
          },
          slotEndISO: {
            $dateFromString: {
              dateString: {
                $concat: [
                  { $substr: ["$subtypeSlots.slots.endDay", 6, 4] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 3, 2] },
                  "-",
                  { $substr: ["$subtypeSlots.slots.endDay", 0, 2] },
                ],
              },
              format: "%Y-%m-%d",
            },
          },
        },
      },
      {
        $addFields: {
          sowByDateISO: {
            $cond: [
              { $gt: ["$slotReadyDays", 0] },
              {
                $dateSubtract: {
                  startDate: "$slotEndISO",
                  unit: "day",
                  amount: "$slotReadyDays",
                },
              },
              "$slotEndISO",
            ],
          },
        },
      },
      {
        $addFields: {
          daysUntilSow: {
            $round: [
              {
                $divide: [
                  { $subtract: ["$sowByDateISO", today.toDate()] },
                  1000 * 60 * 60 * 24,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $match: {
          bookingGap: { $gt: 0 },
          daysUntilSow: { $gte: 0, $lte: 2 }, // Today (0), tomorrow (1), day after (2)
        },
      },
      {
        $group: {
          _id: {
            sowDate: "$sowByDateISO",
            subtypeId: "$subtypeSlots.subtypeId",
          },
          subtypeName: { $first: { $ifNull: ["$subtypeDetails.name", "Subtype"] } },
          totalGap: { $sum: "$bookingGap" },
        },
      },
      {
        $sort: { "_id.sowDate": 1 },
      },
    ]);

    // Calculate totals
    const totalPending = reminders.reduce((sum, r) => sum + r.totalGap, 0);
    const totalOverdue = reminders.reduce((sum, r) => sum + r.overdueGap, 0);

    // Format subtype-wise breakdown for overdue
    const subtypeBreakdown = reminders
      .filter((r) => r.overdueGap > 0)
      .map((r) => `${r.subtypeName}: ${r.overdueGap.toLocaleString()} plants`)
      .join("\n");

    // Format date-wise sowing for next 3 days (today + 2 days)
    const formatDate = (dateISO) => {
      if (!dateISO) return "";
      const date = moment(dateISO);
      return date.format("DD-MM-YYYY");
    };

    const getDayLabel = (daysUntil) => {
      if (daysUntil === 0) return "Today";
      if (daysUntil === 1) return "Tomorrow";
      // For day 2 and beyond, show the date
      const targetDate = moment(today).add(daysUntil, "days");
      return targetDate.format("DD-MM-YYYY");
    };

    // Group by date and format
    const dateWiseSowing = {};
    next3DaysSowing.forEach((item) => {
      const sowDate = item._id.sowDate;
      const daysUntil = moment(sowDate).diff(today, "days");
      const dateKey = daysUntil;
      
      if (!dateWiseSowing[dateKey]) {
        dateWiseSowing[dateKey] = {
          date: sowDate,
          dayLabel: getDayLabel(dateKey),
          items: [],
        };
      }
      
      dateWiseSowing[dateKey].items.push({
        subtypeName: item.subtypeName,
        totalGap: item.totalGap,
      });
    });

    // Calculate totals for today and tomorrow
    let todayTotal = 0;
    let tomorrowTotal = 0;
    let dayAfterTotal = 0;
    
    if (dateWiseSowing[0]) {
      todayTotal = dateWiseSowing[0].items.reduce((sum, item) => sum + item.totalGap, 0);
    }
    if (dateWiseSowing[1]) {
      tomorrowTotal = dateWiseSowing[1].items.reduce((sum, item) => sum + item.totalGap, 0);
    }
    if (dateWiseSowing[2]) {
      dayAfterTotal = dateWiseSowing[2].items.reduce((sum, item) => sum + item.totalGap, 0);
    }

    // Format date-wise sowing message with totals
    const dateWiseMessage = Object.keys(dateWiseSowing)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((key) => {
        const dayInfo = dateWiseSowing[key];
        const dayTotal = dayInfo.items.reduce((sum, item) => sum + item.totalGap, 0);
        const itemsText = dayInfo.items
          .map((item) => `${item.subtypeName}: ${item.totalGap.toLocaleString()} plants`)
          .join(", ");
        return `${dayInfo.dayLabel} (${formatDate(dayInfo.date)}): Total ${dayTotal.toLocaleString()} plants - ${itemsText}`;
      })
      .join("\n");

    // Combine overdue and date-wise information for parameter 4
    let combinedInfo = "";
    
    // Add totals summary
    if (todayTotal > 0 || tomorrowTotal > 0 || dayAfterTotal > 0) {
      combinedInfo += "Total Sowing: " + totalPending.toLocaleString() + " plants\n";
      if (todayTotal > 0) {
        combinedInfo += "Today's Sowing: " + todayTotal.toLocaleString() + " plants\n";
      }
      if (tomorrowTotal > 0) {
        combinedInfo += "Tomorrow's Sowing: " + tomorrowTotal.toLocaleString() + " plants\n";
      }
      if (dayAfterTotal > 0) {
        const dayAfterDate = formatDate(moment(today).add(2, "days").toDate());
        combinedInfo += dayAfterDate + " Sowing: " + dayAfterTotal.toLocaleString() + " plants\n";
      }
      combinedInfo += "\n";
    }
    
    // Add overdue if any
    if (subtypeBreakdown) {
      combinedInfo += "Overdue:\n" + subtypeBreakdown + "\n\n";
    }
    
    // Add detailed date-wise breakdown
    if (dateWiseMessage) {
      combinedInfo += "Date-wise Details:\n" + dateWiseMessage;
    }
    
    if (!combinedInfo) {
      combinedInfo = "No overdue or upcoming sowings";
    }

    // Get plant info
    const plant = await PlantCms.findById(plantId).select("name").lean();

    // Prepare message data - STRICTLY send to these 2 phone numbers only
    const messages = [];
    const allowedPhoneNumbers = ["7588686453", "7588686452"]; // Hardcoded numbers as per requirement

    // Get farmer details for these specific phone numbers
    const farmers = await Farmer.find({
      phoneNumber: { $in: allowedPhoneNumbers }
    }).select("name phoneNumber").lean();

    // Create a map for quick lookup
    const farmerMap = new Map();
    farmers.forEach(farmer => {
      farmerMap.set(farmer.phoneNumber.toString(), farmer);
    });

    // Always send to both numbers, even if farmer doesn't exist in DB
    for (const phoneNumber of allowedPhoneNumbers) {
      const farmer = farmerMap.get(phoneNumber) || null;
      const farmerName = farmer?.name || "Admin"; // Default name if farmer not found
      
      const message = formatSowingReminderMessage(
        farmerName,
        totalPending,
        totalOverdue,
        combinedInfo,
        plant?.name || "Plant"
      );
      
      messages.push({
        farmerId: farmer?._id || null,
        farmerName: farmerName,
        phoneNumber: phoneNumber,
        message,
        plantId,
        plantName: plant?.name || "Unknown",
      });
    }

    // If request has sendNow flag, actually send the messages via WhatsApp
    let sendResults = [];
    if (req.body.sendNow === true && messages.length > 0) {
      console.log(`📤 Sending ${messages.length} WhatsApp messages for plant: ${plant?.name}`);
      
      for (const messageData of messages) {
        try {
          // Format parameters for WATI template
          // Meta template format: {{1}}, {{2}}, {{3}}, {{4}}
          // Template message:
          // Hello {{1}},
          // Total pending plants: {{2}}
          // Previous overdue total: {{3}}
          // Subtype-wise overdue: {{4}}
          // Please prioritise sowing accordingly
          const parameters = [
            { name: "1", value: messageData.farmerName || "Farmer" },
            { name: "2", value: totalPending.toLocaleString() },
            { name: "3", value: totalOverdue.toLocaleString() },
            { name: "4", value: combinedInfo },
          ];

          // Send via WATI
          // Using approved template "sowing_alert" with placeholders {{1}}, {{2}}, {{3}}, {{4}}
          let sendResult;
          try {
            sendResult = await sendWatiTemplateMessage(
              messageData.phoneNumber,
              "sowing_alert", // Approved WATI template name
              parameters
            );
            
            // If template doesn't exist, log warning
            if (!sendResult.success && sendResult.error?.items?.[0]?.code === "Template") {
              console.log(`⚠️ Template "sowing_alert" not found. Please check template exists in WATI.`);
            }
          } catch (err) {
            console.error(`❌ Error sending via WATI:`, err);
            sendResult = { success: false, error: err.message };
          }

          // Format error message for better readability
          let errorMessage = null;
          if (!sendResult.success && sendResult.error) {
            if (sendResult.error.items && sendResult.error.items.length > 0) {
              const errorItem = sendResult.error.items[0];
              if (errorItem.code === "Template") {
                errorMessage = `Template "sowing_alert" not found in WATI. Please verify the template exists and is approved in your WATI dashboard.`;
              } else {
                errorMessage = errorItem.description || JSON.stringify(sendResult.error);
              }
            } else {
              errorMessage = typeof sendResult.error === 'string' ? sendResult.error : JSON.stringify(sendResult.error);
            }
          }

          sendResults.push({
            farmerId: messageData.farmerId,
            farmerName: messageData.farmerName,
            phoneNumber: messageData.phoneNumber,
            success: sendResult.success,
            error: errorMessage || sendResult.error || null,
            watiResponse: sendResult.data || null,
          });
        } catch (error) {
          console.error(`❌ Error sending message to ${messageData.farmerName}:`, error);
          sendResults.push({
            farmerId: messageData.farmerId,
            farmerName: messageData.farmerName,
            phoneNumber: messageData.phoneNumber,
            success: false,
            error: error.message,
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      plantInfo: {
        plantId,
        plantName: plant?.name || "Unknown",
      },
      summary: {
        totalPending,
        totalOverdue,
        subtypeCount: reminders.length,
      },
      subtypeBreakdown: reminders.map((r) => ({
        subtypeId: r._id,
        subtypeName: r.subtypeName,
        overdue: r.overdueGap,
        urgent: r.urgentGap,
        future: r.futureGap,
        total: r.totalGap,
      })),
      messages,
      messageCount: messages.length,
      sent: sendResults.length > 0,
      sendResults: sendResults.length > 0 ? sendResults : undefined,
      successCount: sendResults.filter((r) => r.success).length,
      failureCount: sendResults.filter((r) => !r.success).length,
    });
  } catch (error) {
    console.error("Error generating sowing reminders for WhatsApp:", error);
    return res.status(500).json({
      success: false,
      message: "Error generating sowing reminders",
      error: error.message,
    });
  }
});

/**
 * Format the sowing reminder message with template variables
 */
function formatSowingReminderMessage(
  farmerName,
  totalPending,
  totalOverdue,
  combinedInfo,
  plantName
) {
  const message = `Hello ${farmerName || "Farmer"},

Total pending plants: ${totalPending.toLocaleString()}

Previous overdue total: ${totalOverdue.toLocaleString()}

${combinedInfo || "No overdue or upcoming sowings"}

Please prioritise sowing accordingly`;

  return message;
}

