const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { origin: '*' },
  pingTimeout: 60000
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {}; // { roomId: { users: [], hostId: null } }

io.on('connection', (socket) => {
  console.log('👤 Пользователь подключился:', socket.id);

  socket.on('join-room', (data) => {
    const { roomId, isHost } = data;
    if (!rooms[roomId]) rooms[roomId] = { users: [], hostId: null };
    
    socket.join(roomId);
    socket.userId = socket.id.slice(-4);
    socket.roomId = roomId;
    socket.isHost = isHost;
    socket.color = ['#ff4444', '#44ff44', '#4444ff', '#ff44ff', '#44ffff'][rooms[roomId].users.length % 5];
    
    rooms[roomId].users.push(socket.id);
    if (isHost && !rooms[roomId].hostId) rooms[roomId].hostId = socket.id;
    
    // Уведомить всех
    io.to(roomId).emit('user-joined', { 
      userId: socket.userId, 
      color: socket.color, 
      users: rooms[roomId].users.length,
      hostId: rooms[roomId].hostId 
    });
  });

  socket.on('screen-stream', (data) => socket.to(data.roomId).emit('screen-stream', data));
  socket.on('remote-input', (data) => socket.to(data.hostId).emit('execute-input', data));
  socket.on('cursor-move', (data) => socket.to(data.roomId).emit('remote-cursor', data));
  socket.on('chat-message', (data) => {
    socket.to(data.roomId).emit('chat-message', data);
    socket.emit('chat-message', data);
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].users = rooms[socket.roomId].users.filter(id => id !== socket.id);
      io.to(socket.roomId).emit('user-left', { users: rooms[socket.roomId].users.length });
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Сервер:', `http://localhost:${process.env.PORT || 3000}`);
});
