/**
 * Capacity board free plants: never count irrelevant sowing batches.
 * (Ready-date windows are not applied here.)
 */
export function batchCountsOnCapacityBoard(batch) {
  return Boolean(batch) && !batch.isIrrelevant;
}

export function capacityBoardIncludeBatch() {
  return (batch) => batchCountsOnCapacityBoard(batch);
}
