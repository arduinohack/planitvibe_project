require('dotenv').config();  // Loads .env vars (e.g., JWT_SECRET, MONGODB_URI)
const http = require('http');
const mongoose = require('mongoose');
const logger = require('./utils/logger');
const { ensureHotIndexes } = require('./utils/ensureHotIndexes');
const app = require('./app');

const PORT = process.env.PORT || 3000;

logger.info('Server starting up', { port: process.env.PORT || 3000 });

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  bufferTimeoutMS: 5000,  // 5s timeout for buffering (fails fast if DB slow)
  serverSelectionTimeoutMS: 5000,  // 5s for server selection (quick detect if DB down)
  maxPoolSize: 10,  // Limit connections to 10 (prevents overload)
}).then(async () => {
  logger.info('Connected to MongoDB');
  try {
    await ensureHotIndexes();
  } catch (err) {
    logger.error('Hot index setup failed:', err);
  }
}).catch((err) => {
  logger.error('MongoDB connection error:', err);
});

// Connection events for debugging
mongoose.connection.on('connected', () => logger.info('Mongoose connected'));
mongoose.connection.on('error', (err) => logger.error('Mongoose error:', err));
mongoose.connection.on('disconnected', () => {
  logger.info('Mongoose disconnected—reconnecting...');
  setTimeout(() => mongoose.connect(process.env.MONGODB_URI), 5000);  // Reconnect after 5s
});

(async () => {
  const override = process.env.REDIS_URL;
  const redisSource = typeof override === 'string' && override.trim() !== ''
    ? 'REDIS_URL'
    : 'localhost:6379';
  const redisUrl = redisSource === 'REDIS_URL' ? override.trim() : 'redis://localhost:6379';
  try {
    const redis = require('redis');
    const client = redis.createClient({ url: redisUrl });
    client.on('error', err => console.log('Redis Client Error', err));
    await client.connect();
    logger.info('Redis connected', { source: redisSource });
    global.redisClient = client;
  } catch (err) {
    logger.error('Redis connection failed:', err);
    logger.info('Logout blacklist disabled');
    global.redisClient = null;
  }
})();

if (require.main === module) {
  // Jest loads app.js and does not listen. Presence stays on this process only.
  const server = http.createServer(app);
  const { attachPresence } = require('./realtime/presence');
  // Keeps this io so a saved reaction can emit on the plan room.
  attachPresence(server, { allowsBrowserOrigin: app.allowsBrowserOrigin });
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

module.exports = app;
