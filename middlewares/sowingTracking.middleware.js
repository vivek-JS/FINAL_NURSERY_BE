/**
 * Middleware to track primary sowing entries and packet/inventory entries
 * Ensures user information is captured for all entries
 */

/**
 * Middleware to ensure user is tracked for primary sowing updates
 * Attaches userId to req.body if not present
 */
export const trackPrimarySowingMiddleware = (req, res, next) => {
  // Ensure performedBy is set from authenticated user
  if (req.user && req.user._id && !req.body.performedBy) {
    req.body.performedBy = req.user._id;
  }

  // Also ensure userId is available in body for tracking
  if (req.user && req.user._id) {
    req.body.userId = req.user._id;
  }

  next();
};

/**
 * Middleware to ensure user is tracked for inventory/packet entries
 * Attaches userId to req.body for inventory transactions
 */
export const trackPacketEntryMiddleware = (req, res, next) => {
  // For inventory inward/outward transactions
  if (req.user && req.user._id) {
    // Ensure receivedBy or issuedBy is set
    if (!req.body.receivedBy && !req.body.issuedBy) {
      // Set based on transaction type
      if (req.path.includes('inward') || req.path.includes('inventory-inward')) {
        req.body.receivedBy = req.user._id;
      } else if (req.path.includes('outward') || req.path.includes('inventory-outward')) {
        req.body.issuedBy = req.user._id;
      }
    }

    // Also set performedBy for tracking
    if (!req.body.performedBy) {
      req.body.performedBy = req.user._id;
    }

    // Set userId for general tracking
    req.body.userId = req.user._id;
  }

  next();
};

export default {
  trackPrimarySowingMiddleware,
  trackPacketEntryMiddleware,
};



