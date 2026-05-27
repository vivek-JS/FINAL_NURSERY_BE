/** Serialize finance posts during bulk replay to avoid Mongo transaction conflicts. */
let serialPostEnabled = false;
let chain = Promise.resolve();

export function setFinanceSerialPost(enabled) {
  serialPostEnabled = Boolean(enabled);
}

export function isFinanceSerialPostEnabled() {
  return serialPostEnabled;
}

export function withFinancePostLock(fn) {
  if (!serialPostEnabled) return fn();
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/** Wait until queued serial posts finish (call before mongoose.disconnect in scripts). */
export function drainFinancePostLock() {
  return chain;
}
