/**
 * Admin MIS / stats responses must not be served from browser cache (304 + stale ETag).
 * Strips conditional request headers so Express does not return Not Modified.
 */
export function noCacheApiResponse(req, res, next) {
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  next();
}
