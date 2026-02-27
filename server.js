const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Безопасность
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname), { maxAge: '1h' }));

// Ограничение запросов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много запросов'
});
app.use('/socket.io/', limiter);

// Socket.IO сервер
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 50e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Глобальное состояние
const rooms = new Map();
const users = new Map();
const userColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#F8C471'];
const qualityPresets = {
  low: 0.3,
  medium: 0.6,
  high: 0.9,
  ultra: 1.0
};

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(roomId, hostId) {
    this.rooms.set(roomId, {
      id: roomId,
      hostId,
      users: new Set([hostId]),
      viewers: new Set(),
      screenActive: false,
      settings: {
        quality: 'medium',
        framerate: 30,
        cursorVisible: true,
        audioEnabled: false,
        zoomLevel: 1.0,
        mouseControl: true,
        keyboardControl: false
      },
      chatHistory: [],
      createdAt: Date.now(),
      lastFrameTime: 0
    });
    return this.rooms.get(roomId);
  }

  joinUser(roomId, userId, isViewer = false) {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.users.add(userId);
    if (isViewer) room.viewers.add(userId);
    
    return room;
  }

  leaveUser(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.users.delete(userId);
    room.viewers.delete(userId);
    
    if (room.hostId === userId) {
      room.screenActive = false;
    }

    if (room.users.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }
}

const roomManager = new RoomManager();

// Middleware для Socket.IO
io.use((socket, next) => {
  const userId = uuidv4().slice(0, 8);
  socket.userId = userId;
  socket.color = userColors[Math.floor(Math.random() * userColors.length)];
  users.set(userId, {
    id: userId,
    color: socket.color,
    connectedAt: Date.now(),
    lastActivity: Date.now()
  });
  next();
});

io.on('connection', (socket) => {
  console.log(`🟢 [${socket.userId.slice(0,4)}] Подключился (${Object.keys(users).length} онлайн)`);

  // Регистрация хоста
  socket.on('register-host', (data) => {
    const { roomId } = data;
    const room = roomManager.createRoom(roomId, socket.userId);
    
    socket.join(roomId);
    socket.isHost = true;
    socket.roomId = roomId;
    
    io.to(roomId).emit('system-message', {
      type: 'host-registered',
      message: `Хост ${socket.userId.slice(-4)} создал комнату`,
      timestamp: Date.now()
    });
    
    socket.emit('host-confirmed', { room: room });
    console.log(`🖥️ [${socket.userId.slice(-4)}] Хост ${roomId}`);
  });

  // Присоединение зрителя
  socket.on('join-room', (data) => {
    const { roomId } = data;
    const room = roomManager.getRoom(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Комната не найдена' });
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    roomManager.joinUser(roomId, socket.userId);
    
    socket.emit('room-joined', { 
      room,
      userColor: socket.color 
    });
    
    // Уведомить всех
    socket.to(roomId).emit('user-joined', {
      userId: socket.userId,
      color: socket.color,
      isHost: socket.isHost || false
    });

    console.log(`👁️ [${socket.userId.slice(-4)}] -> ${roomId}`);
  });

  // Трансляция экрана
  socket.on('screen-frame', (data) => {
    const { roomId, imageData, settings } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.hostId === socket.userId) {
      room.screenActive = true;
      room.lastFrameTime = Date.now();
      
      socket.to(roomId).emit('screen-frame', {
        imageData,
        timestamp: Date.now(),
        senderId: socket.userId,
        settings
      });
    }
  });

  // Управление мышью
  socket.on('mouse-event', (data) => {
    const { roomId, type, x, y, button } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room) {
      socket.to(roomId).emit('mouse-event', {
        userId: socket.userId,
        color: socket.color,
        type,
        x, y, button,
        timestamp: Date.now()
      });
    }
  });

  // Управление клавиатурой
  socket.on('keyboard-event', (data) => {
    const { roomId, type, key, code } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room) {
      socket.to(roomId).emit('keyboard-event', {
        userId: socket.userId,
        color: socket.color,
        type, key, code,
        timestamp: Date.now()
      });
    }
  });

  // Чат
  socket.on('chat-message', (data) => {
    const { roomId, message } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room) {
      const chatMsg = {
        id: uuidv4(),
        userId: socket.userId,
        color: socket.color,
        message: message.trim(),
        timestamp: Date.now()
      };
      
      room.chatHistory.push(chatMsg);
      if (room.chatHistory.length > 100) {
        room.chatHistory.shift();
      }
      
      io.to(roomId).emit('chat-message', chatMsg);
    }
  });

  // Настройки комнаты
  socket.on('room-settings', (data) => {
    const { roomId, settings } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.hostId === socket.userId) {
      room.settings = { ...room.settings, ...settings };
      io.to(roomId).emit('room-settings-updated', room.settings);
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    if (socket.roomId) {
      roomManager.leaveUser(socket.roomId, socket.userId);
      io.to(socket.roomId).emit('user-left', {
        userId: socket.userId
      });
    }
    users.delete(socket.userId);
    console.log(`🔴 [${socket.userId?.slice(0,4)}] Отключился`);
  });

  // Пинг активности
  socket.on('ping', () => {
    users.set(socket.userId, {
      ...users.get(socket.userId),
      lastActivity: Date.now()
    });
  });
});

// API роуты
app.get('/api/rooms', (req, res) => {
  const activeRooms = Array.from(roomManager.rooms.values())
    .filter(room => room.users.size > 0)
    .map(room => ({
      id: room.id,
      users: room.users.size,
      hostId: room.hostId?.slice(-4),
      screenActive: room.screenActive
    }));
  res.json(activeRooms);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: users.size, rooms: roomManager.rooms.size });
});

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ultimate ScreenShare запущен на порту ${PORT}`);
  console.log(`📱 Локально: http://localhost:${PORT}`);
  console.log(`🌐 Render: https://your-app.onrender.com`);
});
