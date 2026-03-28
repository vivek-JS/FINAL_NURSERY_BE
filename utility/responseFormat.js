function generateResponse(status, message, data, error, extras) {
  const base = {
    status: status,
    message: message,
    data: data,
    error: error,
  };
  if (extras && typeof extras === "object") {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) base[k] = v;
    }
  }
  return base;
}

export default generateResponse;
