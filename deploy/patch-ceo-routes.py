#!/usr/bin/env python3
"""Add CEO report imports + routes to production app.js without touching other code."""
from pathlib import Path

APP = Path("/var/www/FINAL_NURSERY_BE/app.js")

def main():
    text = APP.read_text()
    if "ceo-report/catalog" in text:
        print("CEO routes already present")
        return

    ceo_import = """import {
  getCeoReportCatalogHandler,
  getCeoOrderDeliveryFlow,
  getCeoOrderDeliveryBreakdown,
  getCeoSalesCollections,
  getCeoSalesCollectionAnalytics,
  getCeoSalesPerformance,
  getCeoTerritoryCollections,
  getCeoInventorySlots,
  getCeoOperations,
  getCeoReportOrders,
} from "./modules/ceoReport/ceoReport.controller.js";
"""

    anchor = '} from "./controllers/order.controller.js";'
    if anchor not in text:
        raise SystemExit("import anchor missing")
    text = text.replace(anchor, anchor + "\n" + ceo_import, 1)

    ceo_routes = """
server.get("/api/v1/ceo-report/catalog", ...adminMisAuth, getCeoReportCatalogHandler);
server.get("/api/v1/ceo-report/order-delivery-flow", ...adminMisAuth, getCeoOrderDeliveryFlow);
server.get(
  "/api/v1/ceo-report/order-delivery-flow/breakdown",
  ...adminMisAuth,
  getCeoOrderDeliveryBreakdown
);
server.get("/api/v1/ceo-report/sales-collections", ...adminMisAuth, getCeoSalesCollections);
server.get(
  "/api/v1/ceo-report/sales-collection-analytics",
  ...adminMisAuth,
  getCeoSalesCollectionAnalytics
);
server.get("/api/v1/ceo-report/sales-performance", ...adminMisAuth, getCeoSalesPerformance);
server.get(
  "/api/v1/ceo-report/territory-collections",
  ...adminMisAuth,
  getCeoTerritoryCollections
);
server.get("/api/v1/ceo-report/inventory-slots", ...adminMisAuth, getCeoInventorySlots);
server.get("/api/v1/ceo-report/operations", ...adminMisAuth, getCeoOperations);
server.get("/api/v1/ceo-report/orders", ...adminMisAuth, getCeoReportOrders);
"""

    route_anchor = "  getAdminMisOrders\n);"
    if route_anchor not in text:
        raise SystemExit("route anchor missing")
    text = text.replace(route_anchor, route_anchor + ceo_routes, 1)
    APP.write_text(text)
    print("Patched app.js with CEO routes")


if __name__ == "__main__":
    main()
