export const getDashboardInsights = async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      // Parse dates or use defaults (last 30 days)
      const parsedStartDate = startDate 
        ? new Date(startDate) 
        : new Date(new Date().setDate(new Date().getDate() - 30));
      
      const parsedEndDate = endDate 
        ? new Date(endDate) 
        : new Date();
      
      // Set time to end of day for end date
      parsedEndDate.setHours(23, 59, 59, 999);
  
      // Date filter for all queries
      const dateFilter = { 
        createdAt: { 
          $gte: parsedStartDate, 
          $lte: parsedEndDate 
        } 
      };
  
      // Run all aggregations in parallel for better performance
      const [
        orderStats,
        ordersByDate,
        ordersByPlant,
        ordersBySalesPerson,
        slotBookingStats,
        paymentStats,
        deliveryStats,
        regionalStats
      ] = await Promise.all([
        // 1. Overall order statistics
        getOrderStats(dateFilter),
        
        // 2. Orders grouped by date (daily trend)
        getOrdersByDate(dateFilter),
        
        // 3. Orders grouped by plant
        getOrdersByPlant(dateFilter),
        
        // 4. Orders grouped by sales person
        getOrdersBySalesPerson(dateFilter),
        
        // 5. Slot booking statistics
        getSlotBookingStats(dateFilter, parsedStartDate, parsedEndDate),
        
        // 6. Payment statistics
        getPaymentStats(dateFilter),
        
        // 7. Delivery and status statistics
        getDeliveryStats(dateFilter),
        
        // 8. Regional statistics (by state/district)
        getRegionalStats(dateFilter)
      ]);
      
      res.status(200).json({
        success: true,
        dateRange: {
          startDate: parsedStartDate,
          endDate: parsedEndDate
        },
        data: {
          orderStats,
          ordersByDate,
          ordersByPlant,
          ordersBySalesPerson,
          slotBookingStats,
          paymentStats,
          deliveryStats,
          regionalStats
        }
      });
      
    } catch (error) {
      console.error('Dashboard insights error:', error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch dashboard insights",
        error: error.message
      });
    }
  };
  
  /**
   * Get overall order statistics
   */
  async function getOrderStats(dateFilter) {
    // Basic order metrics
    const [
      orderCounts,
      totalPlants,
      totalRevenue
    ] = await Promise.all([
      // Get counts for different order statuses
      Order.aggregate([
        { $match: dateFilter },
        { 
          $group: {
            _id: "$orderStatus",
            count: { $sum: 1 }
          }
        }
      ]),
      
      // Total plants ordered
      Order.aggregate([
        { $match: dateFilter },
        { 
          $group: {
            _id: null,
            total: { $sum: "$numberOfPlants" },
            returned: { $sum: "$returnedPlants" },
            remaining: { $sum: "$remainingPlants" }
          }
        }
      ]),
      
      // Total revenue and payment status
      Order.aggregate([
        { $match: dateFilter },
        { 
          $group: {
            _id: "$orderPaymentStatus",
            count: { $sum: 1 },
            revenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } }
          }
        }
      ])
    ]);
    
    // Format the results for easier consumption
    const statusCounts = {};
    orderCounts.forEach(status => {
      statusCounts[status._id] = status.count;
    });
    
    const plants = totalPlants.length > 0 ? totalPlants[0] : { total: 0, returned: 0, remaining: 0 };
    
    const revenue = {
      total: 0,
      collected: 0,
      pending: 0
    };
    
    totalRevenue.forEach(status => {
      revenue.total += status.revenue;
      if (status._id === "COMPLETED") {
        revenue.collected += status.revenue;
      } else {
        revenue.pending += status.revenue;
      }
    });
    
    return {
      orderCount: orderCounts.reduce((sum, item) => sum + item.count, 0),
      statusDistribution: statusCounts,
      plants,
      revenue
    };
  }
  
  /**
   * Get orders grouped by date
   */
  async function getOrdersByDate(dateFilter) {
    return Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: {
            date: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
            }
          },
          count: { $sum: 1 },
          plants: { $sum: "$numberOfPlants" },
          revenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } }
        }
      },
      {
        $project: {
          _id: 0,
          date: "$_id.date",
          count: 1,
          plants: 1,
          revenue: 1
        }
      },
      { $sort: { date: 1 } }
    ]);
  }
  
  /**
   * Get orders grouped by plant
   */
  async function getOrdersByPlant(dateFilter) {
    return Order.aggregate([
      { $match: dateFilter },
      {
        $lookup: {
          from: 'plantcms',
          localField: 'plantName',
          foreignField: '_id',
          as: 'plantDetails'
        }
      },
      {
        $lookup: {
          from: 'plantcms',
          let: { plantId: '$plantName', subtypeId: '$plantSubtype' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$plantId'] } } },
            { $unwind: '$subtypes' },
            { $match: { $expr: { $eq: ['$subtypes._id', '$$subtypeId'] } } },
            { $project: { 'subtypeName': '$subtypes.name' } }
          ],
          as: 'subtypeDetails'
        }
      },
      {
        $group: {
          _id: {
            plantId: "$plantName",
            subtypeId: "$plantSubtype"
          },
          plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
          subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } },
          orderCount: { $sum: 1 },
          plantCount: { $sum: "$numberOfPlants" },
          revenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          returnCount: { $sum: "$returnedPlants" },
          returnRate: {
            $avg: {
              $cond: [
                { $gt: ["$numberOfPlants", 0] },
                { $divide: ["$returnedPlants", "$numberOfPlants"] },
                0
              ]
            }
          },
          statusCounts: {
            $push: "$orderStatus"
          }
        }
      },
      {
        $addFields: {
          statusDistribution: {
            PENDING: {
              $size: {
                $filter: {
                  input: "$statusCounts",
                  as: "status",
                  cond: { $eq: ["$$status", "PENDING"] }
                }
              }
            },
            PROCESSING: {
              $size: {
                $filter: {
                  input: "$statusCounts",
                  as: "status",
                  cond: { $eq: ["$$status", "PROCESSING"] }
                }
              }
            },
            COMPLETED: {
              $size: {
                $filter: {
                  input: "$statusCounts",
                  as: "status",
                  cond: { $eq: ["$$status", "COMPLETED"] }
                }
              }
            },
            CANCELLED: {
              $size: {
                $filter: {
                  input: "$statusCounts",
                  as: "status",
                  cond: { $eq: ["$$status", "CANCELLED"] }
                }
              }
            },
            DISPATCHED: {
              $size: {
                $filter: {
                  input: "$statusCounts",
                  as: "status",
                  cond: { $eq: ["$$status", "DISPATCHED"] }
                }
              }
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          plantId: "$_id.plantId",
          subtypeId: "$_id.subtypeId",
          plantName: 1,
          subtypeName: 1,
          orderCount: 1,
          plantCount: 1,
          revenue: 1,
          returnCount: 1,
          returnRate: 1,
          statusDistribution: 1
        }
      },
      { $sort: { plantCount: -1 } }
    ]);
  }
  
  /**
   * Get orders grouped by sales person
   */
  async function getOrdersBySalesPerson(dateFilter) {
    return Order.aggregate([
      { $match: dateFilter },
      {
        $lookup: {
          from: 'users',
          localField: 'salesPerson',
          foreignField: '_id',
          as: 'salesPersonDetails'
        }
      },
      {
        $group: {
          _id: "$salesPerson",
          salesPersonName: { $first: { $arrayElemAt: ["$salesPersonDetails.name", 0] } },
          orderCount: { $sum: 1 },
          plantCount: { $sum: "$numberOfPlants" },
          revenue: { $sum: { $multiply: ["$rate", "$numberOfPlants"] } },
          uniqueCustomers: { 
            $addToSet: { 
              $cond: [
                { $eq: ["$dealerOrder", true] },
                "$dealer",
                "$farmer"
              ]
            } 
          },
          returnedPlants: { $sum: "$returnedPlants" },
          completedOrders: {
            $sum: {
              $cond: [
                { $eq: ["$orderStatus", "COMPLETED"] },
                1,
                0
              ]
            }
          },
          cancelledOrders: {
            $sum: {
              $cond: [
                { $eq: ["$orderStatus", "CANCELLED"] },
                1,
                0
              ]
            }
          },
          dailyBreakdown: {
            $push: {
              date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              plants: "$numberOfPlants",
              revenue: { $multiply: ["$rate", "$numberOfPlants"] }
            }
          }
        }
      },
      {
        $addFields: {
          uniqueCustomerCount: { $size: "$uniqueCustomers" },
          returnRate: {
            $cond: [
              { $gt: ["$plantCount", 0] },
              { $divide: ["$returnedPlants", "$plantCount"] },
              0
            ]
          },
          completionRate: {
            $cond: [
              { $gt: ["$orderCount", 0] },
              { $divide: ["$completedOrders", "$orderCount"] },
              0
            ]
          }
        }
      },
      {
        $project: {
          _id: 0,
          salesPersonId: "$_id",
          salesPersonName: 1,
          orderCount: 1,
          plantCount: 1,
          revenue: 1,
          uniqueCustomerCount: 1,
          returnedPlants: 1,
          returnRate: 1,
          completedOrders: 1,
          cancelledOrders: 1,
          completionRate: 1
        }
      },
      { $sort: { revenue: -1 } }
    ]);
  }
  
  /**
   * Get slot booking statistics
   */
  async function getSlotBookingStats(dateFilter, startDate, endDate) {
    // Get the current year or selected year range
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    
    // Build a match query for plant slots
    const slotMatchQuery = {
      year: { $gte: startYear, $lte: endYear }
    };
    
    return PlantSlot.aggregate([
      { $match: slotMatchQuery },
      { $unwind: "$subtypeSlots" },
      { $unwind: "$subtypeSlots.slots" },
      {
        $lookup: {
          from: 'plantcms',
          localField: 'plantId',
          foreignField: '_id',
          as: 'plantDetails'
        }
      },
      {
        $lookup: {
          from: 'plantcms',
          let: { plantId: '$plantId', subtypeId: '$subtypeSlots.subtypeId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$plantId'] } } },
            { $unwind: '$subtypes' },
            { $match: { $expr: { $eq: ['$subtypes._id', '$$subtypeId'] } } },
            { $project: { 'subtypeName': '$subtypes.name' } }
          ],
          as: 'subtypeDetails'
        }
      },
      {
        $addFields: {
          availableCapacity: { 
            $subtract: ["$subtypeSlots.slots.totalPlants", "$subtypeSlots.slots.totalBookedPlants"] 
          },
          utilizationRate: {
            $cond: [
              { $gt: ["$subtypeSlots.slots.totalPlants", 0] },
              { 
                $multiply: [
                  { $divide: ["$subtypeSlots.slots.totalBookedPlants", "$subtypeSlots.slots.totalPlants"] },
                  100
                ]
              },
              0
            ]
          }
        }
      },
      {
        $group: {
          _id: {
            plantId: "$plantId",
            subtypeId: "$subtypeSlots.subtypeId",
            month: "$subtypeSlots.slots.month"
          },
          plantName: { $first: { $arrayElemAt: ["$plantDetails.name", 0] } },
          subtypeName: { $first: { $arrayElemAt: ["$subtypeDetails.subtypeName", 0] } },
          totalCapacity: { $sum: "$subtypeSlots.slots.totalPlants" },
          bookedCapacity: { $sum: "$subtypeSlots.slots.totalBookedPlants" },
          availableCapacity: { $sum: "$availableCapacity" },
          avgUtilizationRate: { $avg: "$utilizationRate" },
          slots: {
            $push: {
              startDay: "$subtypeSlots.slots.startDay",
              endDay: "$subtypeSlots.slots.endDay",
              totalPlants: "$subtypeSlots.slots.totalPlants",
              totalBookedPlants: "$subtypeSlots.slots.totalBookedPlants",
              availableCapacity: "$availableCapacity",
              utilizationRate: "$utilizationRate",
              overflow: "$subtypeSlots.slots.overflow"
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          plantId: "$_id.plantId",
          subtypeId: "$_id.subtypeId",
          month: "$_id.month",
          plantName: 1,
          subtypeName: 1,
          totalCapacity: 1,
          bookedCapacity: 1,
          availableCapacity: 1,
          avgUtilizationRate: 1,
          slots: 1
        }
      },
      { $sort: { month: 1, avgUtilizationRate: -1 } }
    ]);
  }
  
  /**
   * Get payment statistics
   */
  async function getPaymentStats(dateFilter) {
    return Order.aggregate([
      { $match: dateFilter },
      { $unwind: { path: "$payment", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            paymentStatus: "$payment.paymentStatus",
            modeOfPayment: "$payment.modeOfPayment"
          },
          count: { $sum: 1 },
          amount: { $sum: "$payment.paidAmount" },
          dates: { $push: "$payment.paymentDate" }
        }
      },
      {
        $group: {
          _id: "$_id.paymentStatus",
          total: { $sum: "$amount" },
          count: { $sum: "$count" },
          byMethod: {
            $push: {
              method: "$_id.modeOfPayment",
              count: "$count",
              amount: "$amount"
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          status: "$_id",
          total: 1,
          count: 1,
          byMethod: {
            $filter: {
              input: "$byMethod",
              as: "method",
              cond: { $ne: ["$$method.method", null] }
            }
          }
        }
      }
    ]);
  }
  
  /**
   * Get delivery and status statistics
   */
  async function getDeliveryStats(dateFilter) {
    // Status change metrics
    const statusChanges = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: { path: "$statusChanges", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            previousStatus: "$statusChanges.previousStatus",
            newStatus: "$statusChanges.newStatus"
          },
          count: { $sum: 1 },
          avgTimeInPreviousStatus: {
            $avg: {
              $subtract: ["$statusChanges.createdAt", "$createdAt"]
            }
          }
        }
      },
      {
        $match: {
          "_id.previousStatus": { $ne: null },
          "_id.newStatus": { $ne: null }
        }
      },
      {
        $project: {
          _id: 0,
          previousStatus: "$_id.previousStatus",
          newStatus: "$_id.newStatus",
          count: 1,
          avgDaysInPreviousStatus: {
            $divide: ["$avgTimeInPreviousStatus", 1000 * 60 * 60 * 24]
          }
        }
      },
      { $sort: { count: -1 } }
    ]);
    
    // Delivery change metrics
    const deliveryChanges = await Order.aggregate([
      { $match: dateFilter },
      {
        $project: {
          orderId: 1,
          numberOfPlants: 1,
          deliveryChangesCount: { 
            $cond: [
              { $isArray: "$deliveryChanges" },
              { $size: "$deliveryChanges" },
              0
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          ordersWithDeliveryChanges: {
            $sum: {
              $cond: [
                { $gt: ["$deliveryChangesCount", 0] },
                1,
                0
              ]
            }
          },
          avgDeliveryChangesPerOrder: {
            $avg: "$deliveryChangesCount"
          }
        }
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          ordersWithDeliveryChanges: 1,
          avgDeliveryChangesPerOrder: 1,
          deliveryChangePercentage: {
            $multiply: [
              {
                $divide: ["$ordersWithDeliveryChanges", "$totalOrders"]
              },
              100
            ]
          }
        }
      }
    ]);
    
    return {
      statusTransitions: statusChanges,
      deliveryChanges: deliveryChanges.length > 0 ? deliveryChanges[0] : {
        totalOrders: 0,
        ordersWithDeliveryChanges: 0,
        avgDeliveryChangesPerOrder: 0,
        deliveryChangePercentage: 0
      }
    };
  }
  
  /**
   * Get regional statistics (by state/district)
   */
  async function getRegionalStats(dateFilter) {
    // User default locations may be used if available
    // This requires the farmer or dealer data to be linked with location
    return [];
  }