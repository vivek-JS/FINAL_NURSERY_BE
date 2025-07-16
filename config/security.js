// Security Configuration for Nursery Management System

export const SECURITY_CONFIG = {
  // JWT Configuration
  JWT: {
    ACCESS_TOKEN_EXPIRY: process.env.ACCESS_TOKEN_EXPIRY || '1d',
    REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY || '7d',
    JWT_SECRET: process.env.JWT_SECRET || process.env.PRIVATE_KEY,
    REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET || process.env.PRIVATE_KEY + '_refresh',
    ISSUER: 'nursery-app',
    AUDIENCE: 'nursery-users'
  },

  // Password Policy
  PASSWORD: {
    MIN_LENGTH: 8,
    REQUIRE_UPPERCASE: true,
    REQUIRE_LOWERCASE: true,
    REQUIRE_NUMBERS: true,
    REQUIRE_SPECIAL_CHARS: true,
    MAX_AGE_DAYS: 90 // Password expiration
  },

  // Rate Limiting
  RATE_LIMIT: {
    WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    MAX_REQUESTS: 100, // requests per window
    MESSAGE: 'Too many requests from this IP, please try again later.',
    SKIP_SUCCESSFUL_REQUESTS: false,
    SKIP_FAILED_REQUESTS: false
  },

  // Session Management
  SESSION: {
    MAX_ACTIVE_SESSIONS: 5, // Maximum active sessions per user
    SESSION_TIMEOUT: 30 * 60 * 1000, // 30 minutes of inactivity
    CLEANUP_INTERVAL: 60 * 60 * 1000 // Clean up expired sessions every hour
  },

  // CORS Configuration
  CORS: {
    ORIGIN: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:3001'],
    CREDENTIALS: true,
    METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    ALLOWED_HEADERS: ['Content-Type', 'Authorization', 'X-Requested-With']
  },

  // Cookie Security
  COOKIE: {
    HTTP_ONLY: true,
    SECURE: process.env.NODE_ENV === 'production',
    SAME_SITE: 'strict',
    MAX_AGE: 24 * 60 * 60 * 1000 // 24 hours (1 day) for access token
  },

  // Input Validation
  VALIDATION: {
    MAX_STRING_LENGTH: 1000,
    MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
    ALLOWED_FILE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'],
    SANITIZE_HTML: true
  },

  // Logging
  LOGGING: {
    LOG_AUTH_ATTEMPTS: true,
    LOG_FAILED_LOGINS: true,
    LOG_SENSITIVE_OPERATIONS: true,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  },

  // API Security
  API: {
    VERSION_HEADER: 'X-API-Version',
    REQUEST_ID_HEADER: 'X-Request-ID',
    TIMESTAMP_HEADER: 'X-Timestamp',
    MAX_REQUEST_SIZE: '10mb'
  }
};

// Security Headers Configuration
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

// Role-based Access Control (RBAC) Configuration
export const RBAC_CONFIG = {
  ROLES: {
    SUPER_ADMIN: {
      level: 100,
      permissions: ['*'] // All permissions
    },
    ADMIN: {
      level: 90,
      permissions: [
        'user:read', 'user:write', 'user:delete',
        'order:read', 'order:write', 'order:delete',
        'farmer:read', 'farmer:write', 'farmer:delete',
        'dealer:read', 'dealer:write', 'dealer:delete',
        'report:read', 'report:write',
        'settings:read', 'settings:write'
      ]
    },
    ACCOUNTANT: {
      level: 80,
      permissions: [
        'order:read', 'order:write',
        'payment:read', 'payment:write', 'payment:delete',
        'farmer:read',
        'dealer:read',
        'report:read'
      ]
    },
    OFFICE_ADMIN: {
      level: 75,
      permissions: [
        'order:read', 'order:write',
        'farmer:read', 'farmer:write',
        'dealer:read', 'dealer:write',
        'report:read',
        'settings:read'
      ]
    },
    SALES: {
      level: 70,
      permissions: [
        'order:read', 'order:write',
        'farmer:read', 'farmer:write',
        'dealer:read',
        'report:read'
      ]
    },
    DEALER: {
      level: 50,
      permissions: [
        'order:read', 'order:write',
        'farmer:read',
        'report:read'
      ]
    },
    FARMER: {
      level: 30,
      permissions: [
        'order:read', 'order:write',
        'report:read'
      ]
    }
  },

  // Permission definitions
  PERMISSIONS: {
    'user:read': 'Can read user information',
    'user:write': 'Can create and update users',
    'user:delete': 'Can delete users',
    'order:read': 'Can read orders',
    'order:write': 'Can create and update orders',
    'order:delete': 'Can delete orders',
    'payment:read': 'Can read payment information',
    'payment:write': 'Can create and update payments',
    'payment:delete': 'Can delete payments',
    'farmer:read': 'Can read farmer information',
    'farmer:write': 'Can create and update farmers',
    'farmer:delete': 'Can delete farmers',
    'dealer:read': 'Can read dealer information',
    'dealer:write': 'Can create and update dealers',
    'dealer:delete': 'Can delete dealers',
    'report:read': 'Can read reports',
    'report:write': 'Can create and update reports',
    'settings:read': 'Can read system settings',
    'settings:write': 'Can modify system settings'
  }
};

// Audit Trail Configuration
export const AUDIT_CONFIG = {
  ENABLED: true,
  LOG_LEVELS: {
    INFO: 'info',
    WARNING: 'warning',
    ERROR: 'error',
    CRITICAL: 'critical'
  },
  EVENTS: {
    USER_LOGIN: 'user.login',
    USER_LOGOUT: 'user.logout',
    USER_CREATE: 'user.create',
    USER_UPDATE: 'user.update',
    USER_DELETE: 'user.delete',
    ORDER_CREATE: 'order.create',
    ORDER_UPDATE: 'order.update',
    ORDER_DELETE: 'order.delete',
    SENSITIVE_OPERATION: 'sensitive.operation'
  }
};

// Data Encryption Configuration
export const ENCRYPTION_CONFIG = {
  ALGORITHM: 'aes-256-gcm',
  KEY_LENGTH: 32,
  IV_LENGTH: 16,
  SALT_ROUNDS: 12
};

// Backup and Recovery Configuration
export const BACKUP_CONFIG = {
  AUTO_BACKUP: true,
  BACKUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  RETENTION_DAYS: 30,
  ENCRYPT_BACKUPS: true,
  COMPRESS_BACKUPS: true
}; 