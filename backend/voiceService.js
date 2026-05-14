import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getAttachmentsRoot } from './services/attachmentVault.js';
import { writeLog } from './services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const WHISPER_SERVER = path.join(__dirname, 'whisper', 'whisper-server.exe');
const WHISPER_MODEL = path.join(__dirname, 'whisper', 'ggml-small.bin');
const STT_PORT = process.env.STT_PORT || '9877';

let serverProcess = null;

export function isSTTEnabled() {
  return process.env.VOICE_STT_ENABLED === 'true';
}

export function startSTTServer() {
  if (!isSTTEnabled() || serverProcess) return;

  writeLog(`[VOICE] Starting whisper-server on port ${STT_PORT}...`);
  serverProcess = spawn(WHISPER_SERVER, [
    '-m', WHISPER_MODEL,
    '--port', String(STT_PORT),
    '-t', '4'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && msg.includes('error')) writeLog(`[WHISPER] ${msg}`);
  });
  serverProcess.on('exit', (code) => {
    writeLog(`[VOICE] whisper-server exited with code ${code}`);
    serverProcess = null;
  });
}

export function stopSTTServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  try {
    proc.kill?.();
  } catch (err) {
    writeLog(`[VOICE] Failed to stop whisper-server: ${err.message}`);
  }
}

export async function transcribeAudio(audioBuffer, log, sessionId) {
  if (!isSTTEnabled()) return null;
  if (!audioBuffer) { log('[VOICE] No audio buffer received.'); return null; }

  let filePath = null;
  try {
    const dir = path.join(getAttachmentsRoot(), sessionId || 'voice');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, `stt-${Date.now()}.wav`);
    fs.writeFileSync(filePath, Buffer.from(audioBuffer));

    const formData = new FormData();
    formData.append('file', new Blob([fs.readFileSync(filePath)]), 'audio.wav');
    formData.append('response_format', 'text');

    const res = await fetch(`http://127.0.0.1:${STT_PORT}/inference`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error(`whisper-server returned ${res.status}`);
    const text = (await res.text()).trim();

    log(`[VOICE] Transcribed: "${text}"`);
    return text || null;
  } catch (err) {
    log(`[VOICE ERR] ${err.message}`);
    return null;
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch { /* ignore */ }
    }
  }
}
