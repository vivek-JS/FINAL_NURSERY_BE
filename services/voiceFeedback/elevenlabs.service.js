import axios from "axios";
import { getElevenLabsApiKey, getElevenLabsVoiceId } from "../../config/voiceFeedback.config.js";

/**
 * Text to speech. Returns MP3 buffer (ExoML / browser playback).
 */
export async function synthesizeSpeech(text) {
  const voiceId = getElevenLabsVoiceId();
  const apiKey = getElevenLabsApiKey();
  if (!voiceId || !apiKey) {
    const err = new Error("ElevenLabs is not configured (ELEVENLABS_VOICE_ID, ELEVENLABS_API_KEY).");
    err.code = "ELEVENLABS_NOT_CONFIGURED";
    throw err;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: "eleven_multilingual_v2",
    },
    {
      responseType: "arraybuffer",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      timeout: 120000,
    }
  );

  return Buffer.from(response.data);
}
