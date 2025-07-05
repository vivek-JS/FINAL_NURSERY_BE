# JWT Security Implementation Guide

## Overview

This document outlines the comprehensive JWT (JSON Web Token) security implementation for the Nursery Management System backend. The implementation includes secure token generation, refresh tokens, role-based access control, and various security best practices.

## 🚀 Features Implemented

### 1. **Secure JWT Token Management**
- **Access Tokens**: Short-lived (15 minutes) for API access
- **Refresh Tokens**: Long-lived (7 days) for token renewal
- **Token Blacklisting**: Secure logout functionality
- **Token Verification**: Comprehensive validation with issuer/audience checks

### 2. **Role-Based Access Control (RBAC)**
- **Super Admin**: Full system access
- **Admin**: Administrative privileges
- **Sales**: Sales-related operations
- **Dealer**: Dealer-specific operations
- **Farmer**: Farmer-specific operations

### 3. **Security Middleware**
- **Authentication**: Token verification and user validation
- **Authorization**: Role-based access control
- **Input Validation**: Request body validation
- **Rate Limiting**: API request throttling

### 4. **Security Headers & CORS**
- **Security Headers**: XSS protection, content type options, etc.
- **CORS Configuration**: Cross-origin resource sharing
- **Cookie Security**: HttpOnly, Secure, SameSite attributes

## 📁 File Structure

```
FINAL_NURSERY_BE/
├── utility/
│   └── jwtUtils.js              # JWT utility functions
├── middlewares/
│   ├── auth.middleware.js        # Authentication middleware
│   └── verifyToken.middleware.js # Legacy token verification
├── config/
│   └── security.js              # Security configuration
├── controllers/
│   └── user.controller.js       # Updated with JWT endpoints
├── routes/
│   └── user.route.js            # Updated authentication routes
└── app.js                       # Main application with security middleware
```

## 🔧 Configuration

### Environment Variables

Add these to your `.env` file:

```env
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
REFRESH_TOKEN_SECRET=your-refresh-token-secret
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

# Security
NODE_ENV=production
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Logging
LOG_LEVEL=info
```

### Security Configuration

The security configuration is centralized in `config/security.js`:

```javascript
export const SECURITY_CONFIG = {
  JWT: {
    ACCESS_TOKEN_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY: '7d',
    // ... other JWT settings
  },
  // ... other security settings
};
```

## 🔐 API Endpoints

### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/v1/user/login` | User login | No |
| POST | `/api/v1/user/refresh-token` | Refresh access token | No |
| POST | `/api/v1/user/logout` | User logout | Yes |
| POST | `/api/v1/user/verify-token` | Verify token validity | No |
| POST | `/api/v1/user/resetPassword` | Reset password | Yes |
| GET | `/api/v1/user/aboutMe` | Get user profile | Yes |

### Protected Endpoints

All other API endpoints now require authentication:

- `/api/v1/farmer/*` - Farmer operations
- `/api/v1/order/*` - Order management
- `/api/v1/cms/*` - Content management
- `/api/v1/employee/*` - Employee management
- `/api/v1/reporting/*` - Reporting
- And many more...

## 🔑 Usage Examples

### 1. User Login

```javascript
// Request
POST /api/v1/user/login
Content-Type: application/json

{
  "phoneNumber": "1234567890",
  "password": "securePassword123"
}

// Response
{
  "status": "Success",
  "message": "Login successful",
  "data": {
    "user": {
      "_id": "user_id",
      "name": "John Doe",
      "phoneNumber": "1234567890",
      "role": "ADMIN"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": "15m"
  }
}
```

### 2. Making Authenticated Requests

```javascript
// Include token in Authorization header
GET /api/v1/order/all
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

// Or use cookies (automatically set during login)
GET /api/v1/order/all
// Cookies are automatically sent
```

### 3. Token Refresh

```javascript
// Request
POST /api/v1/user/refresh-token
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}

// Response
{
  "status": "Success",
  "message": "Token refreshed successfully",
  "data": {
    "accessToken": "new_access_token",
    "refreshToken": "new_refresh_token",
    "expiresIn": "15m"
  }
}
```

### 4. Logout

```javascript
// Request
POST /api/v1/user/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

// Response
{
  "status": "Success",
  "message": "Logged out successfully"
}
```

## 🛡️ Security Features

### 1. **Token Security**
- **Short-lived access tokens** (15 minutes)
- **Long-lived refresh tokens** (7 days)
- **Token blacklisting** for secure logout
- **Issuer and audience validation**
- **Token type validation**

### 2. **Password Security**
- **bcrypt hashing** with salt rounds
- **Password validation** (minimum length, complexity)
- **Password expiration** (90 days)

### 3. **Rate Limiting**
- **Request throttling** (100 requests per 15 minutes)
- **IP-based limiting**
- **Configurable limits**

### 4. **Input Validation**
- **Request body validation**
- **Phone number format validation**
- **File upload restrictions**
- **XSS protection**

### 5. **CORS & Headers**
- **Strict CORS policy**
- **Security headers** (XSS, CSRF protection)
- **Content Security Policy**

## 🔒 Role-Based Access Control

### Role Hierarchy

```
Super Admin (100) > Admin (90) > Sales (70) > Dealer (50) > Farmer (30)
```

### Permission System

Each role has specific permissions:

- **Super Admin**: All permissions (`*`)
- **Admin**: User management, order management, reporting
- **Sales**: Order operations, farmer management, reporting
- **Dealer**: Order operations, limited reporting
- **Farmer**: Order operations, basic reporting

### Usage in Routes

```javascript
import { requireAdmin, requireSales, requireDealer } from '../middlewares/auth.middleware.js';

// Admin only route
router.get('/admin/users', requireAdmin, getUsers);

// Sales or Admin route
router.post('/orders', requireSales, createOrder);

// Dealer or Admin route
router.get('/dealer/orders', requireDealer, getDealerOrders);
```

## 🚨 Error Handling

### Authentication Errors

```javascript
// 401 Unauthorized
{
  "status": "error",
  "message": "Access token required"
}

// 401 Invalid Token
{
  "status": "error",
  "message": "Invalid access token"
}

// 401 Token Expired
{
  "status": "error",
  "message": "Access token expired"
}

// 403 Insufficient Permissions
{
  "status": "error",
  "message": "Insufficient permissions"
}
```

## 🔧 Middleware Usage

### 1. **Authentication Middleware**

```javascript
import { authenticateToken } from '../middlewares/auth.middleware.js';

// Protect a route
router.get('/protected', authenticateToken, (req, res) => {
  // req.user contains the authenticated user
  res.json({ user: req.user });
});
```

### 2. **Role Authorization**

```javascript
import { requireAdmin, requireSales } from '../middlewares/auth.middleware.js';

// Admin only
router.delete('/users/:id', requireAdmin, deleteUser);

// Sales or Admin
router.post('/orders', requireSales, createOrder);
```

### 3. **Optional Authentication**

```javascript
import { optionalAuth } from '../middlewares/auth.middleware.js';

// Optional authentication
router.get('/public', optionalAuth, (req, res) => {
  if (req.user) {
    // User is authenticated
    res.json({ user: req.user, public: true });
  } else {
    // No authentication
    res.json({ public: true });
  }
});
```

## 🔄 Migration Guide

### From Old Authentication

1. **Update Frontend**: Use new login response format
2. **Handle Token Refresh**: Implement automatic token refresh
3. **Update API Calls**: Include Authorization headers
4. **Handle Logout**: Use new logout endpoint

### Frontend Integration

```javascript
// Login
const login = async (phoneNumber, password) => {
  const response = await fetch('/api/v1/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber, password })
  });
  
  const data = await response.json();
  
  if (data.status === 'Success') {
    // Store tokens
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    return data.data.user;
  }
};

// API call with token
const apiCall = async (url, options = {}) => {
  const token = localStorage.getItem('accessToken');
  
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });
  
  if (response.status === 401) {
    // Token expired, try refresh
    await refreshToken();
    // Retry request
    return apiCall(url, options);
  }
  
  return response;
};
```

## 🧪 Testing

### Test JWT Endpoints

```bash
# Login
curl -X POST http://localhost:8000/api/v1/user/login \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "1234567890", "password": "password123"}'

# Use returned token for authenticated requests
curl -X GET http://localhost:8000/api/v1/user/aboutMe \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Refresh token
curl -X POST http://localhost:8000/api/v1/user/refresh-token \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'

# Logout
curl -X POST http://localhost:8000/api/v1/user/logout \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## 🔍 Monitoring & Logging

### Security Events Logged

- User login attempts (success/failure)
- Token refresh operations
- Logout events
- Failed authentication attempts
- Role-based access violations

### Log Format

```javascript
{
  timestamp: "2024-01-15T10:30:00Z",
  event: "user.login",
  userId: "user_id",
  ip: "192.168.1.1",
  userAgent: "Mozilla/5.0...",
  success: true,
  metadata: {
    role: "ADMIN",
    loginMethod: "password"
  }
}
```

## 🚀 Best Practices

### 1. **Token Management**
- Always use HTTPS in production
- Store tokens securely (HttpOnly cookies)
- Implement automatic token refresh
- Clear tokens on logout

### 2. **Security Headers**
- Use security headers (Helmet.js)
- Implement CORS properly
- Validate all inputs
- Sanitize user data

### 3. **Error Handling**
- Don't expose sensitive information in errors
- Log security events
- Implement proper error responses
- Handle token expiration gracefully

### 4. **Rate Limiting**
- Implement rate limiting on auth endpoints
- Monitor for brute force attacks
- Use different limits for different endpoints

## 🔧 Troubleshooting

### Common Issues

1. **Token Expired**: Use refresh token to get new access token
2. **Invalid Token**: Check token format and signature
3. **CORS Issues**: Verify CORS configuration
4. **Permission Denied**: Check user role and permissions

### Debug Mode

Enable debug logging by setting:

```env
LOG_LEVEL=debug
```

This will log detailed authentication information for debugging.

## 📚 Additional Resources

- [JWT.io](https://jwt.io/) - JWT documentation
- [Express.js Security](https://expressjs.com/en/advanced/best-practices-security.html)
- [OWASP Security Guidelines](https://owasp.org/www-project-top-ten/)

---

**Note**: This implementation follows security best practices and industry standards. Always keep your JWT secrets secure and rotate them regularly in production environments. 