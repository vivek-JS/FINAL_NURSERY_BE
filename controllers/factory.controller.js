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
import Farmer from "../models/farmer.model.js";
import {
  sendOrderAcceptedNotification,
  sendOrderRejectedNotification,
  sendOrderDispatchedNotification,
  sendOrderStatusNotification,
} from "../utility/pushNotification.js";
import {
  sendOrderAcceptedWhatsApp,
  sendOrderReadyWhatsApp,
  sendPaymentReminderWhatsApp
} from "../utility/watiMessaging.js";
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

  // Step 1: If subtracting, first check if enough plants are available (unless overflow is allowed OR sowing is allowed)
  if (action === "subtract" && !allowOverflow) {
    console.log("hii")
    const currentSlot = await PlantSlot.findOne(
      { "subtypeSlots.slots._id": bookingSlot },
      { "subtypeSlots.$": 1 }
    ).populate("plantId", "sowingAllowed");

    if (!currentSlot || !currentSlot.subtypeSlots[0]) {
      // console.error("[updateSlot] ERROR: Slot not found");
      throw new Error("Slot not found");
    }

    // Check if sowing is allowed for this plant - if yes, skip availability restrictions
    const isSowingAllowed = currentSlot.plantId?.sowingAllowed || false;
    
    if (!isSowingAllowed) {
      // Only check availability if sowing is NOT allowed
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
    } else {
      console.log("[updateSlot] Sowing allowed - skipping availability check");
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
      console.log('📦 Request Body:', req?.body);
      console.log('📊 Order Status from request:', req.body?.orderStatus);
      console.log('📋 OrderData after destructuring:', orderData);

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
          orderData.walletEntryId = quotaAllocation.walletEntryId; // Link to wallet entry
          
          console.log('💾 Saving order with quota data:', {
            quotaUsed: orderData.quotaUsed,
            quotaSource: orderData.quotaSource,
            walletEntryId: orderData.walletEntryId?.toString(),
            dealer: orderData.dealer?.toString()
          });

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

        // Handle uploaded screenshots with Cloudinary
        let screenshots = [];
        if (req.files && req.files.length > 0) {
          const { uploadMultipleImagesToCloudinary } = await import('../utils/cloudinaryUtils.js');
          
          try {
            // Upload all files to Cloudinary
            const uploadResults = await uploadMultipleImagesToCloudinary(
              req.files.map(file => file.buffer),
              `nursery-orders/order-${orderId}`
            );
            
            // Extract successful uploads
            screenshots = uploadResults
              .filter(result => result.success)
              .map(result => result.url);
              
            console.log('📸 Screenshots uploaded to Cloudinary:', screenshots);
          } catch (error) {
            console.error('Error uploading files to Cloudinary:', error);
            // Continue with order creation even if image upload fails
          }
        }

        // Prepare order document - explicitly preserve orderStatus
        const orderDocument = {
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
          // Include orderFor field if provided
          orderFor: req.body.orderFor || undefined,
          screenshots: screenshots, // Include uploaded screenshots
        };
        
        // Explicitly set orderStatus if provided in request (don't let model default override it)
        if (req.body.orderStatus) {
          orderDocument.orderStatus = req.body.orderStatus;
        }
        
        console.log('🎯 Final order document orderStatus:', orderDocument.orderStatus);
        
        // Create the Order with all new fields
        const order = await Model.create([orderDocument], { session });

        // Fetch slot to check if sowing is allowed for this plant
        const slotForUpdate = await PlantSlot.findOne(
          { "subtypeSlots.slots._id": bookingSlot },
          { "subtypeSlots.$": 1 }
        ).populate("plantId", "sowingAllowed").session(session);

        const isSowingAllowed = slotForUpdate?.plantId?.sowingAllowed || false;

        // Add order to slot's orders array and update booking counts
        let slotUpdateOperation = {
          $push: { 
            "subtypeSlots.$[subtypeSlot].slots.$[slot].orders": order[0]._id 
          },
          $inc: {
            // Always increment totalBookedPlants
            "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": numberOfPlants
          }
        };

        // For regular plants (non-sowing-allowed), also decrement availablePlants
        if (!isSowingAllowed) {
          console.log(`📊 Regular plant: Updating slot ${bookingSlot} - incrementing totalBookedPlants by ${numberOfPlants}, decrementing availablePlants by ${numberOfPlants}`);
          slotUpdateOperation.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = -numberOfPlants;
        } else {
          console.log(`📊 Sowing-allowed plant: Updating slot ${bookingSlot} - ONLY incrementing totalBookedPlants by ${numberOfPlants} (availablePlants unchanged)`);
        }

        const slotUpdateResult = await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": bookingSlot },
          slotUpdateOperation,
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": bookingSlot },
              { "slot._id": bookingSlot }
            ],
            session: session
          }
        );
        console.log(`✅ Slot update result: matched=${slotUpdateResult.matchedCount}, modified=${slotUpdateResult.modifiedCount}`);

        // Create farmer from orderFor if name and mobileNumber are present
        console.log("🔍 Checking orderFor data:", {
          hasOrderFor: !!req.body.orderFor,
          hasName: req.body.orderFor?.name,
          hasMobile: req.body.orderFor?.mobileNumber,
          orderForData: req.body.orderFor
        });
        
        if (req.body.orderFor && req.body.orderFor.name && req.body.orderFor.mobileNumber) {
          try {
            console.log("✅ OrderFor validation passed - Creating farmer from orderFor data:", req.body.orderFor);
            
            // Check if farmer already exists with this mobile number
            let orderForFarmer = await Farmer.findOne({ 
              mobileNumber: req.body.orderFor.mobileNumber 
            }).session(session);
            
            console.log("🔍 Existing farmer check result:", orderForFarmer ? "FOUND" : "NOT FOUND");
            
            if (!orderForFarmer) {
              // Create new farmer with orderFor data
              // For required location fields, use the address or default values
              const address = req.body.orderFor.address || "To be updated";
              
              const farmerData = {
                name: req.body.orderFor.name,
                mobileNumber: req.body.orderFor.mobileNumber,
                // Required fields - use address or defaults
                village: address,
                taluka: "To be updated",
                district: "To be updated",
                state: "To be updated",
                stateName: "To be updated",
                talukaName: "To be updated",
                districtName: "To be updated",
              };
              
              console.log("📝 Creating new farmer with data:", farmerData);
              
              // Create the farmer
              const newFarmer = await Farmer.create([farmerData], { session });
              orderForFarmer = newFarmer[0];
              
              console.log("✅ Successfully created new farmer from orderFor! ID:", orderForFarmer._id, "Name:", orderForFarmer.name);
            } else {
              console.log("ℹ️ Farmer already exists with mobile number:", req.body.orderFor.mobileNumber, "- Skipping creation");
            }
          } catch (error) {
            console.error("❌ Error creating farmer from orderFor:", error.message);
            console.error("Full error:", error);
            // Don't fail the order creation if farmer creation fails
          }
        } else {
          console.log("⚠️ OrderFor validation failed - farmer will NOT be created");
        }

        // Update referral with order ID if this farmer was referred
        if (orderData.farmer && req.body.referredBy) {
          try {
            await Farmer.updateOne(
              { 
                _id: req.body.referredBy,
                "referredTo.farmerId": orderData.farmer,
                "referredTo.orderId": null
              },
              {
                $set: { "referredTo.$.orderId": order[0]._id }
              },
              { session }
            );
          } catch (error) {
            console.error("Error updating referral with order ID:", error);
            // Don't fail the order creation if referral update fails
          }
        }

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
                if (paymentItem.isWalletPayment && (paymentItem.paymentStatus === "PENDING" || paymentItem.paymentStatus === "COLLECTED")) {
                  // Deduct from wallet (negative amount) - when dealer pays from wallet (pending or collected)
                  walletAmount = -paymentItem.paidAmount;
                  description = `Wallet payment ${paymentItem.paymentStatus.toLowerCase()} for Order #${order[0]._id}`;
                } else if (order[0].dealerOrder && paymentItem.paymentStatus === "COLLECTED" && !paymentItem.isWalletPayment) {
                  // Add to wallet (positive amount) - when payment is collected from dealer (not wallet)
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

      console.log("=== UPDATE ORDER DEBUG ===");
      console.log("Received body:", req.body);
      console.log("Filtered body:", filteredBody);
      console.log("deliveryDate in request:", req.body.deliveryDate);
      console.log("deliveryDate in filtered body:", filteredBody.deliveryDate);
      console.log("Allowed fields:", allowedFields);

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

        // Send push notification for order status change
        const newStatus = filteredBody.orderStatus;
        console.log(`📱 Order status changing from ${existingDoc.orderStatus} to ${newStatus}`);
        
        // Determine who to notify based on order type
        let userToNotify = null;
        if (existingDoc.dealer) {
          userToNotify = await User.findById(existingDoc.dealer).session(session);
          console.log(`📱 Dealer order - notify dealer: ${userToNotify?.name}`);
        } else if (existingDoc.salesPerson) {
          userToNotify = await User.findById(existingDoc.salesPerson).session(session);
          console.log(`📱 Farmer order - notify sales person: ${userToNotify?.name}`);
        }

        if (userToNotify && userToNotify.expoPushToken) {
          // Send notification asynchronously (don't wait for it)
          (async () => {
            try {
              const orderId = existingDoc.orderId || existingDoc._id;
              const orderDetails = {
                plantName: existingDoc.plantName?.name || 'plants',
                quantity: existingDoc.numberOfPlants,
              };

              if (newStatus === 'ACCEPTED' || newStatus === 'CONFIRMED') {
                await sendOrderAcceptedNotification(userToNotify.expoPushToken, orderId, orderDetails);
                console.log(`✅ Order accepted notification sent for Order #${orderId}`);
              } else if (newStatus === 'REJECTED' || newStatus === 'CANCELLED') {
                const reason = filteredBody.statusChangeReason || statusChange.reason || '';
                await sendOrderRejectedNotification(userToNotify.expoPushToken, orderId, reason);
                console.log(`❌ Order rejected notification sent for Order #${orderId}`);
              } else if (newStatus === 'FARM_READY') {
                // Get farmer details for notification
                const farmerDetails = existingDoc.farmer ? await mongoose.model('Farmer').findById(existingDoc.farmer).session(session) : null;
                const farmerName = farmerDetails?.name || 'Unknown Farmer';
                const farmerVillage = farmerDetails?.village || 'Unknown Village';
                
                const message = `Order #${orderId} is ready for dispatch!\nFarmer: ${farmerName}\nVillage: ${farmerVillage}`;
                await sendOrderStatusNotification(userToNotify.expoPushToken, orderId, 'FARM_READY', message);
                console.log(`🌾 Farm ready notification sent for Order #${orderId}`);
              } else if (newStatus === 'DISPATCHED') {
                await sendOrderDispatchedNotification(userToNotify.expoPushToken, orderId, {});
                console.log(`🚚 Order dispatched notification sent for Order #${orderId}`);
              }
            } catch (notificationError) {
              console.error('❌ Error sending order status notification:', notificationError);
            }
          })();
        } else {
          console.log('⚠️ No push token found for user, skipping order status notification');
        }

        // Send WhatsApp message to farmer when order is accepted or ready
        if (newStatus === 'ACCEPTED' || newStatus === 'CONFIRMED') {
          // Send WhatsApp message asynchronously (don't wait for it)
          (async () => {
            try {
              // Get farmer details
              const farmerDetails = existingDoc.farmer ? await mongoose.model('Farmer').findById(existingDoc.farmer) : null;
              
              if (farmerDetails && farmerDetails.mobileNumber) {
                const orderId = existingDoc.orderId || existingDoc._id;
                
                // Calculate payment amounts
                const totalAmount = existingDoc.numberOfPlants * existingDoc.rate;
                const paidAmount = existingDoc.payment && existingDoc.payment.length > 0
                  ? existingDoc.payment.reduce((sum, p) => sum + (p.paidAmount || 0), 0)
                  : 0;
                const remainingAmount = totalAmount - paidAmount;
                
                const orderDetails = {
                  orderId: orderId,
                  plantName: existingDoc.plantType?.name || existingDoc.plantName?.name || 'Plants',
                  plantSubtype: existingDoc.plantSubtype?.name || existingDoc.plantSubtype || 'N/A',
                  numberOfPlants: existingDoc.numberOfPlants,
                  deliveryDate: existingDoc.deliveryDate,
                  rate: existingDoc.rate,
                  totalAmount: totalAmount,
                  advanceAmount: paidAmount,
                  remainingAmount: remainingAmount,
                };

                console.log(`📱 Sending WhatsApp order accepted message to farmer: ${farmerDetails.name} (${farmerDetails.mobileNumber})`);
                const result = await sendOrderAcceptedWhatsApp(farmerDetails, orderDetails);
                
                if (result.success) {
                  console.log(`✅ WhatsApp message sent successfully for Order #${orderId}`);
                } else {
                  console.log(`⚠️ WhatsApp message failed for Order #${orderId}:`, result.error);
                }
              } else {
                console.log('⚠️ No farmer mobile number found, skipping WhatsApp message');
              }
            } catch (whatsappError) {
              console.error('❌ Error sending WhatsApp message:', whatsappError.message);
            }
          })();
        } else if (newStatus === 'FARM_READY') {
          // Send WhatsApp message when farm ready
          (async () => {
            try {
              const farmerDetails = existingDoc.farmer ? await mongoose.model('Farmer').findById(existingDoc.farmer) : null;
              
              if (farmerDetails && farmerDetails.mobileNumber) {
                const orderId = existingDoc.orderId || existingDoc._id;
                const orderDetails = {
                  orderId: orderId,
                  plantName: existingDoc.plantType?.name || existingDoc.plantName?.name || 'Plants',
                  numberOfPlants: existingDoc.numberOfPlants,
                  deliveryDate: existingDoc.deliveryDate,
                };

                console.log(`📱 Sending WhatsApp farm ready message to farmer: ${farmerDetails.name} (${farmerDetails.mobileNumber})`);
                const result = await sendOrderReadyWhatsApp(farmerDetails, orderDetails);
                
                if (result.success) {
                  console.log(`✅ WhatsApp farm ready message sent successfully for Order #${orderId}`);
                } else {
                  console.log(`⚠️ WhatsApp farm ready message failed for Order #${orderId}:`, result.error);
                }
              } else {
                console.log('⚠️ No farmer mobile number found, skipping WhatsApp message');
              }
            } catch (whatsappError) {
              console.error('❌ Error sending WhatsApp message:', whatsappError.message);
            }
          })();
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

      // Track general order field edits (rate, numberOfPlants, deliveryDate)
      const editHistoryEntries = [];
      
      // Track rate changes
      if (filteredBody.rate && filteredBody.rate !== existingDoc.rate) {
        editHistoryEntries.push({
          field: "rate",
          previousValue: existingDoc.rate,
          newValue: filteredBody.rate,
          changedBy: req.user ? req.user._id : null,
          notes: `Rate changed from ₹${existingDoc.rate} to ₹${filteredBody.rate}`,
        });
      }

      // Track quantity changes (check both numberOfPlants and quantity)
      const newQuantity = filteredBody.numberOfPlants || filteredBody.quantity;
      if (newQuantity && newQuantity !== existingDoc.numberOfPlants) {
        editHistoryEntries.push({
          field: "numberOfPlants",
          previousValue: existingDoc.numberOfPlants,
          newValue: newQuantity,
          changedBy: req.user ? req.user._id : null,
          notes: `Quantity changed from ${existingDoc.numberOfPlants} to ${newQuantity} plants`,
        });
      }

      // Track deliveryDate changes (specific delivery date)
      if (filteredBody.deliveryDate) {
        const oldDate = existingDoc.deliveryDate ? new Date(existingDoc.deliveryDate) : null;
        const newDate = new Date(filteredBody.deliveryDate);
        
        if (!oldDate || oldDate.toISOString() !== newDate.toISOString()) {
          editHistoryEntries.push({
            field: "deliveryDate",
            previousValue: oldDate,
            newValue: newDate,
            changedBy: req.user ? req.user._id : null,
            notes: `Delivery date changed from ${oldDate ? oldDate.toLocaleDateString('en-IN') : 'Not set'} to ${newDate.toLocaleDateString('en-IN')}`,
          });
        }
      }

      // Add all edit history entries
      if (editHistoryEntries.length > 0) {
        if (!filteredBody.$push) filteredBody.$push = {};
        if (!filteredBody.$push.orderEditHistory) {
          filteredBody.$push.orderEditHistory = { $each: editHistoryEntries };
        }
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

      // Update slot when order is rejected or cancelled
      if (
        filteredBody.orderStatus && 
        (filteredBody.orderStatus === "REJECTED" || filteredBody.orderStatus === "CANCELLED") &&
        existingDoc.orderStatus !== "REJECTED" &&
        existingDoc.orderStatus !== "CANCELLED"
      ) {
        // Fetch slot to check if sowing is allowed
        const cancelSlot = await PlantSlot.findOne(
          { "subtypeSlots.slots._id": existingDoc.bookingSlot },
          { "subtypeSlots.$": 1 }
        ).populate("plantId", "sowingAllowed").session(session);

        const isSowingAllowed = cancelSlot?.plantId?.sowingAllowed || false;

        let cancelUpdateOperation = {
          $inc: {
            "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": -existingDoc.numberOfPlants
          }
        };

        // For regular plants (non-sowing-allowed), also increment availablePlants
        if (!isSowingAllowed) {
          cancelUpdateOperation.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = existingDoc.numberOfPlants;
          console.log(`🔙 Regular plant: Order cancelled - decrementing totalBookedPlants by ${existingDoc.numberOfPlants}, incrementing availablePlants by ${existingDoc.numberOfPlants}`);
        } else {
          console.log(`🔙 Sowing-allowed plant: Order cancelled - ONLY decrementing totalBookedPlants by ${existingDoc.numberOfPlants} (availablePlants unchanged)`);
        }

        await PlantSlot.updateOne(
          { "subtypeSlots.slots._id": existingDoc.bookingSlot },
          cancelUpdateOperation,
          {
            arrayFilters: [
              { "subtypeSlot.slots._id": existingDoc.bookingSlot },
              { "slot._id": existingDoc.bookingSlot }
            ],
            session: session
          }
        );
        console.log(`✅ Slot update completed for cancelled order`);
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

      console.log("=== FINAL UPDATE OPERATION ===");
      console.log("Update operation:", JSON.stringify(updateOperation, null, 2));
      console.log("deliveryDate in update operation:", updateOperation.deliveryDate);

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

      console.log("=== UPDATED DOCUMENT ===");
      console.log("Updated deliveryDate:", updatedDoc.deliveryDate);
      console.log("Updated bookingSlot:", updatedDoc.bookingSlot);
      console.log("Updated rate:", updatedDoc.rate);
      console.log("Updated numberOfPlants:", updatedDoc.numberOfPlants);

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
      ).populate("plantId", "sowingAllowed").session(session);

      if (!currentSlot?.subtypeSlots?.[0]?.slots) {
        throw new AppError("Slot not found", 404);
      }

      const slot = currentSlot.subtypeSlots[0].slots.find(
        (s) => s._id.toString() === slotId.toString()
      );

      if (!slot) {
        throw new AppError("Specific slot not found", 404);
      }

      // Skip availability check for sowing-allowed plants
      const isSowingAllowed = currentSlot?.plantId?.sowingAllowed || false;
      if (isSowingAllowed) {
        console.log(`✅ Sowing-allowed plant: Skipping availability check for slot ${slotId}`);
        return;
      }

      // Calculate available plants considering buffer and already booked plants (for regular plants only)
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
      // Fetch slot to check if sowing is allowed
      const slotDoc = await PlantSlot.findOne(
        { "subtypeSlots.slots._id": slotId },
        { "subtypeSlots.$": 1 }
      ).populate("plantId", "sowingAllowed").session(session);

      const isSowingAllowed = slotDoc?.plantId?.sowingAllowed || false;
      
      // Update totalBookedPlants based on action (add = decrement booked, subtract = increment booked)
      const bookingIncrement = action === "add" ? -plantsCount : plantsCount;
      
      let updateOperation = {
        $inc: {
          "subtypeSlots.$[subtypeSlot].slots.$[slot].totalBookedPlants": bookingIncrement
        }
      };

      // For regular plants (non-sowing-allowed), also update availablePlants
      if (!isSowingAllowed) {
        const availableIncrement = action === "add" ? plantsCount : -plantsCount;
        updateOperation.$inc["subtypeSlots.$[subtypeSlot].slots.$[slot].availablePlants"] = availableIncrement;
        console.log(`🔄 Regular plant: Updating slot ${slotId} - totalBookedPlants ${bookingIncrement > 0 ? '+' : ''}${bookingIncrement}, availablePlants ${availableIncrement > 0 ? '+' : ''}${availableIncrement}`);
      } else {
        console.log(`🔄 Sowing-allowed plant: Updating slot ${slotId} - ONLY totalBookedPlants ${bookingIncrement > 0 ? '+' : ''}${bookingIncrement} (availablePlants unchanged)`);
      }
      
      const updateResult = await PlantSlot.updateOne(
        { "subtypeSlots.slots._id": slotId },
        updateOperation,
        {
          arrayFilters: [
            { "subtypeSlot.slots._id": slotId },
            { "slot._id": slotId }
          ],
          session: session
        }
      );
      
      console.log(`✅ Slot update result: matched=${updateResult.matchedCount}, modified=${updateResult.modifiedCount}`);
      return updateResult;
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
      ).populate("plantId", "sowingAllowed");

      if (!currentSlot?.subtypeSlots?.[0]?.slots) {
        throw new AppError("Slot not found", 404);
      }

      const slot = currentSlot.subtypeSlots[0].slots.find(
        (s) => s._id.toString() === slotId.toString()
      );

      if (!slot) {
        throw new AppError("Specific slot not found", 404);
      }

      // Skip availability check for sowing-allowed plants
      const isSowingAllowed = currentSlot?.plantId?.sowingAllowed || false;
      if (isSowingAllowed) {
        console.log(`✅ Sowing-allowed plant: Skipping availability check for slot ${slotId}`);
        return;
      }

      // Calculate available plants considering buffer and already booked plants (for regular plants only)
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
      
      // For Farmer model, skip pagination to get all farmers
      if (modelName === "Farmer") {
        const features = new APIFeatures(query, req.query, modelName)
          .filter()
          .sort()
          .limitFields();
        // No pagination for Farmer model
        
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
      } else {
        // For other models, keep pagination
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
      orderIds, // NEW: Filter by specific order IDs
    } = req.query;

    const order = sortOrder.toLowerCase() === "desc" ? -1 : 1;
    const skip = (page - 1) * limit;

    // Build the aggregation pipeline
    const pipeline = [];

    // Filter by specific order IDs if provided
    if (orderIds) {
      const orderIdArray = orderIds.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
      pipeline.push({
        $match: {
          _id: { $in: orderIdArray },
        },
      });
    }

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
        // Exception: DISPATCH_MANAGER can see all orders (especially for ready_for_dispatch view)
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
        // SUPER_ADMIN, ADMIN, OFFICE_ADMIN, DISPATCH_MANAGER can see all orders (no filtering)
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

      // Apply ready for dispatch filter if present - returns all FARM_READY orders
      if (ready_for_dispatch === "true") {
        pipeline.push({
          $match: {
            orderStatus: "FARM_READY"
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
      },
      // Additional lookup for user references in order edit history
      {
        $lookup: {
          from: "users",
          localField: "orderEditHistory.changedBy",
          foreignField: "_id",
          as: "orderEditHistoryUsers",
        },
      },
      // Additional lookup for user references in dispatch history
      {
        $lookup: {
          from: "users",
          localField: "dispatchHistory.processedBy",
          foreignField: "_id",
          as: "dispatchHistoryUsers",
        },
      },
      // Additional lookup for dispatch references in dispatch history
      {
        $lookup: {
          from: "dispatches",
          localField: "dispatchHistory.dispatchId",
          foreignField: "_id",
          as: "dispatchHistoryDispatches",
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
    // For dispatched orders, filter by deliveryDate instead of slot dates
    if (dispatched === "true" && startDate && endDate && ready_for_dispatch !== "true") {
      const parseDate = (dateStr, isEnd = false) => {
        const [day, month, year] = dateStr.split("-");
        // Create date in UTC to avoid timezone issues
        const date = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 0, 0, 0, 0));
        if (isEnd) {
          date.setUTCHours(23, 59, 59, 999);
        }
        return date;
      };

      const start = parseDate(startDate);
      const end = parseDate(endDate, true);
      
      console.log(`Dispatched Orders Date Filter: ${startDate} to ${endDate}`);
      console.log(`Parsed dates: ${start.toISOString()} to ${end.toISOString()}`);
      
      pipeline.push({
        $match: {
          deliveryDate: {
            $gte: start,
            $lte: end
          }
        }
      });
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
          deliveryDate: 1, // Add deliveryDate (specific delivery date) to response
          orderPaymentStatus: 1,
          paymentCompleted: 1,
          dealerOrder: 1,
          dealer: 1, // Add dealer reference
          quotaSource: 1, // Add quota source (dealer/company/none)
          quotaUsed: 1, // Add quota used amount
          walletEntryId: 1, // Add wallet entry reference
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
          // Added order edit history with user info
          orderEditHistory: {
            $map: {
              input: { $ifNull: ["$orderEditHistory", []] },
              as: "edit",
              in: {
                field: "$$edit.field",
                previousValue: "$$edit.previousValue",
                newValue: "$$edit.newValue",
                notes: "$$edit.notes",
                createdAt: "$$edit.createdAt",
                changedBy: {
                  $cond: {
                    if: "$$edit.changedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$edit.changedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$orderEditHistoryUsers",
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
                                { _id: "$$edit.changedBy" }
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
          // Added dispatch history with user and dispatch info
          dispatchHistory: {
            $map: {
              input: { $ifNull: ["$dispatchHistory", []] },
              as: "dispatchEntry",
              in: {
                date: "$$dispatchEntry.date",
                quantity: "$$dispatchEntry.quantity",
                remainingAfterDispatch: "$$dispatchEntry.remainingAfterDispatch",
                dispatchId: "$$dispatchEntry.dispatchId",
                dispatch: {
                  $let: {
                    vars: {
                      dispatchIdStr: { $toString: "$$dispatchEntry.dispatchId" }
                    },
                    in: {
                      $arrayElemAt: [
                        {
                          $map: {
                            input: {
                              $filter: {
                                input: "$dispatchHistoryDispatches",
                                as: "dispatch",
                                cond: { $eq: [{ $toString: "$$dispatch._id" }, "$$dispatchIdStr"] }
                              }
                            },
                            as: "d",
                            in: {
                              _id: "$$d._id",
                              transportId: "$$d.transportId",
                              driverName: "$$d.driverName",
                              vehicleName: "$$d.vehicleName",
                              createdAt: "$$d.createdAt",
                            }
                          }
                        },
                        0
                      ]
                    }
                  }
                },
                processedBy: {
                  $cond: {
                    if: "$$dispatchEntry.processedBy",
                    then: {
                      $let: {
                        vars: {
                          userId: { $toString: "$$dispatchEntry.processedBy" }
                        },
                        in: {
                          $let: {
                            vars: {
                              userData: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: "$dispatchHistoryUsers",
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
                                { _id: "$$dispatchEntry.processedBy" }
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
          // Add orderFor field if present
          orderFor: 1,
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
