const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};
const peers = {};

io.on('connection', (socket) => {
  console.log('👤', socket.id);

  // WebRTC Signaling
  socket.on('join-room', (data) => {
    const { roomId, userData } = data;
    if (!rooms[roomId]) rooms[roomId] = { users: [], hostId: null };
    
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userData = userData;
    socket.color = ['#ff4444', '#44ff44', '#4444ff', '#ff44ff', '#44ffff'][rooms[roomId].users.length];
    
    rooms[roomId].users.push(socket.id);
    io.to(roomId).emit('user-joined', { 
      userId: socket.id, 
      color: socket.color, 
      users: rooms[roomId].users.length 
    });
    
    // Отправить список пиров новым участникам
    socket.emit('all-users', rooms[roomId].users.filter(id => id !== socket.id));
  });

  // WebRTC signaling
  socket.on('offer', (data) => socket.to(data.target).emit('offer', { offer: data.offer, sender: socket.id }));
  socket.on('answer', (data) => socket.to(data.target).emit('answer', { answer: data.answer, sender: socket.id }));
  socket.on('ice-candidate', (data) => socket.to(data.target).emit('ice-candidate', { candidate: data.candidate, sender: socket.id }));

  // Управление + курсоры
  socket.on('remote-input', (data) => socket.to(data.targetId).emit('execute-input', data));
  socket.on('cursor-move', (data) => socket.to(data.roomId).emit('remote-cursor', data));
  
  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      rooms[socket.roomId].users = rooms[socket.roomId].users.filter(id => id !== socket.id);
      io.to(socket.roomId).emit('user-disconnected', socket.id);
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Сервер:', `http://localhost:${process.env.PORT || 3000}`);
});
