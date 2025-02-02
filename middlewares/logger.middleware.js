import Log from "../models/log.model.js";

const logger = async (req, res, next) => {
  const originalSend = res.send;

  res.send = async function (body) {
    try {
      if (['PUT', 'PATCH', 'POST', 'DELETE'].includes(req.method) && 
          res.statusCode >= 200 && res.statusCode < 300) {
        
        let operation;
        switch (req.method) {
          case 'POST':
            operation = 'CREATE';
            break;
          case 'PUT':
          case 'PATCH':
            operation = 'UPDATE';
            break;
          case 'DELETE':
            operation = 'DELETE';
            break;
        }

        const logEntry = new Log({
          userId: req.user?._id,
          modelName: req.baseUrl.replace('/', ''),
          documentId: req.params.id || (typeof body === 'object' ? body._id : null),
          operation: operation,
          previousState: req.originalDocument,
          newState: typeof body === 'string' ? JSON.parse(body) : body,
          changedFields: getChangedFields(req.originalDocument, body),
          ipAddress: req.ip,
          metadata: {
            userAgent: req.get('user-agent'),
            path: req.path,
            query: req.query
          }
        });
        logEntry.save().catch(err => console.error('Error saving update log:', err));
      }

      return originalSend.call(this, body);
    } catch (error) {
      console.error('Error in update logger middleware:', error);
      return originalSend.call(this, body);
    }
  };

  next();
};

// Helper function to determine which fields changed
function getChangedFields(oldDoc, newDoc) {
  if (!oldDoc || !newDoc) return [];
  
  const changes = [];
  const oldObj = typeof oldDoc === 'string' ? JSON.parse(oldDoc) : oldDoc;
  const newObj = typeof newDoc === 'string' ? JSON.parse(newDoc) : newDoc;

  Object.keys(newObj).forEach(key => {
    if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      changes.push(key);
    }
  });

  return changes;
}

export default logger;
