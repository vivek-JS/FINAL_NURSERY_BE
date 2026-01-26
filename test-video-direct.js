/**
 * Direct Video Generation Test
 * Tests the video generation function directly without API authentication
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const execAsync = promisify(exec);

// Copy of generateVideoWithGoogleTTS function
async function generateVideoWithGoogleTTS(text) {
  try {
    const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
    
    if (!GOOGLE_TTS_API_KEY) {
      throw new Error('GOOGLE_TTS_API_KEY not configured. Get free API key from https://console.cloud.google.com/');
    }

    // Step 1: Generate Hindi audio using Google Cloud TTS (FREE: 0-4M chars/month)
    const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
    
    console.log('   Step 1: Generating Hindi audio with Google TTS...');
    console.log('   API Key (first 20 chars):', GOOGLE_TTS_API_KEY.substring(0, 20) + '...');
    
    let ttsResponse;
    try {
      ttsResponse = await axios.post(ttsUrl, {
      input: { text: text },
      voice: {
        languageCode: 'hi-IN',
        name: 'hi-IN-Wavenet-A', // Hindi female voice (high quality)
        ssmlGender: 'FEMALE'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.0,
        pitch: 0,
        volumeGainDb: 0
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    } catch (ttsError) {
      if (ttsError.response) {
        console.error('   ❌ Google TTS API Error:');
        console.error('      Status:', ttsError.response.status);
        console.error('      Status Text:', ttsError.response.statusText);
        console.error('      Error Data:', JSON.stringify(ttsError.response.data, null, 2));
        
        if (ttsError.response.status === 403) {
          console.error('\n   💡 Possible issues:');
          console.error('      1. Text-to-Speech API not enabled in Google Cloud Console');
          console.error('      2. API key is invalid or expired');
          console.error('      3. API key doesn\'t have Text-to-Speech permissions');
          console.error('\n   🔧 Fix:');
          console.error('      1. Go to: https://console.cloud.google.com/apis/library/texttospeech.googleapis.com');
          console.error('      2. Enable "Cloud Text-to-Speech API"');
          console.error('      3. Verify API key at: https://console.cloud.google.com/apis/credentials');
        }
      }
      throw ttsError;
    }

    const audioBase64 = ttsResponse.data.audioContent;
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log('   ✅ Audio generated (' + (audioBuffer.length / 1024).toFixed(1) + ' KB)');

    // Step 2: Create temp directory
    const tempDir = path.join(process.cwd(), 'temp', 'videos');
    await fs.mkdir(tempDir, { recursive: true });

    const timestamp = Date.now();
    const audioPath = path.join(tempDir, `audio-${timestamp}.mp3`);
    await fs.writeFile(audioPath, audioBuffer);
    console.log('   ✅ Audio saved to:', audioPath);

    // Step 3: Check if FFmpeg is installed
    try {
      await execAsync('ffmpeg -version');
    } catch (error) {
      throw new Error('FFmpeg not installed. Install with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)');
    }

    // Step 4: Get audio duration
    console.log('   Step 2: Getting audio duration...');
    let duration = 30; // default
    try {
      const { stdout: durationOutput } = await execAsync(
        `ffprobe -i "${audioPath}" -show_entries format=duration -v quiet -of csv="p=0" 2>/dev/null || echo "30"`
      );
      duration = parseFloat(durationOutput.trim()) || 30;
    } catch (e) {
      // Use default if ffprobe fails
    }
    const videoDuration = Math.ceil(duration) + 2;
    console.log(`   ✅ Audio duration: ${duration.toFixed(1)}s, Video duration: ${videoDuration}s`);

    // Step 5: Create video with text overlay
    console.log('   Step 3: Creating video with FFmpeg...');
    const videoPath = path.join(tempDir, `video-${timestamp}.mp4`);
    
    // Create video with audio (text overlay may not be available in all FFmpeg builds)
    // The Hindi text summary is available in the API response for display in frontend
    console.log('   Creating video with audio (text will be shown in frontend)...');
    const ffmpegCommand = `ffmpeg -f lavfi -i color=c=0x1a1f2e:s=1280x720:d=${videoDuration} -i "${audioPath}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -shortest -y "${videoPath}" 2>&1`;

    await execAsync(ffmpegCommand);
    console.log('   ✅ Video created:', videoPath);

    // Clean up audio file
    await fs.unlink(audioPath).catch(() => {});

    // Generate video URL that can be accessed from frontend
    const videoFilename = path.basename(videoPath);
    // Use relative URL that frontend will resolve to correct base URL
    const videoUrl = `/api/v1/inventory/videos/${videoFilename}`;

    return {
      videoPath,
      videoUrl,
      duration: videoDuration,
      method: 'google-tts-ffmpeg',
      filename: videoFilename
    };
  } catch (error) {
    console.error('Google TTS Video generation error:', error.message);
    throw error;
  }
}

async function testVideoGeneration() {
  try {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎬 DIRECT VIDEO GENERATION TEST');
    console.log('═══════════════════════════════════════════════════════\n');
    
    // Check API key
    if (!process.env.GOOGLE_TTS_API_KEY) {
      console.error('❌ GOOGLE_TTS_API_KEY not found in .env file');
      process.exit(1);
    }
    console.log('✅ GOOGLE_TTS_API_KEY found\n');
    
    // Check FFmpeg
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      await execAsync('ffmpeg -version');
      console.log('✅ FFmpeg is installed\n');
    } catch (e) {
      console.error('❌ FFmpeg not found. Install with: brew install ffmpeg\n');
      process.exit(1);
    }
    
    // Test Hindi text
    const testText = `नमस्ते! आज की राम एग्री सेल्स रिपोर्ट।

आज कुल १२३ ऑर्डर मिले। यह कल से १० अधिक है, यानी ८.८% वृद्धि।

आज कुल ९८ ऑर्डर डिस्पैच किए गए। यह कल से ५ अधिक है।

आज कुल बिक्री ₹१,२३,४५६ है। यह कल से ₹१२,३४५ अधिक है, यानी ११.१% वृद्धि।

सबसे अच्छा प्रदर्शन राम कुमार का रहा, जिन्होंने ₹५०,००० की बिक्री की।

धन्यवाद!`;

    console.log('📝 Test Hindi Text:');
    console.log('─────────────────────────────────────────────────────');
    console.log(testText);
    console.log('─────────────────────────────────────────────────────\n');
    
    console.log('🎬 Generating video...');
    console.log('   This may take 20-40 seconds...\n');
    
    const startTime = Date.now();
    
    const result = await generateVideoWithGoogleTTS(testText);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('✅ Video Generated Successfully!\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 VIDEO DETAILS');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`   Method: ${result.method || 'google-tts-ffmpeg'}`);
    console.log(`   Duration: ${duration} seconds`);
    console.log(`   Video Duration: ${result.duration} seconds`);
    console.log(`   Filename: ${result.filename}`);
    console.log(`   Video Path: ${result.videoPath}`);
    console.log(`   Video URL: ${result.videoUrl}`);
    
    const fullUrl = `http://localhost:8000${result.videoUrl}`;
    console.log(`\n   Full URL: ${fullUrl}`);
    
    console.log(`\n   🎬 You can now:`);
    console.log(`      1. Open in browser: ${fullUrl}`);
    console.log(`      2. View file: ${result.videoPath}`);
    console.log(`      3. Test from dashboard: Click "Video (Day)" button`);
    
    console.log('\n═══════════════════════════════════════════════════════\n');
    console.log('✅ Test completed successfully!\n');
    
  } catch (error) {
    console.error('\n❌ Video generation failed!\n');
    console.error('Error:', error.message);
    console.error('\nStack:', error.stack);
    process.exit(1);
  }
}

testVideoGeneration();
