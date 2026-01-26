import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AgriSalesOrder from "../models/agriSalesOrder.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

// Helper function to format numbers in Hindi style
const formatHindiNumber = (num) => {
  return new Intl.NumberFormat('en-IN').format(num);
};

// Helper function to generate Hindi text summary
const generateHindiSummary = (currentData, previousData, period) => {
  const periodText = period === 'day' ? 'आज' : 'इस सप्ताह';
  const previousPeriodText = period === 'day' ? 'कल' : 'पिछले सप्ताह';
  
  const currentOrders = currentData.totalOrders || 0;
  const previousOrders = previousData.totalOrders || 0;
  const orderChange = currentOrders - previousOrders;
  const orderChangePercent = previousOrders > 0 
    ? ((orderChange / previousOrders) * 100).toFixed(1) 
    : 0;

  const currentDispatched = currentData.dispatchedOrders || 0;
  const previousDispatched = previousData.dispatchedOrders || 0;
  const dispatchedChange = currentDispatched - previousDispatched;

  const currentSales = currentData.totalSales || 0;
  const previousSales = previousData.totalSales || 0;
  const salesChange = currentSales - previousSales;
  const salesChangePercent = previousSales > 0 
    ? ((salesChange / previousSales) * 100).toFixed(1) 
    : 0;

  const topSalesman = currentData.topSalesman || null;

  let summary = `नमस्ते! ${periodText} की राम एग्री सेल्स रिपोर्ट।\n\n`;
  
  summary += `${periodText} कुल ${formatHindiNumber(currentOrders)} ऑर्डर मिले। `;
  if (orderChange > 0) {
    summary += `यह ${previousPeriodText} से ${formatHindiNumber(Math.abs(orderChange))} अधिक है, यानी ${Math.abs(orderChangePercent)}% वृद्धि। `;
  } else if (orderChange < 0) {
    summary += `यह ${previousPeriodText} से ${formatHindiNumber(Math.abs(orderChange))} कम है, यानी ${Math.abs(orderChangePercent)}% कमी। `;
  } else {
    summary += `यह ${previousPeriodText} के बराबर है। `;
  }

  summary += `\n\n${periodText} कुल ${formatHindiNumber(currentDispatched)} ऑर्डर डिस्पैच किए गए। `;
  if (dispatchedChange > 0) {
    summary += `यह ${previousPeriodText} से ${formatHindiNumber(Math.abs(dispatchedChange))} अधिक है। `;
  } else if (dispatchedChange < 0) {
    summary += `यह ${previousPeriodText} से ${formatHindiNumber(Math.abs(dispatchedChange))} कम है। `;
  }

  summary += `\n\n${periodText} कुल बिक्री ₹${formatHindiNumber(currentSales)} है। `;
  if (salesChange > 0) {
    summary += `यह ${previousPeriodText} से ₹${formatHindiNumber(Math.abs(salesChange))} अधिक है, यानी ${Math.abs(salesChangePercent)}% वृद्धि। `;
  } else if (salesChange < 0) {
    summary += `यह ${previousPeriodText} से ₹${formatHindiNumber(Math.abs(salesChange))} कम है, यानी ${Math.abs(salesChangePercent)}% कमी। `;
  }

  if (topSalesman) {
    summary += `\n\nसबसे अच्छा प्रदर्शन ${topSalesman.name} का रहा, जिन्होंने ₹${formatHindiNumber(topSalesman.sales)} की बिक्री की। `;
  }

  summary += `\n\nधन्यवाद!`;

  return summary;
};

// Generate video using D-ID API (free tier available)
const generateVideoWithDID = async (text, language = 'hi') => {
  try {
    // D-ID API credentials (you'll need to add these to .env)
    const D_ID_API_KEY = process.env.D_ID_API_KEY;
    const D_ID_API_URL = 'https://api.d-id.com';

    if (!D_ID_API_KEY) {
      throw new Error('D_ID_API_KEY not configured');
    }

    // D-ID API authentication
    // Try multiple authentication methods based on API key format
    let authHeader;
    
    if (D_ID_API_KEY.includes(':')) {
      // Format: username:password
      // Try Basic Auth first (most common)
      authHeader = `Basic ${Buffer.from(D_ID_API_KEY).toString('base64')}`;
    } else {
      // Single API key - use as Bearer token
      authHeader = `Bearer ${D_ID_API_KEY}`;
    }
    
    // Alternative: If Basic Auth fails, D-ID might use just the password part as Bearer
    // This will be handled in error catch block

    // Step 1: Create a talk
    const talkResponse = await axios.post(
      `${D_ID_API_URL}/talks`,
      {
        source_url: 'https://d-id-public-bucket.s3.amazonaws.com/alice.jpg', // Default avatar
        script: {
          type: 'text',
          input: text,
          provider: {
            type: 'microsoft',
            voice_id: 'hi-IN-SwaraNeural', // Hindi female voice
          },
          ssml: false,
        },
        config: {
          stitch: true,
        },
      },
      {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
      }
    );

    const talkId = talkResponse.data.id;

    // Step 2: Poll for completion
    let status = 'created';
    let videoUrl = null;
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max

    while (status !== 'done' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const authHeader = `Basic ${Buffer.from(D_ID_API_KEY).toString('base64')}`;

      const statusResponse = await axios.get(
        `${D_ID_API_URL}/talks/${talkId}`,
        {
          headers: {
            'Authorization': authHeader,
          },
        }
      );

      status = statusResponse.data.status;
      if (status === 'done') {
        videoUrl = statusResponse.data.result_url;
        break;
      }
      attempts++;
    }

    return { videoUrl, talkId };
  } catch (error) {
    console.error('D-ID API Error Details:');
    console.error('  Status:', error.response?.status);
    console.error('  Status Text:', error.response?.statusText);
    console.error('  Response Data:', JSON.stringify(error.response?.data, null, 2));
    
    // If Basic Auth failed, try using just the password part as Bearer token
    if ((error.response?.status === 401 || error.response?.status === 403) && D_ID_API_KEY.includes(':')) {
      console.log('  Retrying with Bearer token (password part only)...');
      try {
        const passwordPart = D_ID_API_KEY.split(':')[1];
        const retryAuthHeader = `Bearer ${passwordPart}`;
        
        const retryResponse = await axios.post(
          `${D_ID_API_URL}/talks`,
          {
            source_url: 'https://d-id-public-bucket.s3.amazonaws.com/alice.jpg',
            script: {
              type: 'text',
              input: text,
              provider: {
                type: 'microsoft',
                voice_id: 'hi-IN-SwaraNeural',
              },
              ssml: false,
            },
            config: {
              stitch: true,
            },
          },
          {
            headers: {
              'Authorization': retryAuthHeader,
              'Content-Type': 'application/json',
            },
          }
        );
        
        // If retry succeeds, continue with this auth method
        const retryTalkId = retryResponse.data.id;
        let status = 'created';
        let videoUrl = null;
        let attempts = 0;
        
        while (status !== 'done' && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          const statusResponse = await axios.get(
            `${D_ID_API_URL}/talks/${retryTalkId}`,
            {
              headers: {
                'Authorization': retryAuthHeader,
              },
            }
          );
          
          status = statusResponse.data.status;
          if (status === 'done') {
            videoUrl = statusResponse.data.result_url;
            break;
          }
          attempts++;
        }
        
        return { videoUrl, talkId: retryTalkId };
      } catch (retryError) {
        console.error('  Retry also failed:', retryError.response?.data || retryError.message);
      }
    }
    
    // Provide more helpful error messages
    if (error.response?.status === 401 || error.response?.status === 403) {
      const errorMsg = error.response?.data?.message || error.response?.data?.error || 'Authentication failed';
      throw new Error(`D-ID API authentication failed: ${errorMsg}. Please verify your D_ID_API_KEY is valid at https://studio.d-id.com/`);
    } else if (error.response?.status === 429) {
      throw new Error('D-ID API rate limit exceeded. Please try again later.');
    } else if (error.response?.data) {
      throw new Error(`D-ID API Error: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
};

// FREE Alternative: Generate video using Google Cloud TTS + FFmpeg
const generateVideoWithGoogleTTS = async (text) => {
  try {
    const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
    
    if (!GOOGLE_TTS_API_KEY) {
      throw new Error('GOOGLE_TTS_API_KEY not configured. Get free API key from https://console.cloud.google.com/');
    }

    // Step 1: Generate Hindi audio using Google Cloud TTS (FREE: 0-4M chars/month)
    const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
    
    const ttsResponse = await axios.post(ttsUrl, {
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

    const audioBase64 = ttsResponse.data.audioContent;
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Step 2: Create temp directory
    const tempDir = path.join(process.cwd(), 'temp', 'videos');
    await fs.mkdir(tempDir, { recursive: true });

    const timestamp = Date.now();
    const audioPath = path.join(tempDir, `audio-${timestamp}.mp3`);
    await fs.writeFile(audioPath, audioBuffer);

    // Step 3: Check if FFmpeg is installed
    try {
      await execAsync('ffmpeg -version');
    } catch (error) {
      throw new Error('FFmpeg not installed. Install with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)');
    }

    // Step 4: Get audio duration
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

    // Step 5: Create video with text overlay
    const videoPath = path.join(tempDir, `video-${timestamp}.mp4`);
    
    // Create video with audio (text overlay may not be available in all FFmpeg builds)
    // For now, create a simple video with gradient background and audio
    // The Hindi text summary is available in the API response for display in frontend
    const ffmpegCommand = `ffmpeg -f lavfi -i color=c=0x1a1f2e:s=1280x720:d=${videoDuration} -i "${audioPath}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -shortest -y "${videoPath}" 2>&1`;

    await execAsync(ffmpegCommand);

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
};

export const generateRamAgriVideoSummary = catchAsync(async (req, res, next) => {
  const { period = 'day' } = req.query; // 'day' or 'week'

  // Calculate date ranges
  const now = new Date();
  let currentStart, currentEnd, previousStart, previousEnd;

  if (period === 'day') {
    // Today
    currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    currentEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    // Yesterday
    previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 1);
    previousEnd = new Date(currentEnd);
    previousEnd.setDate(previousEnd.getDate() - 1);
  } else {
    // This week (Monday to Sunday)
    const today = new Date(now);
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust to Monday
    currentStart = new Date(today.getFullYear(), today.getMonth(), diff);
    currentStart.setHours(0, 0, 0, 0);
    currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + 6);
    currentEnd.setHours(23, 59, 59, 999);
    
    // Previous week
    previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 7);
    previousEnd = new Date(currentEnd);
    previousEnd.setDate(previousEnd.getDate() - 7);
  }

  // Fetch current period data
  const currentOrders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    orderDate: {
      $gte: currentStart,
      $lte: currentEnd,
    },
  }).lean();

  const currentDispatched = currentOrders.filter(
    o => o.orderStatus === 'DISPATCHED' || o.orderStatus === 'COMPLETED'
  ).length;

  const currentSales = currentOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);

  // Get top salesman for current period
  const salesmanSales = {};
  currentOrders.forEach(order => {
    // Try multiple fields for sales person assignment
    const salesmanId = order.assignedTo?.toString() || 
                       order.assignedToUser?.toString() || 
                       order.salesPerson?.toString() ||
                       order.sales?.toString();
    if (salesmanId && mongoose.Types.ObjectId.isValid(salesmanId)) {
      if (!salesmanSales[salesmanId]) {
        salesmanSales[salesmanId] = { id: salesmanId, sales: 0, orders: 0 };
      }
      salesmanSales[salesmanId].sales += order.totalAmount || 0;
      salesmanSales[salesmanId].orders += 1;
    }
  });

  const topSalesmanData = Object.values(salesmanSales)
    .sort((a, b) => b.sales - a.sales)[0];

  let topSalesman = null;
  if (topSalesmanData) {
    const user = await User.findById(topSalesmanData.id).select('name phoneNumber').lean();
    if (user) {
      topSalesman = {
        name: user.name || 'Unknown',
        sales: topSalesmanData.sales,
        orders: topSalesmanData.orders,
      };
    }
  }

  const currentData = {
    totalOrders: currentOrders.length,
    dispatchedOrders: currentDispatched,
    totalSales: currentSales,
    topSalesman,
  };

  // Fetch previous period data
  const previousOrders = await AgriSalesOrder.find({
    isRamAgriProduct: true,
    orderDate: {
      $gte: previousStart,
      $lte: previousEnd,
    },
  }).lean();

  const previousDispatched = previousOrders.filter(
    o => o.orderStatus === 'DISPATCHED' || o.orderStatus === 'COMPLETED'
  ).length;

  const previousSales = previousOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);

  const previousData = {
    totalOrders: previousOrders.length,
    dispatchedOrders: previousDispatched,
    totalSales: previousSales,
  };

  // Generate Hindi summary text
  const hindiSummary = generateHindiSummary(currentData, previousData, period);

  // Try to generate video - try D-ID first, then free Google TTS method
  let videoData = null;
  let videoError = null;
  
  // Method 1: Try D-ID API (if configured)
  if (process.env.D_ID_API_KEY) {
    try {
      videoData = await generateVideoWithDID(hindiSummary, 'hi');
      if (videoData?.videoUrl) {
        videoData.method = 'd-id';
      }
    } catch (error) {
      console.error('D-ID video generation failed:', error.message);
      // Fall through to free method
    }
  }
  
  // Method 2: Try FREE Google TTS + FFmpeg (if D-ID failed or not configured)
  if (!videoData?.videoUrl) {
    try {
      const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
      if (GOOGLE_TTS_API_KEY) {
        // Use inline Google TTS method
        videoData = await generateVideoWithGoogleTTS(hindiSummary);
        videoData.method = 'google-tts-ffmpeg';
      } else {
        videoError = 'No video API configured. Add D_ID_API_KEY or GOOGLE_TTS_API_KEY to .env. See FREE_VIDEO_ALTERNATIVES.md for free setup.';
      }
    } catch (error) {
      console.error('Google TTS video generation failed:', error.message);
      videoError = error.message;
    }
  }

  const responseData = {
    period,
    currentPeriod: {
      start: currentStart,
      end: currentEnd,
      ...currentData,
    },
    previousPeriod: {
      start: previousStart,
      end: previousEnd,
      ...previousData,
    },
    comparison: {
      orderChange: currentData.totalOrders - previousData.totalOrders,
      orderChangePercent: previousData.totalOrders > 0
        ? ((currentData.totalOrders - previousData.totalOrders) / previousData.totalOrders * 100).toFixed(1)
        : 0,
      dispatchedChange: currentData.dispatchedOrders - previousData.dispatchedOrders,
      salesChange: currentData.totalSales - previousData.totalSales,
      salesChangePercent: previousData.totalSales > 0
        ? ((currentData.totalSales - previousData.totalSales) / previousData.totalSales * 100).toFixed(1)
        : 0,
    },
    hindiSummary,
    video: videoData,
    videoError: videoError || null,
  };

  const response = generateResponse(
    "Success",
    "Ram Agri video summary generated successfully",
    responseData,
    undefined
  );

  return res.status(200).json(response);
});
