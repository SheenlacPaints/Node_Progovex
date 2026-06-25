// backend/src/server.ts
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';  // Add this import
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';

// Import configurations
import { mysqlPool, connectMongoDB } from './config/database';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';

// Import routes
import authRoutes from './routes/authRoutes';
import postRoutes from './routes/postRoutes';
import emailRoutes from './routes/emailRoutes';
import userRoutes from './routes/userRoutes';
import adminRoutes from './routes/adminRoutes';

const app = express();
const server = http.createServer(app);

// ==============================================
// SOCKET.IO SETUP
// ==============================================
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:4200', 'http://localhost:3000', 'http://127.0.0.1:4200'],
        credentials: true,
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

// Make io accessible to routes
app.set('io', io);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    // Get token from handshake
    const token = socket.handshake.auth.token;
    console.log('🔑 Token received:', token ? 'Yes' : 'No');

    // Join user-specific room
    socket.on('join_user', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`👤 User ${userId} joined their room`);
    });

    // Join post room for real-time updates
    socket.on('join_post', (postId) => {
        socket.join(`post_${postId}`);
        // console.log(`📝 Socket ${socket.id} joined post ${postId}`);
    });

    socket.on('check_room', (data) => {
        console.log(`🔍 Checking rooms for socket:`, Array.from(socket.rooms));
        socket.emit('room_list', { rooms: Array.from(socket.rooms) });
    });

    socket.on('leave_post', (postId) => {
        socket.leave(`post_${postId}`);
        // console.log(`📝 Socket ${socket.id} left post ${postId}`);
    });

    // Handle typing indicators
    socket.on('typing', (data) => {
        socket.to(`post_${data.postId}`).emit('user_typing', {
            userId: socket.data.userId,
            isTyping: data.isTyping
        });
    });

    // Handle new comment (broadcast to post room)
    socket.on('new_comment', (data) => {
        io.to(`post_${data.postId}`).emit('new_comment', data);
        console.log('📝 New comment event emitted to post:', data.postId);
    });

    // Handle reaction updates
    socket.on('react_post', (data) => {
        io.to(`post_${data.postId}`).emit('reaction_updated', data);
        console.log('❤️ Reaction update emitted to post:', data.postId);
    });

    // Handle new post created
    socket.on('post_created', (data) => {
        io.emit('post_created', data);
        console.log('📰 New post created event emitted');
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// Log environment variables (for debugging - remove in production)
console.log('Environment variables loaded:');
console.log('MYSQL_HOST:', process.env.MYSQL_HOST);
console.log('MYSQL_USER:', process.env.MYSQL_USER);
console.log('MYSQL_PASSWORD:', process.env.MYSQL_PASSWORD ? '***SET***' : 'NOT SET');
console.log('MYSQL_DATABASE:', process.env.MYSQL_DATABASE);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
    origin: ['http://localhost:4200', 'http://localhost:3000', 'http://127.0.0.1:4200'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Authorization', 'Content-Length', 'X-Requested-With']
}));

// Handle preflight requests for all routes
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Rate limiting
app.use('/api', apiLimiter);

// Serve uploaded files statically
app.use('/uploads', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:4200');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
}, express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

// Also serve from root uploads folder
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/health', async (req, res) => {
    try {
        await mysqlPool.query('SELECT 1');
        res.json({ status: 'healthy', database: 'connected', timestamp: new Date() });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', database: 'disconnected', error: String(error) });
    }
});

// Socket.IO health check endpoint
app.get('/socket-health', (req, res) => {
    res.json({
        status: 'ok',
        connections: io.engine.clientsCount,
        message: 'Socket.IO server is running'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Social Platform API',
        version: '1.0.0',
        socket: 'Socket.IO enabled',
        endpoints: {
            auth: '/api/auth',
            posts: '/api/posts',
            users: '/api/users',
            admin: '/api/admin',
            socket: '/socket.io'
        }
    });
});

// Error handling
app.use(errorHandler);

// Connect to databases (MongoDB is optional)
connectMongoDB().catch(console.error);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 API URL: http://localhost:${PORT}/api`);
    console.log(`🔌 Socket.IO server ready on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

export { app, server, io };