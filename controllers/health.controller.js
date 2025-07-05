import mongoose from 'mongoose';
import generateResponse from '../utility/responseFormat.js';

/**
 * Health check controller for monitoring application status
 */
export const healthCheck = async (req, res) => {
  try {
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
      services: {}
    };

    // Check database connection
    try {
      const dbState = mongoose.connection.readyState;
      healthStatus.services.database = {
        status: dbState === 1 ? 'connected' : 'disconnected',
        state: dbState
      };
    } catch (error) {
      healthStatus.services.database = {
        status: 'error',
        error: error.message
      };
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    healthStatus.services.memory = {
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
    };

    // Check CPU usage
    const cpuUsage = process.cpuUsage();
    healthStatus.services.cpu = {
      user: Math.round(cpuUsage.user / 1000) + ' ms',
      system: Math.round(cpuUsage.system / 1000) + ' ms'
    };

    // Check if any service is unhealthy
    const isHealthy = healthStatus.services.database.status === 'connected';
    
    if (!isHealthy) {
      healthStatus.status = 'unhealthy';
      return res.status(503).json(healthStatus);
    }

    res.status(200).json(healthStatus);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
};

/**
 * Detailed health check with more comprehensive checks
 */
export const detailedHealthCheck = async (req, res) => {
  try {
    const detailedStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
      services: {},
      checks: []
    };

    // Database connectivity check
    try {
      const dbState = mongoose.connection.readyState;
      const isConnected = dbState === 1;
      
      detailedStatus.services.database = {
        status: isConnected ? 'connected' : 'disconnected',
        state: dbState,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name
      };

      if (isConnected) {
        detailedStatus.checks.push({
          name: 'database',
          status: 'passed',
          responseTime: 'OK'
        });
      } else {
        detailedStatus.checks.push({
          name: 'database',
          status: 'failed',
          error: 'Database not connected'
        });
        detailedStatus.status = 'unhealthy';
      }
    } catch (error) {
      detailedStatus.services.database = {
        status: 'error',
        error: error.message
      };
      detailedStatus.checks.push({
        name: 'database',
        status: 'failed',
        error: error.message
      });
      detailedStatus.status = 'unhealthy';
    }

    // Memory check
    const memUsage = process.memoryUsage();
    const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    detailedStatus.services.memory = {
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapUsagePercent: Math.round(memUsagePercent * 100) / 100 + '%',
      external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
    };

    if (memUsagePercent > 90) {
      detailedStatus.checks.push({
        name: 'memory',
        status: 'warning',
        message: 'High memory usage detected'
      });
    } else {
      detailedStatus.checks.push({
        name: 'memory',
        status: 'passed'
      });
    }

    // Disk space check (if available)
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const stats = await fs.stat(path.resolve('.'));
      const freeSpace = stats.size;
      
      detailedStatus.services.disk = {
        freeSpace: Math.round(freeSpace / 1024 / 1024) + ' MB'
      };
      
      detailedStatus.checks.push({
        name: 'disk',
        status: 'passed'
      });
    } catch (error) {
      detailedStatus.checks.push({
        name: 'disk',
        status: 'skipped',
        message: 'Disk space check not available'
      });
    }

    // Environment check
    const requiredEnvVars = [
      'NODE_ENV',
      'MONGO_URL',
      'JWT_SECRET',
      'PORT'
    ];

    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingEnvVars.length > 0) {
      detailedStatus.checks.push({
        name: 'environment',
        status: 'failed',
        error: `Missing environment variables: ${missingEnvVars.join(', ')}`
      });
      detailedStatus.status = 'unhealthy';
    } else {
      detailedStatus.checks.push({
        name: 'environment',
        status: 'passed'
      });
    }

    // Security check
    const securityChecks = [];
    
    // Check if running in production
    if (process.env.NODE_ENV === 'production') {
      securityChecks.push('production_mode');
    }
    
    // Check if HTTPS is being used (if available)
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      securityChecks.push('https_enabled');
    }
    
    detailedStatus.services.security = {
      checks: securityChecks,
      status: securityChecks.length > 0 ? 'configured' : 'basic'
    };

    detailedStatus.checks.push({
      name: 'security',
      status: 'passed',
      details: securityChecks
    });

    // Overall status
    const failedChecks = detailedStatus.checks.filter(check => check.status === 'failed');
    const warningChecks = detailedStatus.checks.filter(check => check.status === 'warning');
    
    if (failedChecks.length > 0) {
      detailedStatus.status = 'unhealthy';
    } else if (warningChecks.length > 0) {
      detailedStatus.status = 'degraded';
    }

    const statusCode = detailedStatus.status === 'healthy' ? 200 : 
                      detailedStatus.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(detailedStatus);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
};

/**
 * Readiness check for Kubernetes/container orchestration
 */
export const readinessCheck = async (req, res) => {
  try {
    // Check if application is ready to receive traffic
    const isReady = mongoose.connection.readyState === 1;
    
    if (isReady) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        reason: 'Database not connected'
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
};

/**
 * Liveness check for Kubernetes/container orchestration
 */
export const livenessCheck = async (req, res) => {
  try {
    // Simple check to see if the process is alive
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({
      status: 'dead',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
}; 