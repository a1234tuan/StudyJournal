const openVoiceAsrSocket = (url, headers) => {
  const socket = new WebSocket(url, { headers });
  socket.binaryType = "arraybuffer";
  return socket;
};

const sendVoiceAsrFrame = (socket, data) => {
  if (!socket || socket.readyState !== 1) throw new Error("语音识别连接未就绪。");
  if (typeof data !== "string" && !(data instanceof Uint8Array)) throw new Error("语音识别帧类型无效。");
  socket.send(data);
  return { sent: true };
};

module.exports = { openVoiceAsrSocket, sendVoiceAsrFrame };
