const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { origin: "*" }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

io.on('connection', (socket) => {
  console.log('✅ ПОДКЛЮЧИЛСЯ:', socket.id.slice(-4));

  socket.on('join-room', (roomId) => {
    console.log('👥 Присоединился к', roomId);
    socket.join(roomId);
    socket.roomId = roomId;
    
    if (!rooms[roomId]) rooms[roomId] = { users: [] };
    rooms[roomId].users.push(socket.id);
    
    // Всем в комнате
    io.to(roomId).emit('user-joined', { 
      users: rooms[roomId].users.length,
      userId: socket.id.slice(-4)
    });
  });

  // ПЕРЕДАЧА ЭКРАНА
  socket.on('screen-data', (data) => {
    socket.to(data.roomId).emit('screen-data', data);
  });

  // УПРАВЛЕНИЕ
  socket.on('mouse-event', (data) => {
    socket.to(data.roomId).emit('mouse-event', data);
  });

  socket.on('disconnect', () => {
    console.log('❌ ОТКЛЮЧИЛСЯ:', socket.id.slice(-4));
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('🚀 http://localhost:3000');
});
