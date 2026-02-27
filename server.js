const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

io.on('connection', (socket) => {
  console.log('✅ Пользователь подключился:', socket.id);
  
  socket.on('join-room', (data) => {
    const { roomId } = data;
    if (!rooms[roomId]) rooms[roomId] = { users: [] };
    
    socket.join(roomId);
    socket.roomId = roomId;
    
    rooms[roomId].users.push(socket.id);
    
    // Сообщить всем в комнате
    io.to(roomId).emit('user-joined', { 
      userId: socket.id.slice(-4),
      color: ['#ff4444', '#44ff44', '#4444ff', '#ff44ff'][rooms[roomId].users.length % 4],
      users: rooms[roomId].users.length 
    });
    
    console.log(`👥 Комната ${roomId}: ${rooms[roomId].users.length} пользователей`);
  });

  // Простая имитация трансляции экрана (черный фон + курсоры пока)
  socket.on('screen-update', (data) => {
    socket.to(data.roomId).emit('screen-update', data);
  });

  // Управление и курсоры
  socket.on('remote-input', (data) => {
    socket.to(data.roomId).emit('execute-input', data);
  });
  
  socket.on('cursor-move', (data) => {
    socket.to(data.roomId).emit('remote-cursor', data);
  });
  
  socket.on('chat-message', (data) => {
    io.to(data.roomId).emit('chat-message', data);
  });

  socket.on('disconnect', () => {
    console.log('❌', socket.id, 'отключился');
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].users = rooms[socket.roomId].users.filter(id => id !== socket.id);
      io.to(socket.roomId).emit('user-left', { users: rooms[socket.roomId].users.length });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
  console.log('📱 С телефона: http://[твой_IP]:${PORT}');
});
