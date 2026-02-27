const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises;
const winston = require('winston');

// Инициализация
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 100e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Логирование
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Безопасность и middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:"]
    }
  }
}));

app.use(compression());
app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname), { maxAge: '1h' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Слишком много запросов с вашего IP' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много попыток входа' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// Сессии
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-super-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// JWT секрет
const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

// Хранилища
const rooms = new Map();
const users = new Map();
const bannedIPs = new Set();
const userColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#F8C471', '#74B9FF', '#00B894', '#E17055', '#FD79A8', '#6C5CE7'];
const qualityPresets = {
  low: 0.3,
  medium: 0.6,
  high: 0.85,
  ultra: 1.0
};

// База данных пользователей (в памяти для демо)
const userDatabase = new Map();

// RoomManager класс
class AdvancedRoomManager {
  constructor() {
    this.rooms = new Map();
    this.maxRooms = 100;
    this.cleanupInterval = null;
  }

  async createRoom(roomId, hostId, hostData) {
    if (this.rooms.size >= this.maxRooms) {
      throw new Error('Сервер переполнен');
    }

    const room = {
      id: roomId,
      hostId,
      hostData,
      users: new Set([hostId]),
      viewers: new Set(),
      moderators: new Set(),
      screenActive: false,
      settings: {
        quality: 'medium',
        framerate: 30,
        cursorVisible: true,
        audioEnabled: false,
        zoomLevel: 1.0,
        mouseControl: true,
        keyboardControl: false,
        whiteboardEnabled: false,
        fileSharing: true,
        maxUsers: 20
      },
      chatHistory: [],
      files: [],
      whiteboardData: null,
      createdAt: Date.now(),
      lastFrameTime: 0,
      activityTimeout: Date.now() + 30 * 60 * 1000,
      permissions: {
        canControl: new Set([hostId]),
        canDraw: new Set([hostId]),
        canUpload: new Set([hostId])
      }
    };

    this.rooms.set(roomId, room);
    this.scheduleCleanup();
    logger.info(`Комната создана: ${roomId} хост: ${hostId}`);
    return room;
  }

  joinUser(roomId, userId, role = 'viewer', userData = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    if (room.users.size >= room.settings.maxUsers) return false;

    room.users.add(userId);
    room.viewers.add(userId);
    
    if (role === 'moderator') room.moderators.add(userId);
    if (role === 'host') room.hostId = userId;

    room[userData.username] = userData;
    room.activityTimeout = Date.now() + 30 * 60 * 1000;
    
    return room;
  }

  leaveUser(roomId, userId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.users.delete(userId);
    room.viewers.delete(userId);
    room.moderators.delete(userId);
    room.permissions.canControl.delete(userId);
    room.permissions.canDraw.delete(userId);
    room.permissions.canUpload.delete(userId);

    if (room.hostId === userId) {
      room.screenActive = false;
      // Назначить нового хоста если есть пользователи
      if (room.users.size > 0) {
        const newHost = Array.from(room.users)[0];
        room.hostId = newHost;
        io.to(roomId).emit('host-changed', { newHost });
      }
    }

    if (room.users.size === 0) {
      setTimeout(() => {
        if (this.rooms.get(roomId)?.users.size === 0) {
          this.rooms.delete(roomId);
          logger.info(`Комната удалена: ${roomId}`);
        }
      }, 5000);
    }
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getActiveRooms() {
    return Array.from(this.rooms.values())
      .filter(room => room.users.size > 0 && (Date.now() - room.activityTimeout < 0))
      .map(room => ({
        id: room.id,
        users: room.users.size,
        hostId: room.hostId?.slice(-4),
        screenActive: room.screenActive,
        maxUsers: room.settings.maxUsers,
        createdAt: room.createdAt
      }));
  }

  scheduleCleanup() {
    if (this.cleanupInterval) return;
    
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [roomId, room] of this.rooms) {
        if (room.users.size === 0 || now - room.activityTimeout > 30 * 60 * 1000) {
          this.rooms.delete(roomId);
        }
      }
    }, 5 * 60 * 1000);
  }
}

const roomManager = new AdvancedRoomManager();

// Middleware для Socket.IO с JWT
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers['x-access-token'];
    
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userData = decoded;
    } else {
      socket.userId = uuidv4().slice(0, 8);
      socket.color = userColors[Math.floor(Math.random() * userColors.length)];
      socket.isGuest = true;
    }

    if (!socket.userId) {
      socket.userId = socket.userData?.id || uuidv4().slice(0, 8);
    }

    if (!socket.color) {
      socket.color = userColors[Math.floor(Math.random() * userColors.length)];
    }

    users.set(socket.userId, {
      id: socket.userId,
      color: socket.color,
      username: socket.userData?.username || `Гость${socket.userId.slice(-4)}`,
      role: socket.userData?.role || 'guest',
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isOnline: true
    });

    next();
  } catch (error) {
    logger.error('Socket auth error:', error);
    next(new Error('Ошибка аутентификации'));
  }
});

// Socket.IO события
io.on('connection', (socket) => {
  logger.info(`🟢 [${socket.userId.slice(0,4)}] Подключился (${users.size} онлайн)`);

  // Главное меню - список комнат
  socket.on('get-rooms', () => {
    socket.emit('rooms-list', roomManager.getActiveRooms());
  });

  // Регистрация хоста
  socket.on('register-host', async (data) => {
    try {
      const { roomId, password } = data;
      
      if (!roomId || roomId.length < 3) {
        socket.emit('error', { message: 'ID комнаты слишком короткий (минимум 3 символа)' });
        return;
      }

      const existingRoom = roomManager.getRoom(roomId);
      if (existingRoom) {
        socket.emit('error', { message: 'Комната с таким ID уже существует' });
        return;
      }

      const room = await roomManager.createRoom(roomId, socket.userId, {
        username: users.get(socket.userId).username,
        color: socket.color
      });

      socket.join(roomId);
      socket.isHost = true;
      socket.roomId = roomId;
      socket.roomPassword = password;

      socket.emit('host-confirmed', { room, isHost: true });
      
      io.to(roomId).emit('system-message', {
        type: 'host-registered',
        message: `${users.get(socket.userId).username} создал комнату`,
        timestamp: Date.now()
      });

      logger.info(`🖥️ [${socket.userId.slice(-4)}] Хост ${roomId}`);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Присоединение к комнате
  socket.on('join-room', async (data) => {
    try {
      const { roomId, password } = data;
      const room = roomManager.getRoom(roomId);
      
      if (!room) {
        socket.emit('error', { message: 'Комната не найдена' });
        return;
      }

      // Проверка пароля
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Неверный пароль комнаты' });
        return;
      }

      socket.join(roomId);
      socket.roomId = roomId;
      
      roomManager.joinUser(roomId, socket.userId, 'viewer', {
        username: users.get(socket.userId).username,
        color: socket.color
      });

      socket.emit('room-joined', { 
        room,
        userColor: socket.color,
        userData: users.get(socket.userId)
      });

      // Уведомить всех
      socket.to(roomId).emit('user-joined', {
        userId: socket.userId,
        username: users.get(socket.userId).username,
        color: socket.color,
        role: users.get(socket.userId).role
      });

      logger.info(`👁️ [${socket.userId.slice(-4)}] -> ${roomId}`);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Продвинутые события
  socket.on('screen-frame', (data) => {
    const { roomId, imageData, settings } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && (room.hostId === socket.userId || room.permissions.canControl.has(socket.userId))) {
      room.screenActive = true;
      room.lastFrameTime = Date.now();
      room.settings = { ...room.settings, ...settings };
      
      socket.to(roomId).emit('screen-frame', {
        imageData,
        timestamp: Date.now(),
        senderId: socket.userId,
        settings
      });
    }
  });

  socket.on('mouse-event', (data) => {
    const { roomId, type, x, y, button } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.permissions.canControl.has(socket.userId)) {
      socket.to(roomId).emit('mouse-event', {
        userId: socket.userId,
        color: socket.color,
        type, x, y, button,
        timestamp: Date.now()
      });
    }
  });

  socket.on('keyboard-event', (data) => {
    const { roomId, type, key, code } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.permissions.canControl.has(socket.userId)) {
      socket.to(roomId).emit('keyboard-event', {
        userId: socket.userId,
        color: socket.color,
        type, key, code,
        timestamp: Date.now()
      });
    }
  });

  // Чат с модерацией
  socket.on('chat-message', (data) => {
    const { roomId, message } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && message.trim().length > 0 && message.trim().length <= 1000) {
      const chatMsg = {
        id: uuidv4(),
        userId: socket.userId,
        username: users.get(socket.userId).username,
        color: socket.color,
        role: users.get(socket.userId).role,
        message: message.trim(),
        timestamp: Date.now()
      };
      
      room.chatHistory.push(chatMsg);
      if (room.chatHistory.length > 200) {
        room.chatHistory.shift();
      }
      
      io.to(roomId).emit('chat-message', chatMsg);
    }
  });

  // Настройки комнаты
  socket.on('update-room-settings', (data) => {
    const { roomId, settings } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && (room.hostId === socket.userId || room.moderators.has(socket.userId))) {
      room.settings = { ...room.settings, ...settings };
      io.to(roomId).emit('room-settings-updated', room.settings);
    }
  });

  // Управление правами
  socket.on('set-permissions', (data) => {
    const { roomId, userId, permission, value } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && (room.hostId === socket.userId || room.moderators.has(socket.userId))) {
      if (value) {
        room.permissions[permission].add(userId);
      } else {
        room.permissions[permission].delete(userId);
      }
      io.to(roomId).emit('permissions-updated', { userId, permission, value });
    }
  });

  // Доска
  socket.on('whiteboard-draw', (data) => {
    const { roomId, drawData } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.permissions.canDraw.has(socket.userId)) {
      socket.to(roomId).emit('whiteboard-draw', {
        userId: socket.userId,
        color: socket.color,
        drawData
      });
    }
  });

  // Загрузка файлов
  socket.on('upload-file', async (data) => {
    const { roomId, filename, fileData } = data;
    const room = roomManager.getRoom(roomId);
    
    if (room && room.permissions.canUpload.has(socket.userId)) {
      const fileId = uuidv4();
      room.files.push({
        id: fileId,
        filename,
        userId: socket.userId,
        size: fileData.length,
        uploadedAt: Date.now()
      });
      
      try {
        await fs.writeFile(`uploads/${fileId}`, fileData, 'base64');
        io.to(roomId).emit('file-uploaded', {
          id: fileId,
          filename,
          userId: socket.userId,
          size: fileData.length
        });
      } catch (error) {
        logger.error('File upload error:', error);
      }
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    if (socket.roomId) {
      roomManager.leaveUser(socket.roomId, socket.userId);
      io.to(socket.roomId).emit('user-left', {
        userId: socket.userId,
        username: users.get(socket.userId)?.username
      });
    }
    if (users.has(socket.userId)) {
      users.get(socket.userId).isOnline = false;
    }
    logger.info(`🔴 [${socket.userId?.slice(0,4)}] Отключился`);
  });

  // Пинг
  socket.on('ping', () => {
    if (users.has(socket.userId)) {
      users.set(socket.userId, {
        ...users.get(socket.userId),
        lastActivity: Date.now()
      });
    }
  });
});

// API роуты - Аутентификация
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (userDatabase.has(username)) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const userId = uuidv4().slice(0, 8);
    
    userDatabase.set(username, {
      id: userId,
      username,
      email,
      password: hashedPassword,
      role: 'user',
      createdAt: Date.now(),
      avatar: null
    });

    const token = jwt.sign({ id: userId, username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: userId, username, role: 'user' } });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = userDatabase.get(username);
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Неверные данные' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/auth/guest', (req, res) => {
  const guestId = uuidv4().slice(0, 8);
  const token = jwt.sign({ 
    id: guestId, 
    username: `Гость${guestId.slice(-4)}`, 
    role: 'guest' 
  }, JWT_SECRET, { expiresIn: '24h' });
  
  res.json({ token, user: { id: guestId, username: `Гость${guestId.slice(-4)}`, role: 'guest' } });
});

// API комнаты
app.get('/api/rooms', (req, res) => {
  res.json(roomManager.getActiveRooms());
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomManager.getRoom(req.params.roomId);
  if (room) {
    res.json({
      id: room.id,
      users: room.users.size,
      screenActive: room.screenActive,
      maxUsers: room.settings.maxUsers
    });
  } else {
    res.status(404).json({ error: 'Комната не найдена' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    users: users.size, 
    rooms: roomManager.rooms.size,
    uptime: process.uptime()
  });
});

// Создание папки uploads
const mkdirp = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
};
mkdirp('uploads');

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ultimate ScreenShare PRO v3.5 запущен на порту ${PORT}`);
  console.log(`📱 Локально: http://localhost:${PORT}`);
  console.log(`🌐 Публично: http://localhost:${PORT}`);
  console.log(`📊 Онлайн: ${users.size} | Комнаты: ${roomManager.rooms.size}`);
});
