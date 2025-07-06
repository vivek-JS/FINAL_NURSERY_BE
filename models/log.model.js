import mongoose from "mongoose";

const logSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  modelName: {
    type: String,
    required: true
  },
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  operation: {
    type: String,
    enum: ['CREATE', 'UPDATE', 'DELETE'],
    required: true
  },
  previousState: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },
  newState: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },
  changedFields: [{
    type: String
  }],
  ipAddress: {
    type: String,
    required: false
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  }
}, {
  timestamps: true
});

const Log = mongoose.model('Log', logSchema);
export default Log;
