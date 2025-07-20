# Enhanced Analytics System - Summary
## Overview
The analytics system has been significantly enhanced with order date-based trending, plant subtype booking analysis, and comprehensive visualization endpoints. All endpoints now use `orderBookingDate` instead of `createdAt` for more accurate business analytics.

## Key Improvements

### 1. Order Date-Based Analytics
- **Changed from `createdAt` to `orderBookingDate`**: All analytics now use the actual order booking date for more accurate business insights
- **Better trend analysis**: Time-based analytics now reflect when orders were actually placed, not when records were created
- **Improved filtering**: Date ranges now work with actual business dates

### 2. New Visualization Endpoints

#### Plant Subtype Booking Trends
**Endpoint**: `GET /api/v1/analytics/plant-subtype-trends`
- **Purpose**: Track booking trends for specific plant subtypes over time
- **Parameters**: 
  - `startDate`, `endDate`: Date range filtering
  - `groupBy`: 'month', 'week', or 'day' grouping
  - `plantId`: Filter by specific plant
- **Returns**: 
  - `subtypeTrends`: Time-series data for plant subtype bookings
  - `topSubtypes`: Top performing plant subtypes
  - `summary`: Aggregate statistics

#### Order Status Distribution (Pie Chart Data)
**Endpoint**: `GET /api/v1/analytics/order-status-distribution`
- **Purpose**: Distribution of orders by status (PENDING, COMPLETED, CANCELLED, etc.)
- **Parameters**: `startDate`, `endDate`
- **Returns**:
  - `orderStatusDistribution`: Order status breakdown with percentages
  - `paymentStatusDistribution`: Payment status breakdown
  - `summary`: Total orders, revenue, completed/pending counts

#### Customer Type Distribution (Pie Chart Data)
**Endpoint**: `GET /api/v1/analytics/customer-type-distribution`
- **Purpose**: Distribution of orders by customer type (Farmer vs Dealer)
- **Parameters**: `startDate`, `endDate`
- **Returns**:
  - `customerTypeDistribution`: Customer type breakdown with percentages
  - `summary`: Total customers, revenue, farmer/dealer counts

#### Revenue Trends by Time Period
**Endpoint**: `GET /api/v1/analytics/revenue-trends`
- **Purpose**: Revenue trends over time with completion rates
- **Parameters**: 
  - `startDate`, `endDate`
  - `groupBy`: 'month', 'week', or 'day'
- **Returns**:
  - `revenueTrends`: Time-series revenue data with completion rates
  - `summary`: Total revenue, orders, average metrics

#### Plant Performance Comparison (Bar Chart Data)
**Endpoint**: `GET /api/v1/analytics/plant-performance-comparison`
- **Purpose**: Compare plant performance across different metrics
- **Parameters**: 
  - `startDate`, `endDate`
  - `limit`: Number of top plants to return (default: 10)
- **Returns**:
  - `plantPerformance`: Plant performance data with completion/cancellation rates
  - `summary`: Aggregate performance metrics

### 3. Enhanced Existing Endpoints

All existing endpoints have been updated to use `orderBookingDate`:

- **Dashboard Analytics**: Now uses order booking date for all metrics
- **Profit & Loss Analysis**: Based on actual order dates
- **Sales Performance Analysis**: Sales trends by order booking date
- **Plant Performance Analysis**: Plant metrics by order date
- **Customer Analytics**: Customer behavior by order date
- **Monthly Trends**: Monthly analysis by order booking date
- **District Analytics**: Geographic analysis by order date
- **Slot Analytics**: Slot performance by order date
- **Enhanced Customer Analytics**: Customer insights by order date
- **Payment Analytics**: Payment trends by order date

## Data Structure Improvements

### Order Status Mapping
- **COMPLETED** = Sold orders
- **ACCEPTED** = Accepted orders  
- **PENDING** = Booked orders
- **CANCELLED** = Cancelled orders

### Plant Subtype Integration
- All plant-related analytics now include both plant name and subtype
- Proper lookup to PlantCms collection for plant and subtype names
- Display names formatted as "Plant Name - Subtype Name"

### Customer Type Classification
- **Farmer**: `dealerOrder: false`
- **Dealer**: `dealerOrder: true`

## Chart Types Supported

### Pie Charts
- Order Status Distribution
- Payment Status Distribution  
- Customer Type Distribution

### Bar Charts
- Plant Performance Comparison
- Top Performing Plants
- Salesmen Performance

### Line Charts
- Revenue Trends
- Plant Subtype Trends
- Monthly Trends

### Area Charts
- Order Volume Trends
- Revenue Over Time

## Usage Examples

### Get Plant Subtype Trends
```bash
curl -X GET "http://localhost:8000/api/v1/analytics/plant-subtype-trends?startDate=2024-01-01&endDate=2024-12-31&groupBy=month" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get Order Status Distribution
```bash
curl -X GET "http://localhost:8000/api/v1/analytics/order-status-distribution?startDate=2024-01-01&endDate=2024-12-31" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get Revenue Trends
```bash
curl -X GET "http://localhost:8000/api/v1/analytics/revenue-trends?groupBy=week" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Benefits

1. **Accurate Business Intelligence**: Using order booking dates instead of record creation dates
2. **Comprehensive Visualizations**: Multiple chart types for different analytics needs
3. **Real-time Data**: All data comes from actual database records, no dummy data
4. **Flexible Filtering**: Date ranges, plant filters, customer type filters
5. **Performance Metrics**: Completion rates, cancellation rates, revenue trends
6. **Customer Insights**: Customer type analysis, retention metrics
7. **Plant Intelligence**: Subtype-level analysis, performance comparison

## Technical Notes

- All endpoints require JWT authentication
- Date parameters should be in ISO format (YYYY-MM-DD)
- All monetary values are in the base currency
- Percentages are calculated and returned as numbers (0-100)
- Time-based grouping supports month, week, and day granularity
- Proper error handling for missing or invalid parameters 