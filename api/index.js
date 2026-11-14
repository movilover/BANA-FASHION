// Vercel entry for ALL other /api/* routes: runs your existing Express app (server.js) unchanged.
// server.js must export the app and only listen() when run directly (see notes).
const app = require('../server');
module.exports = app.default || app;
