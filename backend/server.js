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
import acpClient from './services/acpClient.js';
import router from './routes/index.js';
import createMcpApiRoutes from './routes/mcpApi.js';
import brandingRouter from './routes/brandingApi.js';
import registerSocketHandlers from './sockets/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SERVER_BOOT_ID = crypto.randomUUID();

const app = express();
app.use(cors());
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
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 100 * 1024 * 1024
});

import { startSTTServer } from './voiceService.js';

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  writeLog(`[CRITICAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (err) => {
  writeLog(`[CRITICAL] Uncaught Exception: ${err.message}\n${err.stack}`);
});

// Initialize services
setIo(io);
mcpApiRouter = createMcpApiRoutes(io, acpClient);
startSTTServer();

// Register socket event handlers
registerSocketHandlers(io);

const PORT = process.env.BACKEND_PORT || 3005;

export function startServer() {
  httpServer.listen(PORT, '0.0.0.0', () => {
    writeLog(`Backend server listening on https://localhost:${PORT} and https://0.0.0.0:${PORT}`);
    // Init ACP after server is listening so MCP API is reachable by the stdio proxy
    acpClient.init(io, SERVER_BOOT_ID);
  });
  return httpServer;
}

// Only start if this file is run directly AND not in test environment
const expectedUrl = pathToFileURL(__filename).href;
if (import.meta.url === expectedUrl && !process.env.VITEST) {
  startServer();
}

export { app, httpServer, io };
