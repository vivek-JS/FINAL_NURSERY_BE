import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// JWT Configuration - Read environment variables dynamically
const getJWTConfig = () => ({
  ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY || '15m',
  REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY || '7d',
  JWT_SECRET: process.env.JWT_SECRET || process.env.PRIVATE_KEY,
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET || (process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY + '_refresh' : undefined)
});

// Token blacklist for logout functionality
const tokenBlacklist = new Set();

/**
 * Generate access token
 * @param {Object} payload - Token payload
 * @returns {String} Access token
 */
export const generateAccessToken = (payload) => {
  try {
    const JWT_CONFIG = getJWTConfig();
    console.log('JWT_CONFIG.JWT_SECRET:', JWT_CONFIG.JWT_SECRET);
    console.log('JWT_CONFIG.ACCESS_TOKEN_EXPIRY:', JWT_CONFIG.ACCESS_TOKEN_EXPIRY);
    console.log('Payload:', payload);
    
    if (!JWT_CONFIG.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }
    
    // Remove aud and iss from payload if they exist to avoid conflicts
    const { aud, iss, ...cleanPayload } = payload;
    
    return jwt.sign(
      {
        ...cleanPayload,
        type: 'access',
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_CONFIG.JWT_SECRET,
      {
        expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
        issuer: 'nursery-app',
        audience: 'nursery-users'
      }
    );
  } catch (error) {
    console.error('JWT Generation Error:', error);
    throw new Error('Failed to generate access token: ' + error.message);
  }
};

/**
 * Generate refresh token
 * @param {Object} payload - Token payload
 * @returns {String} Refresh token
 */
export const generateRefreshToken = (payload) => {
  try {
    const JWT_CONFIG = getJWTConfig();
    // Remove aud and iss from payload if they exist to avoid conflicts
    const { aud, iss, ...cleanPayload } = payload;
    
    return jwt.sign(
      {
        ...cleanPayload,
        type: 'refresh',
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_CONFIG.REFRESH_TOKEN_SECRET,
      {
        expiresIn: JWT_CONFIG.REFRESH_TOKEN_EXPIRY,
        issuer: 'nursery-app',
        audience: 'nursery-users'
      }
    );
  } catch (error) {
    throw new Error('Failed to generate refresh token');
  }
};

/**
 * Generate both access and refresh tokens
 * @param {Object} payload - Token payload
 * @returns {Object} Object containing access and refresh tokens
 */
export const generateTokenPair = (payload) => {
  const JWT_CONFIG = getJWTConfig();
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  
  return {
    accessToken,
    refreshToken,
    expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY
  };
};

/**
 * Verify access token
 * @param {String} token - Access token to verify
 * @returns {Object} Decoded token payload
 */
export const verifyAccessToken = (token) => {
  try {
    const JWT_CONFIG = getJWTConfig();
    // Check if token is blacklisted
    if (tokenBlacklist.has(token)) {
      throw new Error('Token has been revoked');
    }

    const decoded = jwt.verify(token, JWT_CONFIG.JWT_SECRET, {
      issuer: 'nursery-app',
      audience: 'nursery-users'
    });

    if (decoded.type !== 'access') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Access token expired');
    }
    if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid access token');
    }
    throw error;
  }
};

/**
 * Verify refresh token
 * @param {String} token - Refresh token to verify
 * @returns {Object} Decoded token payload
 */
export const verifyRefreshToken = (token) => {
  try {
    const JWT_CONFIG = getJWTConfig();
    const decoded = jwt.verify(token, JWT_CONFIG.REFRESH_TOKEN_SECRET, {
      issuer: 'nursery-app',
      audience: 'nursery-users'
    });

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Refresh token expired');
    }
    if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid refresh token');
    }
    throw error;
  }
};

/**
 * Refresh access token using refresh token
 * @param {String} refreshToken - Refresh token
 * @returns {Object} New token pair
 */
export const refreshAccessToken = (refreshToken) => {
  try {
    const decoded = verifyRefreshToken(refreshToken);
    
    // Remove sensitive data from payload
    const { iat, exp, type, ...payload } = decoded;
    
    return generateTokenPair(payload);
  } catch (error) {
    throw new Error('Failed to refresh token: ' + error.message);
  }
};

/**
 * Blacklist a token (for logout)
 * @param {String} token - Token to blacklist
 */
export const blacklistToken = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      // Add to blacklist with expiration
      const expiresAt = decoded.exp * 1000; // Convert to milliseconds
      tokenBlacklist.add(token);
      
      // Remove from blacklist after expiration
      setTimeout(() => {
        tokenBlacklist.delete(token);
      }, expiresAt - Date.now());
    }
  } catch (error) {
    console.error('Error blacklisting token:', error);
  }
};

/**
 * Generate secure random string for token IDs
 * @param {Number} length - Length of the string
 * @returns {String} Random string
 */
export const generateTokenId = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Extract token from request headers or cookies
 * @param {Object} req - Express request object
 * @returns {String|null} Token or null
 */
export const extractToken = (req) => {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookies
  if (req.cookies?.accessToken) {
    return req.cookies.accessToken;
  }

  // Check query parameters (for development/testing)
  if (req.query?.token) {
    return req.query.token;
  }

  return null;
};

/**
 * Set token cookies
 * @param {Object} res - Express response object
 * @param {String} accessToken - Access token
 * @param {String} refreshToken - Refresh token
 */
export const setTokenCookies = (res, accessToken, refreshToken) => {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000 // 15 minutes for access token
  };

  const refreshCookieOptions = {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days for refresh token
  };

  res.cookie('accessToken', accessToken, cookieOptions);
  res.cookie('refreshToken', refreshToken, refreshCookieOptions);
};

/**
 * Clear token cookies
 * @param {Object} res - Express response object
 */
export const clearTokenCookies = (res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
}; 