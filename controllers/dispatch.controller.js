import generateResponse from "../utility/responseFormat.js";
import catchAsync from "../utility/catchAsync.js";
import AppError from "../utility/appError.js";
import Dispatch from "../models/dispatch.model.js";  
import Order from "../models/order.model.js";
import mongoose from "mongoose";
import PlantCms from "../models/plantCms.model.js";
// Helper to validate quantities
const validateQuantities = (plantsDetails) => {
  for (const plant of plantsDetails) {
    // Calculate total pickup quantity
    const pickupTotal = plant.pickupDetails.reduce(
      (sum, detail) => sum + detail.quantity, 
      0
    );
    
    // Calculate total crate quantity
    const crateTotal = plant.crates.reduce(
      (sum, crate) => sum + crate.quantity, 
      0
    );

    // Check if totals match plant quantity
    if (pickupTotal !== plant.quantity) {
      throw new AppError(
        `Pickup details total (${pickupTotal}) doesn't match plant quantity (${plant.quantity}) for ${plant.name}`,
        400
      );
    }


  }
};

// Generate unique transport ID
const generateTransportId = async () => {
    // Get total count of all dispatches
    const count = await Dispatch.countDocuments();
    // Simply add 1 to get the next ID
    return (count + 1).toString();
  };

  const createDispatch = catchAsync(async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();
   
    try {
      const dispatchRequest = { ...req.body };
      
      // Modify each plant's details
      dispatchRequest.plantsDetails = dispatchRequest.plantsDetails.map(plant => ({
        ...plant,
        totalPlants: plant.pickupDetails.reduce((sum, detail) => sum + detail.quantity, 0),
        crates: plant.crates.map(crate => ({
          cavity: crate.cavity,
          cavityName: crate.cavityName,
          crateCount: crate.crateDetails.reduce((sum, detail) => sum + detail.crateCount, 0),
          plantCount: crate.crateDetails.reduce((sum, detail) => sum + detail.plantCount, 0),
          crateDetails: crate.crateDetails
        }))
      }));
   
      validateQuantities(dispatchRequest.plantsDetails);
      dispatchRequest.transportId = await generateTransportId();
      
      const dispatch = await Dispatch.create([dispatchRequest], { session });
   
      await Order.updateMany(
        { _id: { $in: dispatchRequest.orderIds }, orderStatus: "FARM_READY" },
        { $set: { orderStatus: "DISPATCH_PROCESS" } },
        { session }
      );
   
      await session.commitTransaction();
      
      res.status(201).json(generateResponse("Success", 
        "Dispatch created successfully and orders updated", dispatch[0]));
   
    } catch (error) {
      await session.abortTransaction();
      next(error);
    } finally {
      session.endSession();
    }
   });
// Update dispatch controller

const updateDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // If plants details are being updated, validate quantities
  if (req.body.plantsDetails) {
    validateQuantities(req.body.plantsDetails);
  }

  // Prevent updating transportId
  if (req.body.transportId) {
    delete req.body.transportId;
  }

  const dispatch = await Dispatch.findByIdAndUpdate(
    id,
    req.body,
    { new: true, runValidators: true }
  );

  if (!dispatch) {
    return next(new AppError("No dispatch found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Dispatch updated successfully",
    dispatch
  );

  res.status(200).json(response);
});

// Get dispatches controller
const getDispatches = catchAsync(async (req, res, next) => {
  const dispatches = await Dispatch.aggregate([
    {
      $lookup: {
        from: 'orders',
        localField: 'orderIds',
        foreignField: '_id',
        as: 'orderIds'
      }
    },
    {
      $unwind: '$orderIds'
    },
    {
      // Lookup farmer details
      $lookup: {
        from: 'farmers',
        localField: 'orderIds.farmer',
        foreignField: '_id',
        as: 'orderIds.farmer'
      }
    },
    {
      // Lookup sales person details
      $lookup: {
        from: 'users',
        localField: 'orderIds.salesPerson',
        foreignField: '_id',
        as: 'orderIds.salesPerson'
      }
    },
    {
      // Lookup plant details
      $lookup: {
        from: 'plantcms',
        localField: 'orderIds.plantName',
        foreignField: '_id',
        as: 'orderIds.plantName'
      }
    },
    {
      // Lookup booking slot details
      $lookup: {
        from: 'plantslots',
        let: { bookingSlotId: '$orderIds.bookingSlot' },
        pipeline: [
          { $unwind: '$subtypeSlots' },
          { $unwind: '$subtypeSlots.slots' },
          {
            $match: {
              $expr: { $eq: ['$subtypeSlots.slots._id', '$$bookingSlotId'] }
            }
          },
          {
            $project: {
              _id: 0,
              slotId: '$subtypeSlots.slots._id',
              startDay: '$subtypeSlots.slots.startDay',
              endDay: '$subtypeSlots.slots.endDay',
              subtypeId: '$subtypeSlots.subtypeId',
              month: '$subtypeSlots.slots.month'
            }
          }
        ],
        as: 'orderIds.bookingSlotDetails'
      }
    },
    {
      $group: {
        _id: '$_id',
        name: { $first: '$name' },
        transportId: { $first: '$transportId' },
        driverName: { $first: '$driverName' },
        vehicleName: { $first: '$vehicleName' },
        plantsDetails: { $first: '$plantsDetails' },
        orderIds: { 
          $push: {
            $mergeObjects: [
              '$orderIds',
              {
                farmer: { $arrayElemAt: ['$orderIds.farmer', 0] },
                salesPerson: { $arrayElemAt: ['$orderIds.salesPerson', 0] },
                plantName: { $arrayElemAt: ['$orderIds.plantName', 0] },
                bookingSlot: { $arrayElemAt: ['$orderIds.bookingSlotDetails', 0] }
              }
            ]
          }
        }
      }
    }
  ]);

  const transformedDispatches = dispatches.map(dispatch => ({
    ...dispatch,
    driverName: dispatch.driverName,
    vehicleName: dispatch.vehicleName,
    transportId: dispatch.transportId,
    plantsDetails: dispatch.plantsDetails.map(plant => ({
      ...plant,
      pickupDetails: plant.pickupDetails.map(pickup => ({
        shade: pickup.shade,
        shadeName: pickup.shadeName,
        quantity: pickup.quantity
      })),
      crates: [{
        cavity: plant.crates[0].cavity,
        cavityName: plant.crates[0].cavityName,
        crateCount: plant.crates[0].crateCount,
        plantCount: plant.crates[0].plantCount,
        crateDetails: plant.crates[0].crateDetails
      }]
    })),
    orderIds: dispatch.orderIds.map(order => ({
      order: order.orderId,
      plantDetails: {
        name: order.plantName?.name || '',
        variety: order.plantName?.variety || '',
        type: order.plantName?.type || '',
        subtype: order.plantName?.subtype || ''
      },
      farmerName: order.farmer?.name || '',
      contact: order.farmer?.mobileNumber || '',
      quantity: order.numberOfPlants,
      orderDate: new Date(order.createdAt).toLocaleDateString(),
      rate: order.rate,
      total: `₹ ${order.rate * order.numberOfPlants}`,
      "Paid Amt": `₹ ${order.payment.reduce((sum, p) => sum + (p.paidAmount || 0), 0)}`,
      "remaining Amt": `₹ ${(order.rate * order.numberOfPlants) - order.payment.reduce((sum, p) => sum + (p.paidAmount || 0), 0)}`,
      orderStatus: order.orderStatus,
      Delivery: order.bookingSlot ? 
        `${order.bookingSlot.startDay} - ${order.bookingSlot.endDay} ${order.bookingSlot.month}, ${new Date().getFullYear()}` : '',
      details: {
        farmer: {
          name: order.farmer?.name || '',
          mobileNumber: order.farmer?.mobileNumber || '',
          village: order.farmer?.village || ''
        },
        contact: order.farmer?.mobileNumber || '',
        orderNotes: order.notes || '',
        payment: order.payment || [],
        orderid: order._id,
        salesPerson: {
          name: order.salesPerson?.name || '',
          phoneNumber: order.salesPerson?.phoneNumber || ''
        },
        bookingSlot: {
          startDay: order.bookingSlot?.startDay || '',
          endDay: order.bookingSlot?.endDay || '',
          month: order.bookingSlot?.month || '',
          subtypeId: order.plantSubtype || '',
          _id: order.bookingSlot?.slotId || ''
        }
      }
    }))
  }));

  res.status(200).json(generateResponse("Success", "Dispatches fetched successfully", transformedDispatches));
});
// Get single dispatch controller
const getDispatch = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const dispatch = await Dispatch.findById(id)
    .populate('orderIds', 'orderNumber')
    .select('-__v');

  if (!dispatch) {
    return next(new AppError("No dispatch found with that ID", 404));
  }

  const response = generateResponse(
    "Success",
    "Dispatch fetched successfully",
    dispatch
  );

  res.status(200).json(response);
});


const removeTransport = async (req, res) => {
  try {
    const { transportId } = req.params;

    // Find and completely remove the dispatch document
    const dispatch = await Dispatch.findOneAndDelete({ transportId });
    
    if (!dispatch) {
      return res.status(404).json({
        success: false,
        message: 'Transport not found'
      });
    }

    // Get order IDs before deletion
    const affectedOrderIds = [...dispatch.orderIds];

    // Update all associated orders' status to FARM_READY
    const updateOrdersResult = await Order.updateMany(
      { _id: { $in: affectedOrderIds } },
      { $set: { orderStatus: 'FARM_READY' } }
    );

    return res.status(200).json({
      success: true,
      message: 'Transport removed and orders updated successfully',
      data: {
        transportId: dispatch.transportId,
        affectedOrders: updateOrdersResult.modifiedCount
      }
    });

  } catch (error) {
    console.error('Error in removeTransport:', error);
    return res.status(500).json({
      success: false,
      message: 'Error removing transport',
      error: error.message
    });
  }
};  
// Route definition (to be added in routes file):
// router.delete('/transport/:transportId', removeTransport);
  
export { 
  createDispatch, 
  updateDispatch, 
  getDispatches, 
  getDispatch ,
  removeTransport
};