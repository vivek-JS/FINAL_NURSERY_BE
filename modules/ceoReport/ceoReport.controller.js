import catchAsync from "../../utility/catchAsync.js";
import { getCeoReportCatalog } from "./services/ceoReportCatalog.service.js";
import { fetchCeoOrderDeliveryFlow } from "./services/ceoOrderDeliveryFlow.service.js";
import { fetchCeoOrderDeliveryBreakdown } from "./services/ceoOrderDeliveryBreakdown.service.js";
import { fetchCeoSalesCollections } from "./services/ceoSalesCollections.service.js";
import { fetchCeoSalesCollectionAnalytics } from "./services/ceoSalesCollectionAnalytics.service.js";
import { fetchCeoSalesPerformance } from "./services/ceoSalesPerformance.service.js";
import { fetchCeoTerritoryCollections } from "./services/ceoTerritoryCollections.service.js";
import { fetchCeoInventorySlots } from "./services/ceoInventorySlots.service.js";
import { fetchCeoOperations } from "./services/ceoOperations.service.js";
import { fetchAdminMisOrders } from "../../services/adminMisOrders.service.js";

function respondCeo(res, result) {
  if (result.error) {
    return res.status(result.statusCode || 400).json({
      success: false,
      message: result.error,
    });
  }
  return res.status(200).json({
    success: true,
    data: result.data,
    meta: { source: "ceo-report", version: "ceo-v1" },
  });
}

export const getCeoReportCatalogHandler = catchAsync(async (req, res) => {
  return res.status(200).json({
    success: true,
    data: getCeoReportCatalog(),
  });
});

export const getCeoOrderDeliveryFlow = catchAsync(async (req, res) => {
  const result = await fetchCeoOrderDeliveryFlow(req.query);
  return respondCeo(res, result);
});

export const getCeoOrderDeliveryBreakdown = catchAsync(async (req, res) => {
  const result = await fetchCeoOrderDeliveryBreakdown(req.query);
  return respondCeo(res, result);
});

export const getCeoSalesCollections = catchAsync(async (req, res) => {
  const result = await fetchCeoSalesCollections(req.query);
  return respondCeo(res, result);
});

export const getCeoSalesCollectionAnalytics = catchAsync(async (req, res) => {
  const result = await fetchCeoSalesCollectionAnalytics(req.query);
  return respondCeo(res, result);
});

export const getCeoSalesPerformance = catchAsync(async (req, res) => {
  const result = await fetchCeoSalesPerformance(req.query);
  return respondCeo(res, result);
});

export const getCeoTerritoryCollections = catchAsync(async (req, res) => {
  const result = await fetchCeoTerritoryCollections(req.query);
  return respondCeo(res, result);
});

export const getCeoInventorySlots = catchAsync(async (req, res) => {
  const result = await fetchCeoInventorySlots(req.query);
  return respondCeo(res, result);
});

export const getCeoOperations = catchAsync(async (req, res) => {
  const result = await fetchCeoOperations(req.query);
  return respondCeo(res, result);
});

export const getCeoReportOrders = catchAsync(async (req, res) => {
  const result = await fetchAdminMisOrders(req.query);
  return respondCeo(res, result);
});
