"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRoomSize = exports.emitToPostRoom = exports.initializeSocket = exports.io = void 0;
// backend/src/sockets/socketHandler.ts
const socket_io_1 = require("socket.io");
const database_1 = require("../config/database");
const jsonwebtoken_1 = require("jsonwebtoken");
const initializeSocket = (server) => {
    exports.io = new socket_io_1.Server(server, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:4200',
            methods: ['GET', 'POST']
        }
    });
    // Authentication middleware for socket
    exports.io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        console.log('🔑 Socket auth token:', token);
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const decoded = (0, jsonwebtoken_1.verify)(token, process.env.JWT_SECRET);
            // Verify session
            const [sessions] = await database_1.mysqlPool.execute('SELECT * FROM nt_sessions WHERE token = ? AND expires_at > NOW()', [token]);
            if (sessions.length === 0) {
                return next(new Error('Session expired'));
            }
            socket.data.user = decoded;
            next();
        }
        catch (error) {
            next(new Error('Invalid token'));
        }
    });
    exports.io.on('connection', (socket) => {
        const userId = socket.data.user.id;
        // Join user's personal room
        socket.join(`user_${userId}`);
        console.log(`🟢 User ${userId} connected: ${socket.id}`);
        // Handle typing indicators
        socket.on('typing', (data) => {
            socket.to(`post_${data.postId}`).emit('user_typing', {
                userId,
                isTyping: data.isTyping
            });
        });
        // Handle post reactions
        socket.on('react_post', async (data) => {
            // Broadcast reaction to post viewers
            exports.io.to(`post_${data.postId}`).emit('post_reaction', {
                userId,
                type: data.type
            });
        });
        // Handle comment reactions
        socket.on('react_comment', async (data) => {
            exports.io.to(`comment_${data.commentId}`).emit('comment_reaction', {
                userId,
                type: data.type
            });
        });
        // Join post room for real-time updates
        socket.on('join_post', (postId) => {
            socket.join(`post_${postId}`);
            console.log(`📌 User ${userId} joined post room: post_${postId}`);
            // Send current room info
            const room = exports.io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            console.log(`📊 Room post_${postId} has ${roomSize} users`);
        });
        socket.on('leave_post', (postId) => {
            socket.leave(`post_${postId}`);
            console.log(`📌 User ${userId} left post room: post_${postId}`);
        });
        socket.on('disconnect', () => {
            console.log(`🔴 User ${userId} disconnected: ${socket.id}`);
        });
    });
    return exports.io;
};
exports.initializeSocket = initializeSocket;
// Helper function to emit to post room and all users
const emitToPostRoom = (postId, event, data) => {
    if (exports.io) {
        // Emit to post room
        exports.io.to(`post_${postId}`).emit(event, data);
        // Also emit to global feed for users who are not in the post room
        exports.io.emit(`${event}_global`, data);
        console.log(`📤 Emitted ${event} for post ${postId} to room and global`);
    }
};
exports.emitToPostRoom = emitToPostRoom;
// Helper to get room size
const getRoomSize = (roomName) => {
    if (!exports.io)
        return 0;
    const room = exports.io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
};
exports.getRoomSize = getRoomSize;
//# sourceMappingURL=socketHandler.js.map