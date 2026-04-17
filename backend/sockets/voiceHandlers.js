import { writeLog } from '../services/logger.js';
import * as voice from '../voiceService.js';

export default function registerVoiceHandlers(io, socket) {
  socket.on('process_voice', async ({ audioBuffer, sessionId }, callback) => {
    const text = await voice.transcribeAudio(audioBuffer, writeLog, sessionId);
    callback({ text });
  });
}
