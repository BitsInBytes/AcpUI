#!/usr/bin/env node
/**
 * View the context debugging log for Gemini provider.
 * Usage: node view-context-log.js
 *
 * Clears the log on startup to get fresh data for each test session.
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'context_debug.log');

// Clear the log
if (fs.existsSync(LOG_FILE)) {
  fs.unlinkSync(LOG_FILE);
  console.log('✓ Cleared previous log');
}

console.log(`\nLogging context events to: ${LOG_FILE}`);
console.log('Run your prompts now, then view the log...\n');

// Watch the file
const interval = setInterval(() => {
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    console.clear();
    console.log(`=== Context Debug Log (${lines.length} events) ===\n`);
    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp.split('T')[1].split('Z')[0];
        console.log(`[${ts}] ${entry.message}`);
        delete entry.timestamp;
        delete entry.message;
        console.log('       ', JSON.stringify(entry, null, 2).split('\n').join('\n        '));
      } catch {
        console.log(line);
      }
    });
  }
}, 500);

process.on('SIGINT', () => {
  clearInterval(interval);
  console.log('\n\n✓ Log monitoring stopped');
  process.exit(0);
});
