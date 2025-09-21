import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import generateResponse from "../utility/responseFormat.js";
import APIFeatures from "../utility/apiFeatures.js";
import mongoose from "mongoose";
import PlantSlot from "../models/slots.model.js";
import DealerWallet from "../models/dealerWallet.js";
import { validateDealerQuota, allocateDealerQuota, restoreDealerQuota } from "./quota.controller.js";
import User from "../models/user.model.js";
import Tray from "../models/tray.model.js";
const updateDealerWalletBalance = async (dealerId, amount, description = "Manual wallet adjustment", performedBy = null) => {
  console.log(dealerId);
  const wallet = await DealerWallet.findOne({ dealer: dealerId });
  console.log(wallet);

  if (!wallet) {
    throw new Error("Dealer wallet not found");
  }

  // Convert both values to numbers for safe calculation
  const currentBalance = Number(wallet.availableAmount);
  const updateAmount = Number(amount);

  if (isNaN(currentBalance) || isNaN(updateAmount)) {
    throw new Error("Invalid amount values");
  }

  // Record transaction if amount is not zero
  if (updateAmount !== 0) {
    const transaction = await DealerWallet.addPayment(
      dealerId,
      updateAmount,
      description,
      performedBy || dealerId,
      "MANUAL_ADJUSTMENT",
      null
    );
    console.log("Transaction recorded:", transaction);
  }

  return wallet;
};
// Helper function to update dealer wallet entry
const updateDealerWallet = async (
  dealerId,
  plantType,
  subType,
  quantity,
  session
) => {
  let wallet = await DealerWallet.findOne({ dealer: dealerId }).session(
    session
  );

  if (!wallet) {
    wallet = new DealerWallet({
      dealer: dealerId,
      entries: [],
    });
  }

  const existingEntry = wallet.entries.find(
    (entry) =>
      entry.plantType.equals(plantType) && entry.subType.equals(subType)
  );

  if (existingEntry) {
    existingEntry.bookedQuantity += quantity;
  } else {
    wallet.entries.push({
      plantType,
      subType,
      quantity: 0,
      bookedQuantity: quantity,
      remainingQuantity: 0,
    });
  }

  await wallet.save({ session });
  return wallet;
};
export const updateSlot = async (
  bookingSlot,
  numberOfPlants,
  action = "subtract",
  allowOverflowOrSession = false,
  sessionParam = null
) => {
  // Handle parameter overloading - if 4th param is a session object, treat it as session
  let allowOverflow = false;
  let session = null;
  
  if (allowOverflowOrSession && typeof allowOverflowOrSession === 'object' && allowOverflowOrSession.startTransaction) {
    // 4th parameter is a session object
    session = allowOverflowOrSession;
    allowOverflow = false;
  } else if (typeof allowOverflowOrSession === 'boolean') {
    // 4th parameter is allowOverflow boolean
    allowOverflow = allowOverflowOrSession;
    session = sessionParam;
  }

  // console.log(
  //   `[updateSlot] START - Action: ${action}, Slot: ${bookingSlot}, Plants: ${numberOfPlants}, AllowOverflow: ${allowOverflow}`
  // );

  // Step 1: If subtracting, first check if enough plants are available (unless overflow is allowed)
  if (action === "subtract" && !allowOverflow) {
    console.log("hii")
    const currentSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": bookingSlot },
      { "subtypeSlots.$": 1 }
    );

    if (!currentSlot || !currentSlot.subtypeSlots[0]) {
      // console.error("[updateSlot] ERROR: Slot not found");
      throw new Error("Slot not found");
    }

    const targetSlot = currentSlot.subtypeSlots[0].slots.find(
      (slot) => slot._id.toString() === bookingSlot.toString()
    );

    if (!targetSlot) {
      // console.error("[updateSlot] ERROR: Specific slot not found");
      throw new Error("Specific slot not found");
    }

    // Calculate available plants considering buffer and already booked plants
    const effectiveBuffer = targetSlot.effectiveBuffer || targetSlot.buffer || 0;
    const bufferAmount = Math.round((targetSlot.totalPlants * effectiveBuffer) / 100);
    const bufferAdjustedCapacity = targetSlot.totalPlants - bufferAmount;
    const availablePlants = Math.max(0, bufferAdjustedCapacity - (targetSlot.totalBookedPlants || 0));
    
    if (numberOfPlants > availablePlants) {
      const slotDateInfo =
        targetSlot.startDay && targetSlot.endDay
          ? `Slot period: ${targetSlot.startDay} to ${targetSlot.endDay}`
          : targetSlot.month
          ? `Slot month: ${targetSlot.month}`
          : "";
      
      const errorMessage = availablePlants > 0 
        ? `Not enough plants available. Only ${availablePlants} plants available. Please book in other slots. ${slotDateInfo}`
        : `No plants available in this slot. Please book in other slots. ${slotDateInfo}`;
      
      throw new Error(errorMessage);
    }
  }

  // Step 2: Build the update operation based on the action
  const updateOperation = {};
  const additionalUpdates = {};
  
  if (action === "subtract") {
    // FIXED: Don't modify totalPlants when orders are added
    // totalPlants represents capacity and should remain constant
    // totalBookedPlants is calculated dynamically from orders
    
    // If overflow is allowed, check if this will put the slot into overflow state
    if (allowOverflow) {
      const currentSlot = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": bookingSlot },
        { "subtypeSlots.$": 1 }
      );
      
      if (currentSlot && currentSlot.subtypeSlots[0]) {
        const targetSlot = currentSlot.subtypeSlots[0].slots.find(
          (slot) => slot._id.toString() === bookingSlot.toString()
        );
        
        if (targetSlot) {
          // Calculate available plants considering buffer
          const effectiveBuffer = targetSlot.effectiveBuffer || 0;
          const bufferAmount = Math.round((targetSlot.totalPlants * effectiveBuffer) / 100);
          const bufferAdjustedCapacity = targetSlot.totalPlants - bufferAmount;
          const availablePlants = Math.max(0, bufferAdjustedCapacity - (targetSlot.totalBookedPlants || 0));
          
          // Check if this booking will cause overflow
          if (numberOfPlants > availablePlants) {
            additionalUpdates["subtypeSlots.$[subtypeSlot].slots.$[slot].isOverflow"] = true;
            additionalUpdates["subtypeSlots.$[subtypeSlot].slots.$[slot].overflow"] = true;
            console.warn(`Excel Import: Allowing overflow booking. Slot has ${targetSlot.totalPlants} plants capacity, ${availablePlants} available, booking ${numberOfPlants} plants. Slot period: ${targetSlot.startDay} to ${targetSlot.endDay}`);
          }
        }
      }
    }
  } else if (action === "add") {
    // FIXED: Don't modify totalPlants when orders are cancelled/removed
    // totalPlants represents capacity and should remain constant
    // totalBookedPlants is calculated dynamically from orders
    
    // If overflow is allowed, check if this will bring the slot out of overflow state
    if (allowOverflow) {
      const currentSlot = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": bookingSlot },
        { "subtypeSlots.$": 1 }
      );
      
      if (currentSlot && currentSlot.subtypeSlots[0]) {
        const targetSlot = currentSlot.subtypeSlots[0].slots.find(
          (slot) => slot._id.toString() === bookingSlot.toString()
        );
        
        if (targetSlot) {
          // Calculate available plants after this addition
          const effectiveBuffer = targetSlot.effectiveBuffer || 0;
          const bufferAmount = Math.round((targetSlot.totalPlants * effectiveBuffer) / 100);
          const bufferAdjustedCapacity = targetSlot.totalPlants - bufferAmount;
          const newAvailablePlants = Math.max(0, bufferAdjustedCapacity - (targetSlot.totalBookedPlants || 0) + numberOfPlants);
          
          if (newAvailablePlants >= 0 && targetSlot.isOverflow) {
            additionalUpdates["subtypeSlots.$[subtypeSlot].slots.$[slot].isOverflow"] = false;
            additionalUpdates["subtypeSlots.$[subtypeSlot].slots.$[slot].overflow"] = false;
          }
        }
      }
    }
  }

  // Step 3: Perform an atomic update in the database using $inc and $set
  const updateOptions = {
    arrayFilters: [
      { "subtypeSlot.slots._id": bookingSlot }, // Filter for the correct subtypeSlot
      { "slot._id": bookingSlot }, // Filter for the correct slot
    ],
  };

  // Add session to options if provided
  if (session) {
    updateOptions.session = session;
  }

  const updateResult = await PlantSlot.updateOne(
    { "subtypeSlots.slots._id": bookingSlot },
    {
      // FIXED: Don't modify totalPlants - it represents capacity and should remain constant
      // Only update overflow flags if needed
      ...(Object.keys(additionalUpdates).length > 0 && { $set: additionalUpdates })
    },
    updateOptions
  );

  // console.log(`[updateSlot] Update Result: ${JSON.stringify(updateResult)}`);

  // Step 4: Check if the update was successful
  if (updateResult.matchedCount === 0) {
    // console.error("[updateSlot] ERROR: Slot not found or update failed");
    throw new Error("Failed to update the PlantSlot details");
  }

  // console.log("[updateSlot] SUCCESS: Slot updated successfully");
  return updateResult; // Return the update result for reference
};

// Modified createOne function to handle componyQuota flag
const createOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    if (modelName === "Order") {
      const {
        payment,
        bookingSlot,
        numberOfPlants,
        cavity,
        orderRemarks,
        componyQuota, // Added this field to destructure from request body
        ...orderData
      } = req.body;
      console.log(req?.body);

      if (!bookingSlot || !numberOfPlants) {
        return res.status(400).json({
          message: "bookingSlot and numberOfPlants are required",
        });
      }

      // Using session for transaction
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Check if salesPerson exists and get their details
        const salesPerson = await User.findById(orderData.salesPerson).session(
          session
        );
        if (!salesPerson) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            message: "Sales person not found",
          });
        }

        // Get the highest orderId
        const lastOrder = await Model.findOne()
          .sort({ orderId: -1 })
          .select("orderId")
          .session(session);

        const orderId = lastOrder ? lastOrder.orderId + 1 : 1;

        // Handle cavity lookup by cavity number
        let trayId = null;
        if (cavity) {
          // Convert to number if it's a string
          let cavityValue = cavity;
          if (typeof cavityValue === "string") {
            cavityValue = parseInt(cavityValue.trim(), 10);
          }

          // Find matching tray by cavity number
          const tray = await Tray.findOne({ cavity: cavityValue }).session(
            session
          );
          if (tray) {
            trayId = tray._id;
          }
        }

        // Case 1: If it's a dealer's own order (creating stock)
        if (orderData.dealerOrder) {
          // Update slot first
          try {
            await updateSlot(bookingSlot, numberOfPlants, "subtract", session);
          } catch (slotError) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
              message: slotError.message || "Failed to update slot",
            });
          }

          // Add to dealer wallet
          let wallet = await DealerWallet.findOne({
            dealer: orderData.dealer,
          }).session(session);
          if (!wallet) {
            wallet = new DealerWallet({
              dealer: orderData.dealer,
              entries: [],
            });
          }

          // Find or create entry for this slot
          const entry = wallet.entries.find(
            (e) =>
              e.plantType?.equals(orderData.plantName) &&
              e.subType?.equals(orderData.plantSubtype) &&
              e.bookingSlot?.equals(bookingSlot)
          );

          if (entry) {
            entry.quantity += numberOfPlants;
          } else {
            wallet.entries.push({
              plantType: orderData.plantName,
              subType: orderData.plantSubtype,
              bookingSlot,
              quantity: numberOfPlants,
              bookedQuantity: 0,
              remainingQuantity: numberOfPlants,
            });
          }

          await wallet.save({ session });
        }
        // Case 1.5: If it's a dealer order with componyQuota=true (new case)
        else if (salesPerson.jobTitle === "DEALER" && componyQuota === true) {
          // Execute this code when DEALER selects company quota option
          await updateSlot(bookingSlot, numberOfPlants, "subtract", session);
        }
        // Case 2: If it's a farmer order through a dealer
        else if (salesPerson.jobTitle === "DEALER") {
          // Check if dealer quota is explicitly selected
          if (componyQuota === false) {
            // Dealer quota selected - ONLY use dealer quota, don't touch slot
            const quotaValidation = await validateDealerQuota(
              salesPerson._id,
              orderData.plantName,
              orderData.plantSubtype,
              bookingSlot,
              numberOfPlants
            );

            if (!quotaValidation.isValid) {
              await session.abortTransaction();
              session.endSession();
              return res.status(400).json({
                message: quotaValidation.message,
              });
            }

            // Allocate dealer quota ONLY
            const quotaAllocation = await allocateDealerQuota(
              salesPerson._id,
              orderData.plantName,
              orderData.plantSubtype,
              bookingSlot,
              numberOfPlants,
              session
            );

            // Store quota allocation in order data
            orderData.quotaUsed = quotaAllocation.fromWallet;
            orderData.quotaSource = "dealer";
            orderData.originalQuotaAllocation = quotaAllocation;

            // NO slot update - dealer quota only
          } else {
            // Company quota selected (default) - use slot allocation logic
            const allocation = await handleQuantityAllocation(
              salesPerson._id,
              orderData.plantName,
              orderData.plantSubtype,
              bookingSlot,
              numberOfPlants,
              session
            );

            if (allocation.fromSlot > 0) {
              await updateSlot(
                bookingSlot,
                allocation.fromSlot,
                "subtract",
                session
              );
            }

            // Set dealer in orderData
            orderData.dealer = salesPerson._id;
          }
        }
        // Case 2.5: If dealer is selected but salesPerson is not a dealer (e.g., office staff selects dealer)
        else if (orderData.dealer && !componyQuota) {
          // Validate dealer quota before creating order
          const quotaValidation = await validateDealerQuota(
            orderData.dealer,
            orderData.plantName,
            orderData.plantSubtype,
            bookingSlot,
            numberOfPlants
          );

          if (!quotaValidation.isValid) {
            throw new AppError(quotaValidation.message, 400);
          }

          // Allocate dealer quota
          const quotaAllocation = await allocateDealerQuota(
            orderData.dealer,
            orderData.plantName,
            orderData.plantSubtype,
            bookingSlot,
            numberOfPlants,
            session
          );

          // Store quota allocation in order data
          orderData.quotaUsed = quotaAllocation.fromWallet;
          orderData.quotaSource = "dealer";
          orderData.originalQuotaAllocation = quotaAllocation;

          // Update slot if needed
          if (quotaAllocation.fromSlot > 0) {
            await updateSlot(
              bookingSlot,
              quotaAllocation.fromSlot,
              "subtract",
              session
            );
          }
        }
        // Case 3: Regular farmer order
        else {
          await updateSlot(bookingSlot, numberOfPlants, "subtract", session);
        }

        // Prepare initial status change record if provided
        const statusChanges = [];
        if (orderData.orderStatus) {
          statusChanges.push({
            previousStatus: "PENDING", // Use the actual default status
            newStatus: orderData.orderStatus,
            reason: orderData.statusChangeReason || "Initial order creation",
            changedBy: req.user ? req.user._id : null,
            notes: orderData.statusChangeNotes || "",
          });
        }

        // Prepare remarks array if provided
        let processedRemarks = [];
        if (orderRemarks) {
          if (typeof orderRemarks === "string") {
            // If a single string, convert to array
            processedRemarks = [orderRemarks];
          } else if (Array.isArray(orderRemarks)) {
            // If already an array, use as is
            processedRemarks = orderRemarks;
          }
        }

        // Initialize remaining plants
        const remainingPlants = numberOfPlants;

        // Process payment data if provided
        let paymentArray = [];
        if (payment && Array.isArray(payment) && payment.length > 0) {
          paymentArray = payment.map(paymentItem => ({
            paidAmount: Number(paymentItem.paidAmount) || 0,
            paymentStatus: "PENDING", // Always PENDING for new payments
            paymentDate: paymentItem.paymentDate || new Date(),
            bankName: paymentItem.bankName || "",
            receiptPhoto: paymentItem.receiptPhoto || [],
            modeOfPayment: paymentItem.modeOfPayment || "",
            remark: paymentItem.remark || "",
            isWalletPayment: paymentItem.isWalletPayment || false
          }));
        }

        // Create the Order with all new fields
        const order = await Model.create(
          [
            {
              ...orderData,
              bookingSlot,
              numberOfPlants,
              remainingPlants, // Initialize with same as numberOfPlants
              orderId,
              cavity: trayId, // Use the looked up tray ID
              statusChanges, // Include initial status change if applicable
              orderRemarks: processedRemarks, // Include remarks if provided
              returnedPlants: 0, // Initialize with zero returned plants
              returnHistory: [], // Initialize with empty return history
              deliveryChanges: [], // Initialize with empty delivery changes history
              componyQuota, // Include the componyQuota flag in the order document
              payment: paymentArray, // Include payment data if provided
            },
          ],
          { session }
        );

        // Add order to slot's orders array
        await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": bookingSlot },
          { 
            $push: { 
              "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": order[0]._id 
            }
          },
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": bookingSlot },
              { "slot._id": bookingSlot }
            ],
            session: session
          }
        );

        // Process wallet transactions for payments if any
        let walletTransactions = [];
        if (paymentArray.length > 0) {
          // Get dealer ID from order
          let dealerId = order[0].dealer;
          
          // If no dealer field, check if salesPerson is a dealer
          if (!dealerId && order[0].salesPerson) {
            try {
              const salesPerson = await User.findById(order[0].salesPerson).session(session);
              if (salesPerson && salesPerson.jobTitle === 'DEALER') {
                dealerId = salesPerson._id;
              }
            } catch (error) {
              console.error("Error fetching sales person:", error);
            }
          }

          if (dealerId) {
            for (const paymentItem of paymentArray) {
              try {
                // Determine transaction type and amount
                let walletAmount = 0;
                let description = "";

                // Wallet impact based on payment type and status
                if (paymentItem.isWalletPayment && paymentItem.paymentStatus === "PENDING") {
                  // Deduct from wallet (negative amount) - when dealer pays from wallet
                  walletAmount = -paymentItem.paidAmount;
                  description = `Wallet payment for Order #${order[0]._id}`;
                } else if (order[0].dealerOrder && paymentItem.paymentStatus === "COLLECTED") {
                  // Add to wallet (positive amount) - when payment is collected from dealer
                  walletAmount = paymentItem.paidAmount;
                  description = `Payment collected for Order #${order[0]._id} via ${paymentItem.modeOfPayment}`;
                }

                // If there's a wallet impact, record the transaction
                if (walletAmount !== 0) {
                  const performedBy = req.user?._id || dealerId;
                  
                  const transaction = await DealerWallet.addPayment(
                    dealerId,
                    walletAmount,
                    description,
                    performedBy,
                    "ORDER_PAYMENT",
                    order[0]._id,
                    session
                  );

                  if (transaction) {
                    walletTransactions.push(transaction);
                  }
                }
              } catch (walletError) {
                console.error("Error processing wallet transaction for payment:", walletError);
                // Don't fail the order creation, just log the error
              }
            }
          }
        }

        await session.commitTransaction();
        session.endSession();

        const response = generateResponse(
          "Success",
          `${modelName} created successfully with ${paymentArray.length} payment(s)`,
          {
            order: order[0],
            payments: paymentArray,
            walletTransactions: walletTransactions
          },
          undefined
        );

        return res.status(201).json(response);
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          message: error.message,
          type: error.name === "AppError" ? error.type : "UNKNOWN_ERROR",
        });
      }
    }

    const doc = await Model.create(req.body);
    if (doc.password) doc.password = undefined;

    const response = generateResponse(
      "Success",
      `${modelName} created successfully`,
      doc,
      undefined
    );

    return res.status(201).json(response);
  });
const { isValidObjectId } = mongoose;

const updateOne = (Model, modelName, allowedFields) =>
  catchAsync(async (req, res, next) => {
    const { id } = req.body;

    if (!isValidObjectId(id)) {
      return next(new AppError("Invalid ID format", 400));
    }

    if (modelName !== "Order") {
      const doc = await Model.findByIdAndUpdate(id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!doc) {
        return next(new AppError("No document found with that ID", 404));
      }

      return res
        .status(200)
        .json(
          generateResponse("Success", `${modelName} updated successfully`, doc)
        );
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const existingDoc = await Model.findById(id)
        .populate("plantName")
        // Remove the direct plantSubtype populate
        .populate("salesPerson")
        .session(session);

      // Find the matching subtype from the populated plantName document
      let plantSubtypeData = null;
      if (existingDoc.plantName && existingDoc.plantSubtype) {
        plantSubtypeData = existingDoc.plantName.subtypes.find(
          (subtype) =>
            subtype._id.toString() === existingDoc.plantSubtype.toString()
        );
      }
      if (!existingDoc) {
        throw new AppError("No document found with that ID", 404);
      }

      const filteredBody = Object.keys(req.body)
        .filter((key) => allowedFields.includes(key))
        .reduce((obj, key) => {
          obj[key] = req.body[key];
          return obj;
        }, {});

      // Handle special fields updates

      // Special handling for orderRemarks - append if it's an array or a string
      if (filteredBody.orderRemarks !== undefined) {
        // If we're adding a single remark (string)
        if (typeof filteredBody.orderRemarks === "string") {
          // Use $push to add to existing array or create new array
          filteredBody.$push = {
            orderRemarks: filteredBody.orderRemarks,
          };
          // Remove the original field to avoid conflict
          delete filteredBody.orderRemarks;
        }
        // If we're replacing the entire array (array), keep as is
      }

      // Special handling for statusChanges - update with user info
      if (
        filteredBody.orderStatus &&
        filteredBody.orderStatus !== existingDoc.orderStatus
      ) {
        // Allow direct updating of statusChanges array if provided
        if (!filteredBody.statusChanges) {
          // Create a status change record if none provided
          const statusChange = {
            previousStatus: existingDoc.orderStatus,
            newStatus: filteredBody.orderStatus,
            reason: filteredBody.statusChangeReason || "",
            notes: filteredBody.statusChangeNotes || "",
            changedBy: req.user ? req.user._id : null,
          };

          // Use $push to add to existing array
          if (!filteredBody.$push) filteredBody.$push = {};
          filteredBody.$push.statusChanges = statusChange;

          // Remove temporary fields
          delete filteredBody.statusChangeReason;
          delete filteredBody.statusChangeNotes;
        }
      }

      // Special handling for deliveryChanges - track booking slot changes
      if (
        filteredBody.bookingSlot &&
        filteredBody.bookingSlot.toString() !==
          existingDoc.bookingSlot.toString()
      ) {
        // Get the original and new booking slot details
        const oldSlotDetails = await mongoose
          .model("PlantSlot")
          .findOne(
            { "subtypeSlots.slots._id": existingDoc.bookingSlot },
            { "subtypeSlots.slots.$": 1 }
          )
          .session(session);

        const newSlotDetails = await mongoose
          .model("PlantSlot")
          .findOne(
            { "subtypeSlots.slots._id": filteredBody.bookingSlot },
            { "subtypeSlots.slots.$": 1 }
          )
          .session(session);

        if (oldSlotDetails && newSlotDetails) {
          const oldSlot = oldSlotDetails.subtypeSlots[0].slots[0];
          const newSlot = newSlotDetails.subtypeSlots[0].slots[0];

          const deliveryChange = {
            previousDeliveryDate: {
              startDay: oldSlot.startDay,
              endDay: oldSlot.endDay,
              month: oldSlot.month,
              year: new Date().getFullYear(),
            },
            newDeliveryDate: {
              startDay: newSlot.startDay,
              endDay: newSlot.endDay,
              month: newSlot.month,
              year: new Date().getFullYear(),
            },
            previousSlot: existingDoc.bookingSlot,
            newSlot: filteredBody.bookingSlot,
            reasonForChange:
              filteredBody.deliveryChangeReason || "Delivery date changed",
            changedBy: req.user ? req.user._id : null,
          };

          // Use $push to add to existing array
          if (!filteredBody.$push) filteredBody.$push = {};
          filteredBody.$push.deliveryChanges = deliveryChange;

          // Remove temporary field
          delete filteredBody.deliveryChangeReason;
        }
      }

      // Special handling for farmReadyDate - track farm ready date changes
      if (
        filteredBody.farmReadyDate &&
        (!existingDoc.farmReadyDate || 
         new Date(filteredBody.farmReadyDate).toDateString() !== existingDoc.farmReadyDate.toDateString())
      ) {
        const farmReadyDateChange = {
          previousDate: existingDoc.farmReadyDate || null,
          newDate: new Date(filteredBody.farmReadyDate),
          reason: filteredBody.farmReadyDateChangeReason || "Farm ready date updated",
          changedBy: req.user ? req.user._id : null,
          notes: filteredBody.farmReadyDateChangeNotes || "",
        };

        // Use $push to add to existing array
        if (!filteredBody.$push) filteredBody.$push = {};
        filteredBody.$push.farmReadyDateChanges = farmReadyDateChange;

        // Remove temporary fields
        delete filteredBody.farmReadyDateChangeReason;
        delete filteredBody.farmReadyDateChangeNotes;
      }

      // Update remainingPlants field if numberOfPlants is being updated
      if (
        filteredBody.numberOfPlants &&
        filteredBody.numberOfPlants !== existingDoc.numberOfPlants
      ) {
        // Calculate new remainingPlants
        const returnedPlants = existingDoc.returnedPlants || 0;
        filteredBody.remainingPlants = Math.max(
          0,
          filteredBody.numberOfPlants - returnedPlants
        );
      }

      // Handle dealer wallet updates for rejected orders
      if (
        !existingDoc.dealerOrder &&
        existingDoc.salesPerson?.jobTitle === "DEALER" &&
        filteredBody.orderStatus === "REJECTED"
      ) {
        let wallet = await DealerWallet.findOne({
          dealer: existingDoc.salesPerson._id,
        }).session(session);

        if (wallet) {
          // Find entry for this plant type and subtype combination
          const entry = wallet.entries.find(
            (e) =>
              e.plantType?.equals(existingDoc.plantName._id) &&
              e.subType?.equals(existingDoc.plantSubtype._id) &&
              e.bookingSlot?.equals(existingDoc.bookingSlot)
          );

          if (entry) {
            // Calculate total collected payments
            const totalCollectedAmount = existingDoc.payment
              .filter((payment) => payment.paymentStatus === "COLLECTED")
              .reduce(
                (sum, payment) => sum + (Number(payment.paidAmount) || 0),
                0
              );

            if (totalCollectedAmount > 0) {
              // Reduce booked quantity and add back to quantity
              if (entry.bookedQuantity >= existingDoc.numberOfPlants) {
                entry.bookedQuantity -= existingDoc.numberOfPlants;
              }
            }
            await wallet.save({ session });
          }
        }
      }

      // Handle quota restoration for dealer orders when rejected
      if (
        existingDoc.dealerOrder &&
        filteredBody.orderStatus === "REJECTED" &&
        !existingDoc.quotaRestored
      ) {
        try {
          const quotaRestoration = await restoreDealerQuota(existingDoc._id, session);
          if (quotaRestoration.success) {
            console.log(`✅ Quota restored for order ${existingDoc._id}: ${quotaRestoration.message}`);
          } else {
            console.log(`⚠️  Quota restoration failed for order ${existingDoc._id}: ${quotaRestoration.message}`);
          }
        } catch (error) {
          console.error(`❌ Error restoring quota for order ${existingDoc._id}:`, error);
          // Don't throw error here, just log it
        }
      }



      // Handle payment updates
      if (
        !existingDoc.dealerOrder &&
        existingDoc.salesPerson?.jobTitle === "DEALER" &&
        filteredBody.payment
      ) {
        const newPayments = filteredBody.payment;
        for (const payment of newPayments) {
          if (payment.paymentStatus === "COLLECTED") {
            let wallet = await DealerWallet.findOne({
              dealer: existingDoc.salesPerson._id,
            }).session(session);
            if (wallet) {
              const entry = wallet.entries.find(
                (e) =>
                  e.plantType?.equals(existingDoc.plantName._id) &&
                  e.subType?.equals(existingDoc.plantSubtype._id) &&
                  e.bookingSlot?.equals(existingDoc.bookingSlot)
              );

              if (entry) {
                entry.bookedQuantity += existingDoc.numberOfPlants;
                await wallet.save({ session });
              }
            }
          }
        }
      }

      // --- AUTOMATIC DEALER QUOTA UPDATE LOGIC ---
      // Only for dealer orders
      if (modelName === "Order" && existingDoc.dealerOrder && filteredBody.orderStatus && filteredBody.orderStatus !== existingDoc.orderStatus) {
        const dealerId = existingDoc.salesPerson?._id?.toString();
        if (dealerId) {
          // Find the dealer wallet
          let dealerWallet = await DealerWallet.findOne({ dealer: dealerId }).session(session);
          if (!dealerWallet) {
            dealerWallet = new DealerWallet({ dealer: dealerId, entries: [] });
          }
          // Helper to find matching entry
          const findEntryIndex = () => dealerWallet.entries.findIndex(e =>
            e.plantType?.toString() === existingDoc.plantName?._id?.toString() &&
            e.subType?.toString() === existingDoc.plantSubtype?.toString() &&
            e.bookingSlot?.toString() === existingDoc.bookingSlot?.toString()
          );
          const entryIdx = findEntryIndex();
          // If changing to ACCEPTED, add quota
          if (filteredBody.orderStatus === "ACCEPTED") {
            if (entryIdx === -1) {
              dealerWallet.entries.push({
                plantType: existingDoc.plantName?._id,
                subType: existingDoc.plantSubtype,
                bookingSlot: existingDoc.bookingSlot,
                quantity: existingDoc.numberOfPlants,
                bookedQuantity: 0,
                remainingQuantity: existingDoc.numberOfPlants
              });
            } else {
              // If entry exists, increase quantity
              dealerWallet.entries[entryIdx].quantity += existingDoc.numberOfPlants;
              dealerWallet.entries[entryIdx].remainingQuantity += existingDoc.numberOfPlants;
            }
          }
          // If changing from ACCEPTED to something else, remove quota
          if (existingDoc.orderStatus === "ACCEPTED" && filteredBody.orderStatus !== "ACCEPTED") {
            if (entryIdx !== -1) {
              dealerWallet.entries[entryIdx].quantity -= existingDoc.numberOfPlants;
              dealerWallet.entries[entryIdx].remainingQuantity -= existingDoc.numberOfPlants;
              // Remove entry if quantity is zero or less
              if (dealerWallet.entries[entryIdx].quantity <= 0) {
                dealerWallet.entries.splice(entryIdx, 1);
              }
            }
          }
          await dealerWallet.save({ session });
        }
      }
      // --- END DEALER QUOTA LOGIC ---

      // Handle slot updates - Modified to work within the transaction
      if (filteredBody.bookingSlot || filteredBody.numberOfPlants) {
        try {
          // Modified handleSlotUpdates to use the session
          await handleSlotUpdatesWithSession(
            existingDoc,
            filteredBody,
            session
          );
        } catch (error) {
          await session.abortTransaction();
          session.endSession();
          return next(error);
        }
      }

      // Update document with filtered body and any accumulated $push operations
      const updateOperation = { ...filteredBody, $inc: { __v: 1 } };

      const updatedDoc = await Model.findOneAndUpdate(
        {
          _id: id,
          __v: existingDoc.__v,
        },
        updateOperation,
        {
          new: true,
          runValidators: true,
          session,
        }
      );

      if (!updatedDoc) {
        throw new AppError(
          "Document was modified by another process. Please try again.",
          409
        );
      }

      await session.commitTransaction();
      session.endSession();

      return res
        .status(200)
        .json(
          generateResponse(
            "Success",
            `${modelName} updated successfully`,
            updatedDoc
          )
        );
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      return next(error);
    }
  });

// Modified helper function that works with a session
const handleSlotUpdatesWithSession = async (
  existingDoc,
  filteredBody,
  session
) => {
  const { bookingSlot, numberOfPlants } = filteredBody;

  try {
    // Check slot availability before any updates
    const checkSlotAvailability = async (slotId, plantsNeeded) => {
      const currentSlot = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": slotId },
        { "subtypeSlots.$": 1 }
      ).session(session);

      if (!currentSlot?.subtypeSlots?.[0]?.slots) {
        throw new AppError("Slot not found", 404);
      }

      const slot = currentSlot.subtypeSlots[0].slots.find(
        (s) => s._id.toString() === slotId.toString()
      );

      if (!slot) {
        throw new AppError("Specific slot not found", 404);
      }

      // Calculate available plants considering buffer and already booked plants
      const effectiveBuffer = slot.effectiveBuffer || slot.buffer || 0;
      const bufferAmount = Math.round((slot.totalPlants * effectiveBuffer) / 100);
      const bufferAdjustedCapacity = slot.totalPlants - bufferAmount;
      const availablePlants = Math.max(0, bufferAdjustedCapacity - (slot.totalBookedPlants || 0));
      
      if (plantsNeeded > availablePlants) {
        const slotDateInfo =
          slot.startDay && slot.endDay
            ? `Slot period: ${slot.startDay} to ${slot.endDay}`
            : slot.month
            ? `Slot month: ${slot.month}`
            : "";
        
        const errorMessage = availablePlants > 0 
          ? `Not enough plants available in slot. Only ${availablePlants} plants available. Please book in other slots. ${slotDateInfo}`
          : `No plants available in this slot. Please book in other slots. ${slotDateInfo}`;
        
        throw new AppError(errorMessage, 400);
      }
    };

    // Modified updateSlot function that works with a session
    const updateSlotWithSession = async (slotId, plantsCount, action) => {
      // FIXED: Don't modify totalPlants - it represents capacity and should remain constant
      // totalBookedPlants is calculated dynamically from orders, so we don't need to update it here either
      
      // Since we're not modifying any slot fields directly, just return success
      // The slot data will be updated when orders are created/updated and the API recalculates
      
      return { matchedCount: 1, modifiedCount: 0 };
    };

    if (
      bookingSlot &&
      bookingSlot.toString() !== existingDoc.bookingSlot.toString()
    ) {
      // Check new slot availability before switching
      await checkSlotAvailability(
        bookingSlot,
        numberOfPlants || existingDoc.numberOfPlants
      );

      // Use Promise.all to perform both operations, but with the session
      await Promise.all([
        updateSlotWithSession(
          existingDoc.bookingSlot,
          existingDoc.numberOfPlants,
          "add"
        ),
        updateSlotWithSession(
          bookingSlot,
          numberOfPlants || existingDoc.numberOfPlants,
          "subtract"
        ),
      ]);
    } else if (numberOfPlants) {
      const quantityDifference = numberOfPlants - existingDoc.numberOfPlants;
      if (quantityDifference > 0) {
        // Only check availability if increasing quantity
        await checkSlotAvailability(
          existingDoc.bookingSlot,
          quantityDifference
        );
      }

      if (quantityDifference !== 0) {
        await updateSlotWithSession(
          existingDoc.bookingSlot,
          Math.abs(quantityDifference),
          quantityDifference < 0 ? "add" : "subtract"
        );
      }
    }
  } catch (error) {
    throw new AppError(
      error.message || "Failed to update booking slots",
      error.statusCode || 500
    );
  }
};
// Helper function to handle slot updates
const handleSlotUpdates = async (existingDoc, filteredBody) => {
  const { bookingSlot, numberOfPlants } = filteredBody;

  try {
    // Check slot availability before any updates
    const checkSlotAvailability = async (slotId, plantsNeeded) => {
      const currentSlot = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": slotId },
        { "subtypeSlots.$": 1 }
      );

      if (!currentSlot?.subtypeSlots?.[0]?.slots) {
        throw new AppError("Slot not found", 404);
      }

      const slot = currentSlot.subtypeSlots[0].slots.find(
        (s) => s._id.toString() === slotId.toString()
      );

      if (!slot) {
        throw new AppError("Specific slot not found", 404);
      }

      // Calculate available plants considering buffer and already booked plants
      const effectiveBuffer = slot.effectiveBuffer || slot.buffer || 0;
      const bufferAmount = Math.round((slot.totalPlants * effectiveBuffer) / 100);
      const bufferAdjustedCapacity = slot.totalPlants - bufferAmount;
      const availablePlants = Math.max(0, bufferAdjustedCapacity - (slot.totalBookedPlants || 0));
      
      if (plantsNeeded > availablePlants) {
        const slotDateInfo =
          slot.startDay && slot.endDay
            ? `Slot period: ${slot.startDay} to ${slot.endDay}`
            : slot.month
            ? `Slot month: ${slot.month}`
            : "";
        
        const errorMessage = availablePlants > 0 
          ? `Not enough plants available in slot. Only ${availablePlants} plants available. Please book in other slots. ${slotDateInfo}`
          : `No plants available in this slot. Please book in other slots. ${slotDateInfo}`;
        
        throw new AppError(errorMessage, 400);
      }
    };

    if (
      bookingSlot &&
      bookingSlot.toString() !== existingDoc.bookingSlot.toString()
    ) {
      // Check new slot availability before switching
      await checkSlotAvailability(
        bookingSlot,
        numberOfPlants || existingDoc.numberOfPlants
      );

      await Promise.all([
        updateSlot(existingDoc.bookingSlot, existingDoc.numberOfPlants, "add"),
        updateSlot(
          bookingSlot,
          numberOfPlants || existingDoc.numberOfPlants,
          "subtract"
        ),
      ]);
    } else if (numberOfPlants) {
      const quantityDifference = numberOfPlants - existingDoc.numberOfPlants;
      if (quantityDifference > 0) {
        // Only check availability if increasing quantity
        await checkSlotAvailability(
          existingDoc.bookingSlot,
          quantityDifference
        );
      }

      if (quantityDifference !== 0) {
        await updateSlot(
          existingDoc.bookingSlot,
          Math.abs(quantityDifference),
          quantityDifference < 0 ? "add" : "subtract"
        );
      }
    }
  } catch (error) {
    throw new AppError(
      error.message || "Failed to update booking slots",
      error.statusCode || 500
    );
  }
};

const updateOneNestedData = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const { id, ...updateData } = req.body;

    // Find the document by ID
    let doc = await Model.findById(id);

    if (!doc) {
      return next(new AppError(`No document found with that ID`, 404));
    }

    // Update nested properties based on updateData keys
    for (let key in updateData) {
      doc[key] = updateData[key];
    }

    // Save the updated document
    doc = await doc.save();

    const response = generateResponse(
      "Success",
      `${modelName} updated successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

const updateOneAndPushElement = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const { id, paymentAmount } = req.body;

    const updateObj = { ...req.body };

    if (paymentAmount !== undefined) {
      updateObj.$push = { payment: { paidAmount: paymentAmount } };
    }

    const doc = await Model.findByIdAndUpdate(id, updateObj, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return next(new AppError(`No ${modelName} found with that ID`, 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} updated successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

const deleteOne = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    const doc = await Model.findByIdAndDelete(req.body.id);

    if (!doc) {
      return next(new AppError("No document found with that ID", 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} deleted successfully`,
      undefined,
      undefined
    );

    return res.status(204).json(response);
  });

const getOne = (Model, modelName, popOptions) =>
  catchAsync(async (req, res, next) => {
    let query = Model.findById(req.params.id);
    if (popOptions) query = query.populate(popOptions);
    const doc = await query;

    if (!doc) {
      return next(new AppError("No document found with that ID", 404));
    }

    const response = generateResponse(
      "Success",
      `${modelName} found successfully`,
      doc,
      undefined
    );

    return res.status(200).json(response);
  });

const getAll = (Model, modelName) =>
  catchAsync(async (req, res, next) => {
    if (modelName !== "Order") {
      let filter = {};

      let query = Model.find(filter);
      const features = new APIFeatures(query, req.query, modelName)
        .filter()
        .sort()
        .limitFields()
        .paginate();

      const doc = await features.query.lean();

      const transformedDoc = doc.map((item) => {
        const { _id, ...rest } = item;
        return { id: _id, _id: _id, ...rest };
      });

      const response = generateResponse(
        "Success",
        `${modelName} found successfully`,
        transformedDoc,
        undefined
      );

      return res.status(200).json(response);
    }

    const {
      sortKey = "createdAt",
      sortOrder = "desc",
      search,
      startDate,
      endDate,
      dispatched = false, // New parameter
      salesPerson, // Added salesPerson parameter
      dealer, // Added dealer parameter
      village, // Added village parameter
      district, // Added district parameter
      page = 1,
      limit = 100,
      status,
      slotId, // Add this to handle the slotId filtering case
      monthName, // For slot date validation
      startDay, // For slot date validation
      endDay, // For slot date validation
      farmReady, // New parameter to filter orders with farm ready date
      ready_for_dispatch, // New parameter to filter orders ready for dispatch
    } = req.query;

    const order = sortOrder.toLowerCase() === "desc" ? -1 : 1;
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Special case for slotId filtering
    if (slotId) {
      // Match orders with the specified slot ID
      pipeline.push({
        $match: {
          bookingSlot: new mongoose.Types.ObjectId(slotId),
        },
      });
    } else {
      // Role-based filtering for non-admin users
      if (req.user) {
        const userRole = req.user.role;
        const userId = req.user._id;
        
        // Apply role-based filtering
        if (userRole === 'SALES') {
          // SALES users can only see orders assigned to them
          pipeline.push({
            $match: { salesPerson: userId }
          });
        } else if (userRole === 'DEALER') {
          // DEALER users can only see orders assigned to them
          pipeline.push({
            $match: { dealer: userId }
          });
        }
        // SUPER_ADMIN, ADMIN, OFFICE_ADMIN can see all orders (no filtering)
      }

      // Apply salesPerson filter if present (for admin users)
      if (salesPerson) {
        pipeline.push({
          $match: { salesPerson: new mongoose.Types.ObjectId(salesPerson) },
        });
      }

      // Apply dealer filter if present (for admin users)
      if (dealer) {
        pipeline.push({
          $match: { dealer: new mongoose.Types.ObjectId(dealer) },
        });
      }

      if (status) {
        // Convert comma-separated string to array and handle single status case
        const statusArray = status.split(",").map((s) => s.trim());
        pipeline.push({
          $match: {
            orderStatus: { $in: statusArray },
          },
        });
      }

      // Apply farm ready filter if present
      if (farmReady === "true") {
        const farmReadyMatch = {
          farmReadyDate: { $exists: true, $ne: null },
        };

        // Add date range filtering for farmReadyDate if startDate and endDate are provided
        if (startDate && endDate) {
          const parseDate = (dateStr, isEnd = false) => {
            const [day, month, year] = dateStr.split("-");
            // Use local timezone instead of UTC to avoid timezone issues
            const date = new Date(`${year}-${month}-${day}`);
            if (isEnd) {
              date.setHours(23, 59, 59, 999);
            } else {
              date.setHours(0, 0, 0, 0);
            }
            return date;
          };

          const start = parseDate(startDate);
          const end = parseDate(endDate, true);
          
          console.log(`Farm Ready Date Range Filter: ${startDate} to ${endDate}`);
          console.log(`Parsed dates: ${start.toISOString()} to ${end.toISOString()}`);
          
          farmReadyMatch.farmReadyDate = {
            $exists: true,
            $ne: null,
            $gte: start,
            $lte: end
          };
        }

        pipeline.push({
          $match: farmReadyMatch,
        });
      }

      // Apply ready for dispatch filter if present
      if (ready_for_dispatch === "true") {
        pipeline.push({
          $match: {
            $and: [
              { orderStatus: "FARM_READY" },
              { farmReadyDate: { $exists: true, $ne: null } }
            ]
          },
        });
      }

      // Apply Date range filtering only when `search` is NOT present
      if (!search && startDate && endDate && dispatched === "false") {
        const parseDate = (dateStr, isEnd = false) => {
          const [day, month, year] = dateStr.split("-");
          return isEnd
            ? new Date(`${year}-${month}-${day}T23:59:59.999Z`)
            : new Date(`${year}-${month}-${day}T00:00:00.000Z`);
        };

        const start = parseDate(startDate);
        const end = parseDate(endDate, true);
        pipeline.push({ $match: { orderBookingDate: { $gte: start, $lte: end } } });
      }
    }

    // Search filtering
    if (search) {
      const searchRegex = new RegExp(search, "i");

      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });

      pipeline.push({
        $addFields: {
          "farmer.mobileNumberStr": {
            $toString: { $arrayElemAt: ["$farmer.mobileNumber", 0] },
          },
        },
      });

      const isNumeric = /^\d+$/.test(search);
      const searchAsNumber = isNumeric ? Number(search) : NaN;

      pipeline.push({
        $match: {
          $or: [
            { orderId: isNumeric ? searchAsNumber : search },
            { "farmer.name": searchRegex },
            { "farmer.mobileNumberStr": searchRegex },
          ],
        },
      });
    } else {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Apply village and district filters after farmer lookup
    if (village || district) {
      const locationMatch = {};
      if (village) {
        locationMatch["farmer.village"] = new RegExp(village, "i");
      }
      if (district) {
        locationMatch["farmer.district"] = new RegExp(district, "i");
      }
      pipeline.push({
        $match: locationMatch,
      });
    }

    // Common lookups for both normal queries and slotId queries
    // Only do the farmer lookup if we haven't done it already
    if (!pipeline.some((p) => p.$lookup && p.$lookup.from === "farmers")) {
      pipeline.push({
        $lookup: {
          from: "farmers",
          localField: "farmer",
          foreignField: "_id",
          as: "farmer",
        },
      });
    }

    // Lookup related data
    pipeline.push(
      {
        $lookup: {
          from: "plantcms",
          localField: "plantName",
          foreignField: "_id",
          as: "plantName",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "salesPerson",
          foreignField: "_id",
          as: "salesPerson",
        },
      },
      {
        $lookup: {
          from: "trays", // Add lookup for cavity/tray
          localField: "cavity",
          foreignField: "_id",
          as: "cavityDetails",
        },
      },
      // Additional lookup for user references in status changes
      {
        $lookup: {
          from: "users",
          localField: "statusChanges.changedBy",
          foreignField: "_id",
          as: "statusChangeUsers",
        },
      },
      // Additional lookup for user references in farm ready date changes
      {
        $lookup: {
          from: "users",
          localField: "farmReadyDateChanges.changedBy",
          foreignField: "_id",
          as: "farmReadyDateChangeUsers",
        },
      }
    );

    // Booking slot lookup with date validation if needed
    if (slotId && monthName && startDay && endDay) {
      pipeline.push({
        $lookup: {
          from: "plantslots",
          let: { bookingSlotId: { $toObjectId: slotId } },
          pipeline: [
            { $unwind: "$subtypeSlots" },
            { $unwind: "$subtypeSlots.slots" },
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: [
                        { $toString: "$subtypeSlots.slots._id" },
                        { $toString: "$$bookingSlotId" },
                      ],
                    },
                    { $eq: ["$subtypeSlots.slots.month", monthName] },
                    { $eq: ["$subtypeSlots.slots.startDay", startDay] },
                    { $eq: ["$subtypeSlots.slots.endDay", endDay] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                slotId: "$subtypeSlots.slots._id",
                startDay: "$subtypeSlots.slots.startDay",
                endDay: "$subtypeSlots.slots.endDay",
                subtypeId: "$subtypeSlots.subtypeId",
                month: "$subtypeSlots.slots.month",
              },
            },
          ],
          as: "bookingSlotDetails",
        },
      });

      // Only keep orders where the slot details matched the criteria
      pipeline.push({
        $match: {
          bookingSlotDetails: { $ne: [] },
        },
      });
    } else {
      // Standard booking slot lookup without date validation
      pipeline.push({
        $lookup: {
          from: "plantslots",
          let: { bookingSlotId: "$bookingSlot" },
          pipeline: [
            { $unwind: "$subtypeSlots" },
            { $unwind: "$subtypeSlots.slots" },
            {
              $match: {
                $expr: {
                  $eq: [
                    { $toString: "$subtypeSlots.slots._id" },
                    { $toString: "$$bookingSlotId" },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                slotId: "$subtypeSlots.slots._id",
                startDay: "$subtypeSlots.slots.startDay",
                endDay: "$subtypeSlots.slots.endDay",
                subtypeId: "$subtypeSlots.subtypeId",
                month: "$subtypeSlots.slots.month",
              },
            },
          ],
          as: "bookingSlotDetails",
        },
      });
    }

    // Add condition for dispatched = true
    if (dispatched === "true" && startDate && endDate && ready_for_dispatch !== "true") {
      pipeline.push(
        {
          $addFields: {
            parsedStartDay: {
              $toDate: {
                $dateFromString: {
                  dateString: {
                    $arrayElemAt: ["$bookingSlotDetails.startDay", 0],
                  },
                  format: "%d-%m-%Y",
                },
              },
            },
            parsedEndDay: {
              $toDate: {
                $dateFromString: {
                  dateString: {
                    $arrayElemAt: ["$bookingSlotDetails.endDay", 0],
                  },
                  format: "%d-%m-%Y",
                },
              },
            },
            queryStartDate: {
              $toDate: {
                $dateFromString: { dateString: startDate, format: "%d-%m-%Y" },
              },
            },
            queryEndDate: {
              $toDate: {
                $dateFromString: { dateString: endDate, format: "%d-%m-%Y" },
              },
            },
          },
        },
        {
          $match: {
            $expr: {
              $or: [
                {
                  $and: [
                    { $lte: ["$parsedStartDay", "$queryEndDate"] },
                    { $gte: ["$parsedStartDay", "$queryStartDate"] },
                  ],
                },
                {
                  $and: [
                    { $lte: ["$parsedEndDay", "$queryEndDate"] },
                    { $gte: ["$parsedEndDay", "$queryStartDate"] },
                  ],
                },
                {
                  $and: [
                    { $lte: ["$parsedStartDay", "$queryEndDate"] },
                    { $gte: ["$parsedEndDay", "$queryStartDate"] },
                  ],
                },
              ],
            },
          },
        }
      );
    }

    // Enrich plantSubtype details (name and ID)
    pipeline.push({
      $set: {
        plantSubtypeDetails: {
          $arrayElemAt: [
            {
              $filter: {
                input: { $arrayElemAt: ["$plantName.subtypes", 0] },
                as: "subtype",
                cond: { $eq: ["$$subtype._id", "$plantSubtype"] },
              },
            },
            0,
          ],
        },
      },
    });



    // Select required fields at the end
    pipeline.push(
      {
        $project: {
          farmer: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$farmer",
                  as: "farmerData",
                  in: {
                    name: "$$farmerData.name",
                    mobileNumber: "$$farmerData.mobileNumber",
                    village: "$$farmerData.village",
                    taluka: "$$farmerData.taluka",
                    district: "$$farmerData.district",
                    state: "$$farmerData.state",
                    // Added the name fields
                    stateName: "$$farmerData.stateName",
                    districtName: "$$farmerData.districtName",
                    talukaName: "$$farmerData.talukaName",
                  },
                },
              },
              0,
            ],
          },
          plantType: {
            id: { $arrayElemAt: ["$plantName._id", 0] },
            name: { $arrayElemAt: ["$plantName.name", 0] },
          },
          plantSubtype: {
            id: "$plantSubtypeDetails._id",
            name: "$plantSubtypeDetails.name",
          },
          cavity: {
            id: { $arrayElemAt: ["$cavityDetails._id", 0] },
            name: { $arrayElemAt: ["$cavityDetails.name", 0] },
            cavity: { $arrayElemAt: ["$cavityDetails.cavity", 0] },
            numberPerCrate: {
              $arrayElemAt: ["$cavityDetails.numberPerCrate", 0],
            },
          },
          bookingSlot: "$bookingSlotDetails",
          salesPerson: {
            $arrayElemAt: [
              {
                $map: {
                  input: "$salesPerson",
                  as: "sales",
                  in: {
                    _id: "$$sales._id",
                    name: "$$sales.name",
                    phoneNumber: "$$sales.phoneNumber",
                    jobTitle: "$$sales.jobTitle",
                  },
                },
              },
              0,
            ],
          },
          createdAt: 1,
          orderStatus: 1,
          payment: 1,
          numberOfPlants: 1,
          remainingPlants: 1, // Added field: remaining plants
          returnedPlants: 1, // Return tracking field
          returnReason: 1, // Return reason field
          returnHistory: 1, // Return history field
          orderId: 1,
          rate: 1,
          farmReadyDate: 1,
          orderBookingDate: 1, // Add orderBookingDate to response
          orderPaymentStatus: 1,
          paymentCompleted: 1,
          dealerOrder: 1,
          notes: 1,
          orderRemarks: 1, // Keep orderRemarks field as array of strings
          // Added farm ready date change history with user info
          farmReadyDateChanges: {
            $map: {
              input: "$farmReadyDateChanges",
              as: "change",
              in: {
                previousDate: "$$change.previousDate",
                newDate: "$$change.newDate",
                reason: "$$change.reason",
                notes: "$$change.notes",
                createdAt: "$$change.createdAt",
                changedBy: {
                  $cond: {
                    if: "$$change.changedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$change.changedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$farmReadyDateChangeUsers",
                                      as: "user",
                                      cond: { $eq: [{ $toString: "$$user._id" }, "$$userId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: {
                              $ifNull: [
                                {
                                  _id: "$$userData._id",
                                  name: "$$userData.name",
                                  phoneNumber: "$$userData.phoneNumber"
                                },
                                { _id: "$$change.changedBy" }
                              ]
                            }
                          }
                        }
                      }
                    },
                    else: null,
                  },
                },
              },
            },
          },
          // Added status change history with user info
          statusChanges: {
            $map: {
              input: "$statusChanges",
              as: "change",
              in: {
                previousStatus: "$$change.previousStatus",
                newStatus: "$$change.newStatus",
                reason: "$$change.reason",
                notes: "$$change.notes",
                changedAt: "$$change.createdAt",
                changedBy: {
                  $cond: {
                    if: "$$change.changedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$change.changedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$statusChangeUsers",
                                      as: "user",
                                      cond: { $eq: [{ $toString: "$$user._id" }, "$$userId"] }
                                    }
                                  },
                                  0
                                ]
                              }
                            },
                            in: {
                              $ifNull: [
                                {
                                  _id: "$$userData._id",
                                  name: "$$userData.name",
                                  phoneNumber: "$$userData.phoneNumber"
                                },
                                { _id: "$$change.changedBy" }
                              ]
                            }
                          }
                        }
                      }
                    },
                    else: null,
                  },
                },
              },
            },
          },
          // Added delivery change history
          deliveryChanges: {
            $map: {
              input: "$deliveryChanges",
              as: "change",
              in: {
                previousDeliveryDate: "$$change.previousDeliveryDate",
                newDeliveryDate: "$$change.newDeliveryDate",
                reasonForChange: "$$change.reasonForChange",
                changedAt: "$$change.createdAt",
              },
            },
          },
        },
      },
      { $sort: { [sortKey]: order } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) }
    );

    // Execute the pipeline
    const results = await Model.aggregate(pipeline);

    // Calculate total count for pagination (without skip and limit)
    const countPipeline = pipeline.slice(0, -3); // Remove sort, skip, and limit stages
    const totalCount = await Model.aggregate([
      ...countPipeline,
      { $count: "total" }
    ]);
    const total = totalCount.length > 0 ? totalCount[0].total : 0;
    const totalPages = Math.ceil(total / parseInt(limit, 10));

    // Transform documents for response
    const transformedResults = results.map((item) => {
      const { _id, ...rest } = item;
      return { id: _id, _id, ...rest };
    });

    const response = generateResponse(
      "Success",
      `${modelName} found successfully`,
      {
        data: transformedResults,
        total: total,
        totalPages: totalPages,
        currentPage: parseInt(page, 10),
        limit: parseInt(limit, 10)
      },
      undefined
    );

    return res.status(200).json(response);
  });

const getCMS = (Model) =>
  catchAsync(async (req, res, next) => {
    const { name, entity } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    let data;

    if (name && name !== "") {
      data = await Model.find({
        data: { $regex: `^${name}`, $options: "i" },
        type: entity,
      })
        .skip(skip)
        .limit(100)
        .select("-_id -type -__v");
    } else {
      data = await Model.find({ type: entity })
        .skip(skip)
        .limit(100)
        .select("-_id -type -__v");
    }

    const formattedData = data.map((item) => item.data);

    res.status(200).send(formattedData);
  });

const createCMS = (Model, entity) =>
  catchAsync(async (req, res, next) => {
    const data = await Model.find({
      data: req.body[entity],
      type: entity,
    });

    if (data.length <= 0) {
      await new Model({
        data: req.body[entity],
        type: entity,
      }).save();
    }

    next();
  });

const isPhoneNumberExists = (Model, modelName) =>
  catchAsync(async (req, _, next) => {
    const { phoneNumber } = req.body;

    const isFound = await Model.findOne({ phoneNumber });

    if (isFound) {
      throw new AppError(
        `${modelName} with same phone number address already exists`,
        409
      );
    }
    next();
  });

const isDisabled = (Model, modelName) =>
  catchAsync(async (req, _, next) => {
    const { phoneNumber } = req.body;
    // console.log(phoneNumber);
    const data = await Model.findOne({ phoneNumber });
    // console.log(data);
    // if (data?.isDisabled) {
    //   throw new AppError(`Your access to this app is disabled`, 409);
    // }
    next();
  });
const handleQuantityAllocation = async (
  dealerId,
  plantType,
  subType,
  bookingSlot,
  requestedQuantity,
  session
) => {
  let wallet = await DealerWallet.findOne({ dealer: dealerId }).session(
    session
  );

  if (!wallet) {
    return {
      fromWallet: 0,
      fromSlot: requestedQuantity,
    };
  }

  // Find exact matching entry
  const entryIndex = wallet.entries.findIndex(
    (e) =>
      e.plantType?.equals(plantType) &&
      e.subType?.equals(subType) &&
      e.bookingSlot?.equals(bookingSlot)
  );

  if (entryIndex === -1) {
    return {
      fromWallet: 0,
      fromSlot: requestedQuantity,
    };
  }

  const entry = wallet.entries[entryIndex];
  const availableInWallet = entry.quantity - entry.bookedQuantity;

  if (availableInWallet >= requestedQuantity) {
    // Use atomic update to avoid write conflicts
    // Also update remainingQuantity since pre-save middleware doesn't run with findOneAndUpdate
    const result = await DealerWallet.findOneAndUpdate(
      {
        _id: wallet._id,
        [`entries.${entryIndex}.bookedQuantity`]: { $exists: true }
      },
      {
        $inc: {
          [`entries.${entryIndex}.bookedQuantity`]: requestedQuantity,
          [`entries.${entryIndex}.remainingQuantity`]: -requestedQuantity
        }
      },
      {
        session,
        new: true,
        runValidators: true
      }
    );

    if (!result) {
      throw new AppError("Failed to update dealer quota", 500);
    }

    return {
      fromWallet: requestedQuantity,
      fromSlot: 0,
    };
  } else {
    const fromWallet = Math.max(0, availableInWallet);
    const fromSlot = requestedQuantity - fromWallet;

    if (fromWallet > 0) {
      // Use atomic update to avoid write conflicts
      // Also update remainingQuantity since pre-save middleware doesn't run with findOneAndUpdate
      const result = await DealerWallet.findOneAndUpdate(
        {
          _id: wallet._id,
          [`entries.${entryIndex}.bookedQuantity`]: { $exists: true }
        },
        {
          $inc: {
            [`entries.${entryIndex}.bookedQuantity`]: fromWallet,
            [`entries.${entryIndex}.remainingQuantity`]: -fromWallet
          }
        },
        {
          session,
          new: true,
          runValidators: true
        }
      );

      if (!result) {
        throw new AppError("Failed to update dealer quota", 500);
      }
    }

    return {
      fromWallet,
      fromSlot,
    };
  }
};

export {
  createOne,
  deleteOne,
  updateOne,
  updateOneAndPushElement,
  getOne,
  getAll,
  getCMS,
  createCMS,
  updateOneNestedData,
  isPhoneNumberExists,
  isDisabled,
};
