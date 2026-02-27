const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ✅ Socket.io с поддержкой Render (WebSocket + polling)
const io = socketIo(server, { 
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

io.on('connection', (socket) => {
  console.log('✅', socket.id);

  socket.on('join-room', (data) => {
    const { roomId } = data;
    if (!rooms[roomId]) rooms[roomId] = { users: [] };
    
    socket.join(roomId);
    socket.roomId = roomId;
    rooms[roomId].users.push(socket.id);
    
    io.to(roomId).emit('user-joined', { 
      userId: socket.id.slice(-4),
      color: ['#ff4444', '#44ff44', '#4444ff', '#ff44ff'][rooms[roomId].users.length % 4],
      users: rooms[roomId].users.length 
    });
  });

  socket.on('cursor-move', (data) => socket.to(data.roomId).emit('remote-cursor', data));
  socket.on('remote-input', (data) => socket.to(data.roomId).emit('execute-input', data));
  socket.on('chat-message', (data) => io.to(data.roomId).emit('chat-message', data));

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].users = rooms[socket.roomId].users.filter(id => id !== socket.id);
    }
  });
});

// ✅ Render слушает ВСЕ IP и порты
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Render: https://твоя-приложение.onrender.com`);
});
