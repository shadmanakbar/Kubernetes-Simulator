const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const simulationRouter = require('./routes/simulation');

const app = express();
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Store WebSocket server instance in app for access in routes
app.set('wss', wss);

// Middleware
app.use(cors());
app.use(express.json());

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Routes
app.use('/api/simulation', simulationRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
