import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import {
  listPrimaryBoard,
  receiveLabLine,
  sendPlants,
  sowBottles,
  sowMany,
} from "../services/primaryBatchLedger.service.js";

export const getPrimaryBoard = catchAsync(async (req, res) => {
  const data = await listPrimaryBoard();
  res.status(200).json(generateResponse("Success", "Primary board", data));
});

export const postPrimaryReceive = catchAsync(async (req, res) => {
  const data = await receiveLabLine({
    batchId: req.body?.batchId,
    labOutwardId: req.body?.labOutwardId,
  });
  res.status(200).json(generateResponse("Success", "Received", data));
});

export const postPrimarySow = catchAsync(async (req, res) => {
  if (Array.isArray(req.body?.batches)) {
    const data = await sowMany({
      batches: req.body.batches,
      laboursLadies: req.body?.laboursLadies,
      laboursGents: req.body?.laboursGents,
      sowDate: req.body?.sowDate,
    });
    return res.status(200).json(generateResponse("Success", "Lagwad saved", data));
  }
  const data = await sowBottles({
    batchId: req.body?.batchId,
    bottles: req.body?.bottles,
    expectedPlants: req.body?.expectedPlants,
    sowDate: req.body?.sowDate,
    size: req.body?.size,
    lines: req.body?.lines,
    laboursLadies: req.body?.laboursLadies,
    laboursGents: req.body?.laboursGents,
  });
  res.status(200).json(generateResponse("Success", "Sown", data));
});

export const postPrimarySend = catchAsync(async (req, res) => {
  const data = await sendPlants({
    batchId: req.body?.batchId,
    sowId: req.body?.sowId,
    plants: req.body?.plants,
  });
  res.status(200).json(generateResponse("Success", "Sent", data));
});
