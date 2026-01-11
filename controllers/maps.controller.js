import catchAsync from "../utility/catchAsync.js";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "AIzaSyBq5k9ataLH59YpmLOyj4N2kiUWZquSQOs";

/**
 * Proxy endpoint for Google Directions API
 * This avoids CORS issues by making the request from the backend
 */
export const getDirections = catchAsync(async (req, res) => {
  const { origin, destination, waypoints, optimizeWaypoints = true } = req.body;

  if (!origin || !destination) {
    return res.status(400).json({
      success: false,
      message: "Origin and destination are required"
    });
  }

  try {
    // Build waypoints string
    let waypointStr = "";
    if (waypoints && waypoints.length > 0) {
      const waypointCoords = waypoints
        .map(wp => {
          if (typeof wp === 'string') return wp;
          if (wp.lat && wp.lng) return `${wp.lat},${wp.lng}`;
          if (wp.location) return `${wp.location.lat},${wp.location.lng}`;
          return null;
        })
        .filter(Boolean)
        .join('|');
      
      waypointStr = optimizeWaypoints 
        ? `optimize:true|${waypointCoords}`
        : waypointCoords;
    }

    // Build origin and destination strings
    const originStr = typeof origin === 'string' 
      ? origin 
      : `${origin.lat},${origin.lng}`;
    
    const destStr = typeof destination === 'string'
      ? destination
      : `${destination.lat},${destination.lng}`;

    // Build Google Directions API URL
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(originStr)}&destination=${encodeURIComponent(destStr)}${waypointStr ? `&waypoints=${encodeURIComponent(waypointStr)}` : ''}&key=${GOOGLE_MAPS_API_KEY}`;

    // Make request to Google Directions API
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.routes && data.routes.length > 0) {
      return res.json({
        success: true,
        data: data
      });
    } else {
      return res.status(400).json({
        success: false,
        message: data.error_message || `Directions API returned: ${data.status}`,
        data: data
      });
    }
  } catch (error) {
    console.error('Error calling Google Directions API:', error);
    return res.status(500).json({
      success: false,
      message: "Failed to get directions",
      error: error.message
    });
  }
});

