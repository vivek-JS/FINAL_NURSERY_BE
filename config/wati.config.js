/**
 * WATI Configuration – from environment only (no secrets in code).
 * Set WATI_TOKEN and WATI_BASE_URL in .env
 */

export const getWatiToken = () => {
  return process.env.WATI_TOKEN || null;
};

export const getWatiBaseUrl = () => {
  const url = process.env.WATI_BASE_URL || process.env.WATI_URL;
  if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
    return url.replace(/\/+$/, "");
  }
  if (url && !url.startsWith("http")) {
    console.warn(`⚠️ Invalid WATI_BASE_URL/WATI_URL in env: "${url}"`);
  }
  return null;
};

export const isWatiConfigured = () => !!(getWatiToken() && getWatiBaseUrl());
