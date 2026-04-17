import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const LOG_FILE_PATH = process.env.LOG_FILE_PATH;

let logDir;
let logFile;

if (LOG_FILE_PATH) {
  // If a specific file path is provided via .ENV, use it
  logFile = path.isAbsolute(LOG_FILE_PATH) 
    ? LOG_FILE_PATH 
    : path.resolve(__dirname, '..', '..', LOG_FILE_PATH);
    
  logDir = path.dirname(logFile);
} else {
  // Default fallback to the existing behavior
  logDir = path.join(__dirname, '..', 'logs');
  logFile = path.join(logDir, 'server.log');
}

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logStream = fs.createWriteStream(logFile, { flags: 'a' });

let ioInstance = null;

export function setIo(io) {
  ioInstance = io;
}

export function broadcastEvent(event, data) {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }
}

export function getLogFilePath() {
  return logFile;
}

const originalLog = console.log;
const originalError = console.error;

let isLogging = false;

export function writeLog(message) {
  if (isLogging) return; // Prevent infinite recursion from console wrappers
  isLogging = true;

  try {
    let safeMessage = typeof message === 'string' ? message : String(message);
    
    // Truncate massive payloads (like full file edits) to prevent I/O lockups
    if (safeMessage.length > 2000) {
      safeMessage = safeMessage.substring(0, 2000) + '... [TRUNCATED]';
    }

    const ts = new Date().toISOString();
    const formatted = `[${ts}] ${safeMessage}\n`;
    
    try {
      logStream.write(formatted);
    } catch (err) {
      originalError(`[LOGGER ERR] Failed to write to stream: ${err.message}`);
    }
    
    // Write to terminal using original console method
    originalLog(formatted.trim());
    
    if (ioInstance) {
      ioInstance.emit('log_update', formatted);
    }
  } finally {
    isLogging = false;
  }
}

// Redirect standard console to our integrated logger
// This ensures console.log() in providers or libraries is captured in files/UI
const safeStringify = (obj) => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (err) {
    return `[Unserializable Object: ${err.message}]`;
  }
};

console.log = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? safeStringify(a) : a)).join(' ');
  writeLog(msg);
};
console.error = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? safeStringify(a) : a)).join(' ');
  writeLog(`[ERROR] ${msg}`);
};
console.warn = (...args) => {
  const msg = args.map(a => (typeof a === 'object' ? safeStringify(a) : a)).join(' ');
  writeLog(`[WARN] ${msg}`);
};
