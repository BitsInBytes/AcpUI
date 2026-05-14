import express from 'express';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';

import { writeLog, setIo } from './services/logger.js';
import providerRuntimeManager from './services/providerRuntimeManager.js';
import router from './routes/index.js';
import createMcpApiRoutes from './routes/mcpApi.js';
import brandingRouter from './routes/brandingApi.js';
import registerSocketHandlers from './sockets/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const SERVER_BOOT_ID = crypto.randomUUID();

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || process.env.VITEST || process.env.NODE_ENV === 'test') return callback(null, true);
    
    // Allow localhost, 127.0.0.1, and private network IP ranges
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin);
    if (isLocal) {
      return callback(null, true);
    }

    writeLog(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error('CORS blocked'), false);
  },
  credentials: true
}));
app.use(express.json());

// MCP tool execution API — registered before static handler so /api/mcp/* routes aren't caught by the SPA fallback
// Note: io and acpClient aren't available yet, so we use a lazy initializer
let mcpApiRouter = null;
app.use('/api/mcp', (req, res, next) => {
  if (mcpApiRouter) return mcpApiRouter(req, res, next);
  res.status(503).json({ error: 'MCP API not ready' });
});

// Branding API — serves provider icons and manifest dynamically
app.use('/api/branding', brandingRouter);

// Register all modular routes (includes static file handler — must be after /api/mcp)
app.use('/', router);

// HTTPS Setup — falls back to HTTP if SSL certs are absent (e.g., test environment)
const keyPath = path.join(__dirname, '.ssl', 'key.pem');
const certPath = path.join(__dirname, '.ssl', 'cert.pem');
const httpServer = (fs.existsSync(keyPath) && fs.existsSync(certPath))
  ? createHttpsServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : createHttpServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || process.env.VITEST || /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin)) {
        callback(null, true);
      } else {
        writeLog(`[SOCKET CORS] Blocked origin: ${origin}`);
        callback(new Error('CORS blocked'), false);
      }
    },
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 100 * 1024 * 1024
});

import { startSTTServer, stopSTTServer } from './voiceService.js';

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  writeLog(`[CRITICAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (err) => {
  writeLog(`[CRITICAL] Uncaught Exception: ${err.message}\n${err.stack}`);
});

// Initialize services
setIo(io);
mcpApiRouter = createMcpApiRoutes(io);
startSTTServer();

// Register socket event handlers
registerSocketHandlers(io);

const PORT = process.env.BACKEND_PORT || 3005;
let isShuttingDown = false;

export async function shutdownServer({ signal = 'shutdown', exit = false } = {}) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  writeLog(`[SERVER] ${signal} received; shutting down backend runtime.`);

  await providerRuntimeManager.stopAll?.();
  stopSTTServer();

  await new Promise((resolve) => {
    io.close(() => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close(() => resolve());
    });
  });

  writeLog('[SERVER] Backend shutdown complete.');
  if (!exit) isShuttingDown = false;
  if (exit) process.exit(0);
}

export function startServer() {
  isShuttingDown = false;
  httpServer.listen(PORT, '0.0.0.0', () => {
    writeLog(`Backend server listening on https://localhost:${PORT} and https://0.0.0.0:${PORT}`);
    // Init ACP after server is listening so MCP API is reachable by the stdio proxy
    providerRuntimeManager.init(io, SERVER_BOOT_ID);
  });
  return httpServer;
}

// Only start if this file is run directly AND not in test environment
const expectedUrl = pathToFileURL(__filename).href;
if (import.meta.url === expectedUrl && !process.env.VITEST) {
  process.once('SIGINT', () => shutdownServer({ signal: 'SIGINT', exit: true }));
  process.once('SIGTERM', () => shutdownServer({ signal: 'SIGTERM', exit: true }));
  startServer();
}

export { app, httpServer, io };
