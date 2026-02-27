const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

io.on('connection', (socket) => {
  console.log('👤 Подключился:', socket.id);

  socket.on('register-host', (roomId) => {
    if (!rooms[roomId]) rooms[roomId] = { host: null, viewers: [] };
    rooms[roomId].host = socket.id;
    socket.join(roomId);
    socket.isHost = true;
    socket.roomId = roomId;
    console.log(`🖥️ Хост зарегистрирован в комнате ${roomId}`);
  });

  socket.on('join-viewer', (roomId) => {
    if (rooms[roomId] && rooms[roomId].host) {
      socket.join(roomId);
      socket.isViewer = true;
      socket.roomId = roomId;
      rooms[roomId].viewers.push(socket.id);
      
      // Сообщить хосту о новом зрителе
      io.to(rooms[roomId].host).emit('viewer-joined', socket.id);
      console.log(`👁️ Зритель ${socket.id.slice(-4)} в комнату ${roomId}`);
    }
  });

  // Пересылка команд управления от зрителей к хосту
  socket.on('viewer-control', (data) => {
    if (rooms[data.roomId] && rooms[data.roomId].host) {
      io.to(rooms[data.roomId].host).emit('execute-control', data);
    }
  });

  // Пересылка скриншотов от хоста всем зрителям
  socket.on('screen-frame', (data) => {
    socket.to(data.roomId).emit('screen-frame', data);
  });

  socket.on('disconnect', () => {
    if (socket.isHost && socket.roomId) {
      delete rooms[socket.roomId];
      console.log(`🖥️ Хост ${socket.id.slice(-4)} отключился`);
    } else if (socket.isViewer && socket.roomId) {
      const room = rooms[socket.roomId];
      if (room) {
        room.viewers = room.viewers.filter(id => id !== socket.id);
      }
    }
  });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('🚀 Сервер: http://localhost:3000');
});
