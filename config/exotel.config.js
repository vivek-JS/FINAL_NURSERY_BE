/**
 * Exotel SMS Configuration – from environment only (no secrets in code).
 * Set EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID in .env
 * Optional: EXOTEL_SUBDOMAIN (default: api.in.exotel.com for Mumbai; use api.exotel.com for Singapore)
 * Optional: EXOTEL_SENDER_ID (default From value; e.g. EXOTEL or 600XXX or ExoPhone)
 */

export const getExotelApiKey = () => process.env.EXOTEL_API_KEY || null;
export const getExotelApiToken = () => process.env.EXOTEL_API_TOKEN || null;
export const getExotelAccountSid = () => process.env.EXOTEL_ACCOUNT_SID || null;

export const getExotelSubdomain = () => {
  const sub = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
  return sub.replace(/^https?:\/\//, "").replace(/\/+$/, "");
};

/** Default Sender ID (From). Can be EXOTEL, 600XXX, or ExoPhone like 080XXXXXX */
export const getExotelSenderId = () => process.env.EXOTEL_SENDER_ID || process.env.EXOTEL_FROM || "EXOTEL";

export const isExotelConfigured = () =>
  !!(getExotelApiKey() && getExotelApiToken() && getExotelAccountSid());
