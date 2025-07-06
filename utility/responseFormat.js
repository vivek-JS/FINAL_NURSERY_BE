function generateResponse(status, message, data, error) {
  return {
    status: status,
    message: message,
    data: data,
    error: error,
  };
}

export default generateResponse;
