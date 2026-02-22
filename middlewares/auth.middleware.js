import { verifyAccessToken, extractToken, blacklistToken } from '../utility/jwtUtils.js';
import generateResponse from '../utility/responseFormat.js';
import AppError from '../utility/appError.js';
import User from '../models/user.model.js';

/**
 * Middleware to verify JWT token and attach user to request
 */
export const authenticateToken = async (req, res, next) => {
  try {
    // ============================================
    // BYPASS AUTH FOR PUBLIC ENDPOINTS
    // These endpoints must be accessible without any token
    // ============================================
    const publicPaths = [
      '/api/v1/public-links/config',
      '/api/v1/public-links/leads',
      '/api/v1/excel/download-unprocessed', // Allow unprocessed file downloads without auth
      '/api/v1/location', // Location endpoints are public
      '/api/v1/whatsapp-order/webhook', // WhatsApp webhook from Wati (public, no auth)
      '/api/v1/opt-in/webhook', // Opt-in/opt-out webhook from Wati (public, no auth)
      '/api/v1/public/follow-up' // Public follow-up endpoints (token-based access)
    ];

    // Check both req.path and req.originalUrl for public paths
    const requestPath = req.path || req.originalUrl || '';
    const isPublicPath = publicPaths.some(path => 
      requestPath.startsWith(path) || 
      (req.originalUrl && req.originalUrl.startsWith(path))
    );
    
    if (isPublicPath) {
      // Skip authentication completely for public endpoints
      console.log(`✅ Public endpoint accessed: ${requestPath}`);
      return next();
    }

    const token = extractToken(req);

    if (!token) {
      return res.status(401).json(
        generateResponse('error', 'Access token required', null, null)
      );
    }

    const decoded = verifyAccessToken(token);
    
    // Find user and check if still exists and is active
    const user = await User.findById(decoded._id).select('-password');
    
    if (!user) {
      return res.status(401).json(
        generateResponse('error', 'User not found', null, null)
      );
    }

    if (user.isDisabled) {
      return res.status(401).json(
        generateResponse('error', 'Account is disabled', null, null)
      );
    }

    // Attach user to request
    req.user = user;
    req.token = token;

    next();
  } catch (error) {
    return res.status(401).json(
      generateResponse('error', error.message || 'Invalid token', null, null)
    );
  }
};

/**
 * Middleware to check if user has required role(s)
 * Prioritizes jobTitle over role for all checks
 * @param {String|Array} roles - Required role(s)
 */
export const authorizeRoles = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json(
        generateResponse('error', 'Authentication required', null, null)
      );
    }

    // Prioritize role over jobTitle for authorization (role = security, jobTitle = display)
    const userRole = req.user.role || req.user.jobTitle;
    const requiredRoles = Array.isArray(roles) ? roles : [roles];

    if (!requiredRoles.includes(userRole)) {
      return res.status(403).json(
        generateResponse('error', 'Insufficient permissions', null, null)
      );
    }

    next();
  };
};

/**
 * Middleware to check if user is admin
 */
export const requireAdmin = authorizeRoles(['ADMIN', 'SUPER_ADMIN']);

/**
 * Middleware to check if user is salesperson
 */
export const requireSales = authorizeRoles(['SALES', 'ADMIN', 'SUPER_ADMIN']);

/**
 * Middleware to check if user is dealer
 */
export const requireDealer = authorizeRoles(['DEALER', 'ADMIN', 'SUPER_ADMIN']);

/**
 * Middleware to check if user is farmer
 */
export const requireFarmer = authorizeRoles(['FARMER', 'ADMIN', 'SUPER_ADMIN']);

/**
 * Middleware to check if user is accountant
 */
export const requireAccountant = authorizeRoles(['ACCOUNTANT', 'SUPER_ADMIN']);

/**
 * Middleware to check if user is office admin
 */
export const requireOfficeAdmin = authorizeRoles(['OFFICE_ADMIN', 'ADMIN', 'SUPER_ADMIN']);

/**
 * Middleware to check if user can perform payment operations
 * Only accountants and super admins can perform payment operations
 */
export const requirePaymentAccess = authorizeRoles(['ACCOUNTANT', 'SUPER_ADMIN']);

/**
 * Middleware to check if user can add payments
 * Office Admins can add payments (but only with PENDING status - enforced in controller)
 * Accountants and Super Admins can add payments with any status
 */
export const requirePaymentAddAccess = authorizeRoles(['ACCOUNTANT', 'SUPER_ADMIN', 'OFFICE_ADMIN']);

/**
 * Middleware to check if user owns the resource or is admin
 * @param {String} resourceIdField - Field name containing resource ID
 * @param {String} modelName - Model name for error messages
 */
export const requireOwnership = (resourceIdField = 'id', modelName = 'Resource') => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json(
          generateResponse('error', 'Authentication required', null, null)
        );
      }

      const resourceId = req.params[resourceIdField] || req.body[resourceIdField];
      
      if (!resourceId) {
        return res.status(400).json(
          generateResponse('error', `${modelName} ID required`, null, null)
        );
      }

      // Admins can access any resource - check role first (role = security)
      const userRole = req.user.role || req.user.jobTitle;
      if (['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
        return next();
      }

      // Check if user owns the resource
      const resource = await req.model.findById(resourceId);
      
      if (!resource) {
        return res.status(404).json(
          generateResponse('error', `${modelName} not found`, null, null)
        );
      }

      // Check ownership (assuming resource has userId field)
      if (resource.userId && resource.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json(
          generateResponse('error', 'Access denied to this resource', null, null)
        );
      }

      next();
    } catch (error) {
      return res.status(500).json(
        generateResponse('error', 'Internal server error', null, null)
      );
    }
  };
};

/**
 * Middleware to handle logout by blacklisting token
 */
export const logout = async (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (token) {
      blacklistToken(token);
    }

    // No cookies to clear - using localStorage

    return res.status(200).json(
      generateResponse('success', 'Logged out successfully', null, null)
    );
  } catch (error) {
    return res.status(500).json(
      generateResponse('error', 'Logout failed', null, null)
    );
  }
};

/**
 * Middleware to check if user is authenticated (optional)
 * Doesn't throw error if no token, just sets req.user if valid token exists
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (token) {
      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded._id).select('-password');
      
      if (user && !user.isDisabled) {
        req.user = user;
        req.token = token;
      }
    }

    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

/**
 * Middleware to validate request body for authentication
 */
export const validateAuthRequest = (req, res, next) => {
  const { phoneNumber, password } = req.body;

  if (!phoneNumber || !password) {
    return res.status(400).json(
      generateResponse('error', 'Phone number and password are required', null, null)
    );
  }

  // Validate phone number format (basic validation)
  const phoneRegex = /^[0-9]{10}$/;
  if (!phoneRegex.test(phoneNumber.toString())) {
    return res.status(400).json(
      generateResponse('error', 'Invalid phone number format', null, null)
    );
  }

  // Validate password length
  if (password.length < 6) {
    return res.status(400).json(
      generateResponse('error', 'Password must be at least 6 characters long', null, null)
    );
  }

  next();
};

/**
 * Middleware to check if user is active and not disabled
 */
export const checkUserStatus = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json(
        generateResponse('error', 'Authentication required', null, null)
      );
    }

    if (req.user.isDisabled) {
      return res.status(403).json(
        generateResponse('error', 'Account is disabled. Please contact administrator.', null, null)
      );
    }

    // Check if user's session is still valid (optional)
    // You can add additional checks here like last activity time

    next();
  } catch (error) {
    return res.status(500).json(
      generateResponse('error', 'Internal server error', null, null)
    );
  }
};

/**
 * Middleware to restrict RAM_AGRI_SALES_MANAGER to only allowed routes
 * RAM_AGRI_SALES_MANAGER can only access:
 * - Ram Agri Inputs Master (CRUD)
 * - Ram Agri Sales Dashboard
 * - Ram Agri Sales Rankboard
 * - Ram Agri Sales Targets
 * - Ram Agri Ledgers (Variety, Customer, Merchant)
 * - Agri Sales Orders (view/create)
 * - Inventory Dashboard (limited view)
 */
export const restrictRamAgriSalesManager = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(
      generateResponse('error', 'Authentication required', null, null)
    );
  }

  // Allow SUPER_ADMIN and ADMIN to access all routes - check role first (role = security)
  const userRole = req.user.role || req.user.jobTitle;
  if (['SUPER_ADMIN', 'ADMIN'].includes(userRole)) {
    return next();
  }

  // Check if user is RAM_AGRI_SALES_MANAGER - prioritize jobTitle
  const isRamAgriSalesManager = req.user.jobTitle === 'RAM_AGRI_SALES_MANAGER' || req.user.role === 'RAM_AGRI_SALES_MANAGER';
  
  if (!isRamAgriSalesManager) {
    // Not a RAM_AGRI_SALES_MANAGER, allow access
    return next();
  }

  // Get the route path
  const path = req.path || req.originalUrl || '';
  
  // Allowed routes for RAM_AGRI_SALES_MANAGER
  const allowedRoutes = [
    '/ram-agri-inputs',           // Ram Agri Inputs Master (all operations)
    '/ram-agri-sales-dashboard',  // Dashboard
    '/ram-agri-sales-rankboard',  // Rankboard
    '/ram-agri-sales-targets',   // Targets (GET and POST)
    '/ram-agri-variety-ledger',   // Variety Ledger
    '/ram-agri-customer-ledger',  // Customer Ledger
    '/ram-agri-merchant-ledger',  // Merchant Ledger
    '/agri-sales-orders',         // Agri Sales Orders (view/create/manage)
    '/dashboard',                 // Inventory Dashboard (limited view)
  ];

  // Check if the route is allowed
  const isAllowed = allowedRoutes.some(route => {
    // Exact match or starts with (for routes with IDs like /ram-agri-inputs/:id)
    return path === route || path.startsWith(route + '/');
  });

  if (!isAllowed) {
    return res.status(403).json(
      generateResponse(
        'error',
        'Access denied. RAM_AGRI_SALES_MANAGER can only access Ram Agri Input related routes.',
        null,
        null
      )
    );
  }

  next();
}; 