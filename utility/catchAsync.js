const catchAsync = (fn) => {
  return (req, res, next) => {
    const maybePromise = fn(req, res, next);
    if (!maybePromise || typeof maybePromise.catch !== 'function') {
      // Log a clear error and pass to next
      const err = new Error('Function passed to catchAsync did not return a promise. Make sure it is async.');
      console.error('catchAsync error:', err);
      return next(err);
    }
    maybePromise.catch(next);
  };
};

export default catchAsync;
