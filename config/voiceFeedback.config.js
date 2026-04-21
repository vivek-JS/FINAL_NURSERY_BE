/**
 * Voice feedback (Marathi post-dispatch) — env-only configuration.
 */

export const isVoiceFeedbackEnabled = () =>
  String(process.env.VOICE_FEEDBACK_ENABLED || "").toLowerCase() === "true";

export const getVoiceFeedbackDelayMs = () =>
  Math.max(0, Number(process.env.VOICE_FEEDBACK_DELAY_MS || 0) || 0);

export const shouldSkipInstantDispatchFeedback = () =>
  String(process.env.VOICE_FEEDBACK_SKIP_INSTANT_DISPATCH || "").toLowerCase() === "true";

export const getPublicBaseUrl = () =>
  String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

export const getDeepgramApiKey = () => process.env.DEEPGRAM_API_KEY || null;

export const getOpenAiApiKey = () => process.env.OPENAI_API_KEY || null;

export const getElevenLabsApiKey = () => process.env.ELEVENLABS_API_KEY || null;

export const getElevenLabsVoiceId = () => process.env.ELEVENLABS_VOICE_ID || null;

export const getExotelCallerId = () =>
  process.env.EXOTEL_CALLER_ID || process.env.EXOTEL_VIRTUAL_NUMBER || null;

/** ExoML / Voice applet URL Exotel connects the callee into after answer. */
export const getExotelFlowUrl = () => process.env.EXOTEL_FLOW_URL || null;

export const getVoiceFeedbackWsSecret = () => process.env.VOICE_FEEDBACK_WS_SECRET || null;

export const getRedisUrlForBull = () =>
  process.env.REDIS_URL || process.env.BULL_REDIS_URL || null;
