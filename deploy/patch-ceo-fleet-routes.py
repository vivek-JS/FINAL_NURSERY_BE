#!/usr/bin/env python3
"""Add CEO report + fleet-performance routes to production app.js."""
from pathlib import Path

APP = Path("/var/www/FINAL_NURSERY_BE/app.js")


def main():
    text = APP.read_text()

    if "getCeoFleetPerformance" not in text:
        ceo_import = """
import {
  getCeoReportCatalogHandler,
  getCeoOrderDeliveryFlow,
  getCeoOrderDeliveryBreakdown,
  getCeoSalesCollections,
  getCeoSalesCollectionAnalytics,
  getCeoSalesPerformance,
  getCeoTerritoryCollections,
  getCeoInventorySlots,
  getCeoOperations,
  getCeoFleetPerformance,
  getCeoReportOrders,
} from "./modules/ceoReport/ceoReport.controller.js";
"""
        anchor = '} from "./controllers/order.controller.js";'
        if anchor not in text:
            raise SystemExit("import anchor missing")
        text = text.replace(anchor, anchor + ceo_import, 1)

    if "ceo-report/catalog" not in text:
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
server.get("/api/v1/ceo-report/fleet-performance", ...adminMisAuth, getCeoFleetPerformance);
server.get("/api/v1/ceo-report/orders", ...adminMisAuth, getCeoReportOrders);
"""
        route_anchor = "  getAdminMisOrders\n);"
        if route_anchor not in text:
            raise SystemExit("route anchor missing")
        text = text.replace(route_anchor, route_anchor + ceo_routes, 1)
    elif "fleet-performance" not in text:
        text = text.replace(
            'server.get("/api/v1/ceo-report/operations", ...adminMisAuth, getCeoOperations);',
            'server.get("/api/v1/ceo-report/operations", ...adminMisAuth, getCeoOperations);\n'
            'server.get("/api/v1/ceo-report/fleet-performance", ...adminMisAuth, getCeoFleetPerformance);',
            1,
        )
        if "getCeoFleetPerformance" not in text:
            text = text.replace(
                "getCeoOperations,\n  getCeoReportOrders,",
                "getCeoOperations,\n  getCeoFleetPerformance,\n  getCeoReportOrders,",
                1,
            )

    APP.write_text(text)
    print("Patched app.js — CEO + fleet-performance routes ready")


if __name__ == "__main__":
    main()
