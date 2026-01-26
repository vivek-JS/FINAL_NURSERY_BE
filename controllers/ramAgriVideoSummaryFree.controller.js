/**
 * FREE Alternative Video Generation
 * Uses Google Cloud TTS (FREE tier) + FFmpeg
 * No paid API required!
 */

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

// Helper function to generate Hindi text summary (same as before)
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

// FREE: Generate video using Google Cloud TTS + FFmpeg
const generateVideoWithGoogleTTS = async (text) => {
  try {
    // Check if Google TTS API key is configured
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

    // Step 3: Create video with FFmpeg
    // Check if FFmpeg is installed
    try {
      await execAsync('ffmpeg -version');
    } catch (error) {
      throw new Error('FFmpeg not installed. Install with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)');
    }

    const videoPath = path.join(tempDir, `video-${timestamp}.mp4`);
    
    // Get audio duration first
    const { stdout: durationOutput } = await execAsync(
      `ffprobe -i "${audioPath}" -show_entries format=duration -v quiet -of csv="p=0"`
    );
    const duration = parseFloat(durationOutput.trim()) || 30;
    const videoDuration = Math.ceil(duration) + 2; // Add 2 seconds buffer

    // Create video with gradient background and text overlay
    // Split text into lines for better display
    const textLines = text.split('\n').filter(line => line.trim()).slice(0, 5); // Max 5 lines
    const textOverlay = textLines.map((line, idx) => 
      `drawtext=text='${line.replace(/'/g, "\\'").replace(/:/g, "\\:")}':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=${100 + idx * 60}:box=1:boxcolor=black@0.5:boxborderw=5`
    ).join(',');

    const ffmpegCommand = `ffmpeg -f lavfi -i color=c=0x1a1f2e:s=1280x720:d=${videoDuration} -i "${audioPath}" -vf "${textOverlay}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -shortest -y "${videoPath}"`;

    await execAsync(ffmpegCommand);

    // Step 4: Upload to Cloudinary (if configured) or return local path
    // For now, return local path - you can add Cloudinary upload here
    
    // Clean up audio file
    await fs.unlink(audioPath).catch(() => {});

    return {
      videoPath,
      videoUrl: `/api/v1/videos/${path.basename(videoPath)}`, // You'll need to create a route to serve this
      duration: videoDuration,
      method: 'google-tts-ffmpeg'
    };
  } catch (error) {
    console.error('Google TTS Video generation error:', error.message);
    throw error;
  }
};

// Export the main function (same structure as D-ID version)
export const generateRamAgriVideoSummary = catchAsync(async (req, res, next) => {
  const { period = 'day' } = req.query;

  // ... (same date calculation and data fetching logic as before)
  // Calculate date ranges
  const now = new Date();
  let currentStart, currentEnd, previousStart, previousEnd;

  if (period === 'day') {
    currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    currentEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 1);
    previousEnd = new Date(currentEnd);
    previousEnd.setDate(previousEnd.getDate() - 1);
  } else {
    const today = new Date(now);
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    currentStart = new Date(today.getFullYear(), today.getMonth(), diff);
    currentStart.setHours(0, 0, 0, 0);
    currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + 6);
    currentEnd.setHours(23, 59, 59, 999);
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

  // Get top salesman
  const salesmanSales = {};
  currentOrders.forEach(order => {
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

  // Try to generate video using FREE method
  let videoData = null;
  let videoError = null;
  try {
    videoData = await generateVideoWithGoogleTTS(hindiSummary);
  } catch (error) {
    console.error('Video generation failed:', error.message);
    videoError = error.message;
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
