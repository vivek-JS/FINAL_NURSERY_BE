const serverless = require('serverless-http');

// Global variable to store the handler
let handler = null;

// Lambda handler function
exports.handler = async (event, context) => {
  try {
    // Initialize handler only once (cold start optimization)
    if (!handler) {
      console.log('Initializing Lambda handler...');
      console.log('Event:', JSON.stringify(event, null, 2));
      
      // Create a simple Express app
      const express = require('express');
      const app = express();
      
      // Add basic middleware
      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));
      
      // Add CORS headers
      app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        next();
      });
      
      // Test routes
      app.get('/', (req, res) => {
        res.json({
          message: 'Nursery Backend API is running!',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || 'development'
        });
      });
      
      app.get('/health', (req, res) => {
        res.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime()
        });
      });
      
      app.get('/api/dummyData', (req, res) => {
        res.json({
          message: 'Test endpoint working',
          timestamp: new Date().toISOString()
        });
      });
      
      app.post('/api/v1/user/login', (req, res) => {
        console.log('Login request received:', req.body);
        
        // Simple login logic for testing
        const { phoneNumber, password } = req.body;
        
        if (phoneNumber === '7588686452' && password === '432100') {
          res.json({
            success: true,
            message: 'Login successful',
            user: {
              phoneNumber: phoneNumber,
              role: 'admin'
            },
            token: 'test-jwt-token-12345',
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(401).json({
            success: false,
            message: 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
      });
      
      // Handle OPTIONS requests for CORS
      app.options('*', (req, res) => {
        res.status(200).end();
      });
      
      // 404 handler
      app.use('*', (req, res) => {
        res.status(404).json({
          message: 'Route not found',
          path: req.originalUrl,
          method: req.method,
          timestamp: new Date().toISOString()
        });
      });
      
      // Wrap the Express app with serverless-http
      handler = serverless(app);
      
      console.log('Lambda handler initialized successfully');
    }
    
    // Process the request
    console.log('Processing request...');
    const response = await handler(event, context);
    
    console.log('Response generated:', {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body ? response.body.substring(0, 200) + '...' : 'No body'
    });
    
    return response;
  } catch (error) {
    console.error('Lambda handler error:', error);
    console.error('Error stack:', error.stack);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({
        message: 'Internal server error',
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};
