"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastReactionUpdate = exports.broadcastNewComment = exports.broadcastTyping = exports.getOnlineUsersCount = exports.isUserOnline = exports.emitToMultiplePosts = exports.getConnectedUsers = exports.getRoomSize = exports.emitToAll = exports.emitToUser = exports.emitToPostRoom = exports.initializeSocket = exports.io = void 0;
// backend/src/sockets/socketHandler.ts
const socket_io_1 = require("socket.io");
const database_1 = require("../config/database");
const jsonwebtoken_1 = require("jsonwebtoken");
const mssql_1 = __importDefault(require("mssql"));
const initializeSocket = (server) => {
    exports.io = new socket_io_1.Server(server, {
        cors: {
            origin: process.env.FRONTEND_URL || 'http://localhost:4200',
            methods: ['GET', 'POST'],
            credentials: true
        },
        transports: ['websocket', 'polling']
    });
    // Authentication middleware for socket
    exports.io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        console.log('🔑 Socket auth token:', token ? 'Present' : 'Missing');
        if (!token) {
            console.log('❌ Socket authentication failed: No token provided');
            return next(new Error('Authentication required'));
        }
        try {
            const decoded = (0, jsonwebtoken_1.verify)(token, process.env.JWT_SECRET);
            console.log('✅ Socket token verified for user:', decoded.id || decoded.username);
            // Verify session in SQL Server
            const pool = await (0, database_1.getSQLServerPool)();
            const sessionResult = await pool.request()
                .input('token', mssql_1.default.NVarChar, token)
                .query('SELECT * FROM nt_sessions WHERE token = @token AND expires_at > GETDATE()');
            if (sessionResult.recordset.length === 0) {
                console.log('❌ Socket authentication failed: Session expired or not found');
                return next(new Error('Session expired'));
            }
            // Store user data in socket
            socket.data.user = {
                id: decoded.id || decoded.username,
                username: decoded.username,
                email: decoded.email,
                role: decoded.role || 'user'
            };
            console.log('✅ Socket authenticated for user:', socket.data.user.username);
            next();
        }
        catch (error) {
            console.error('❌ Socket authentication error:', error);
            next(new Error('Invalid token'));
        }
    });
    exports.io.on('connection', (socket) => {
        const userId = socket.data.user?.id;
        const username = socket.data.user?.username;
        if (!userId) {
            console.log('❌ Socket connection rejected: No user ID');
            socket.disconnect();
            return;
        }
        // Join user's personal room
        socket.join(`user_${userId}`);
        console.log(`🟢 User ${username} (${userId}) connected: ${socket.id}`);
        // Send connection success
        socket.emit('connected', {
            message: 'Connected to socket server',
            userId: userId,
            username: username
        });
        // Handle typing indicators
        socket.on('typing', (data) => {
            if (!data.postId)
                return;
            socket.to(`post_${data.postId}`).emit('user_typing', {
                userId,
                username,
                isTyping: data.isTyping
            });
        });
        // Handle post reactions
        socket.on('react_post', async (data) => {
            if (!data.postId)
                return;
            console.log(`❤️ User ${username} reacted to post ${data.postId} with ${data.type}`);
            // Broadcast reaction to post viewers
            exports.io.to(`post_${data.postId}`).emit('post_reaction', {
                userId,
                username,
                postId: data.postId,
                type: data.type,
                timestamp: new Date()
            });
            // Also emit to global feed
            exports.io.emit('post_reaction_global', {
                userId,
                username,
                postId: data.postId,
                type: data.type,
                timestamp: new Date()
            });
        });
        // Handle comment reactions
        socket.on('react_comment', async (data) => {
            if (!data.commentId)
                return;
            console.log(`💬 User ${username} reacted to comment ${data.commentId} with ${data.type}`);
            exports.io.to(`comment_${data.commentId}`).emit('comment_reaction', {
                userId,
                username,
                commentId: data.commentId,
                type: data.type,
                timestamp: new Date()
            });
        });
        // Handle new comment
        socket.on('new_comment', async (data) => {
            if (!data.postId || !data.comment)
                return;
            console.log(`💬 User ${username} commented on post ${data.postId}`);
            // Broadcast to post room
            exports.io.to(`post_${data.postId}`).emit('new_comment', {
                postId: data.postId,
                comment: data.comment,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
            // Also emit to global feed
            exports.io.emit('new_comment_global', {
                postId: data.postId,
                comment: data.comment,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });
        // Join post room for real-time updates
        socket.on('join_post', (postId) => {
            if (!postId)
                return;
            socket.join(`post_${postId}`);
            console.log(`📌 User ${username} (${userId}) joined post room: post_${postId}`);
            // Send current room info
            const room = exports.io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            console.log(`📊 Room post_${postId} has ${roomSize} users`);
            // Send room info back to client
            socket.emit('room_info', {
                postId: postId,
                roomSize: roomSize,
                users: room ? Array.from(room) : []
            });
        });
        // Leave post room
        socket.on('leave_post', (postId) => {
            if (!postId)
                return;
            socket.leave(`post_${postId}`);
            console.log(`📌 User ${username} (${userId}) left post room: post_${postId}`);
        });
        // Handle join user room
        socket.on('join_user', (targetUserId) => {
            if (!targetUserId)
                return;
            socket.join(`user_${targetUserId}`);
            console.log(`👤 User ${username} (${userId}) joined user room: user_${targetUserId}`);
        });
        // Handle leave user room
        socket.on('leave_user', (targetUserId) => {
            if (!targetUserId)
                return;
            socket.leave(`user_${targetUserId}`);
            console.log(`👤 User ${username} (${userId}) left user room: user_${targetUserId}`);
        });
        // Handle new post notification
        socket.on('new_post', async (data) => {
            if (!data.post)
                return;
            console.log(`📰 User ${username} created a new post: ${data.post.id}`);
            // Broadcast to all users
            exports.io.emit('new_post_global', {
                post: data.post,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });
        // Handle post update
        socket.on('update_post', async (data) => {
            if (!data.postId || !data.updates)
                return;
            console.log(`📝 User ${username} updated post: ${data.postId}`);
            // Broadcast to post room
            exports.io.to(`post_${data.postId}`).emit('post_updated', {
                postId: data.postId,
                updates: data.updates,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });
        // Handle delete post
        socket.on('delete_post', async (data) => {
            if (!data.postId)
                return;
            console.log(`🗑️ User ${username} deleted post: ${data.postId}`);
            // Broadcast to post room
            exports.io.to(`post_${data.postId}`).emit('post_deleted', {
                postId: data.postId,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
            // Also emit globally
            exports.io.emit('post_deleted_global', {
                postId: data.postId,
                userId: userId,
                username: username,
                timestamp: new Date()
            });
        });
        // Handle notification read
        socket.on('notification_read', async (data) => {
            if (!data.notificationId)
                return;
            console.log(`🔔 User ${username} read notification: ${data.notificationId}`);
            // Update notification in database
            try {
                const pool = await (0, database_1.getSQLServerPool)();
                await pool.request()
                    .input('notificationId', mssql_1.default.Int, data.notificationId)
                    .input('userId', mssql_1.default.Int, userId)
                    .query(`
                        UPDATE nt_notifications 
                        SET is_read = 1 
                        WHERE id = @notificationId AND cuserid = @userId
                    `);
                // Emit to user room
                exports.io.to(`user_${userId}`).emit('notification_updated', {
                    notificationId: data.notificationId,
                    isRead: true
                });
            }
            catch (error) {
                console.error('Error marking notification as read:', error);
            }
        });
        // Handle get room size
        socket.on('get_room_size', (postId) => {
            if (!postId)
                return;
            const room = exports.io.sockets.adapter.rooms.get(`post_${postId}`);
            const roomSize = room ? room.size : 0;
            socket.emit('room_size', {
                postId: postId,
                roomSize: roomSize
            });
        });
        // Handle disconnect
        socket.on('disconnect', () => {
            console.log(`🔴 User ${username} (${userId}) disconnected: ${socket.id}`);
        });
        // Handle error
        socket.on('error', (error) => {
            console.error(`❌ Socket error for user ${username} (${userId}):`, error);
        });
    });
    return exports.io;
};
exports.initializeSocket = initializeSocket;
// Helper function to emit to post room
const emitToPostRoom = (postId, event, data) => {
    if (exports.io) {
        // Emit to post room
        exports.io.to(`post_${postId}`).emit(event, data);
        console.log(`📤 Emitted ${event} for post ${postId} to room`);
    }
};
exports.emitToPostRoom = emitToPostRoom;
// Helper function to emit to user room
const emitToUser = (userId, event, data) => {
    if (exports.io) {
        exports.io.to(`user_${userId}`).emit(event, data);
        console.log(`📤 Emitted ${event} to user ${userId}`);
    }
};
exports.emitToUser = emitToUser;
// Helper function to emit to all users
const emitToAll = (event, data) => {
    if (exports.io) {
        exports.io.emit(event, data);
        console.log(`📤 Emitted ${event} to all users`);
    }
};
exports.emitToAll = emitToAll;
// Helper to get room size
const getRoomSize = (roomName) => {
    if (!exports.io)
        return 0;
    const room = exports.io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
};
exports.getRoomSize = getRoomSize;
// Helper to get all connected users
const getConnectedUsers = () => {
    if (!exports.io)
        return [];
    const users = [];
    const rooms = exports.io.sockets.adapter.rooms;
    for (const [roomName, room] of rooms) {
        if (roomName.startsWith('user_')) {
            const userId = roomName.replace('user_', '');
            users.push(userId);
        }
    }
    return users;
};
exports.getConnectedUsers = getConnectedUsers;
// Helper to emit to multiple post rooms
const emitToMultiplePosts = (postIds, event, data) => {
    if (exports.io) {
        postIds.forEach(postId => {
            exports.io.to(`post_${postId}`).emit(event, data);
        });
        console.log(`📤 Emitted ${event} to ${postIds.length} post rooms`);
    }
};
exports.emitToMultiplePosts = emitToMultiplePosts;
// Helper to check if user is online
const isUserOnline = (userId) => {
    if (!exports.io)
        return false;
    const room = exports.io.sockets.adapter.rooms.get(`user_${userId}`);
    return room ? room.size > 0 : false;
};
exports.isUserOnline = isUserOnline;
// Helper to get online users count
const getOnlineUsersCount = () => {
    if (!exports.io)
        return 0;
    let count = 0;
    const rooms = exports.io.sockets.adapter.rooms;
    for (const [roomName, room] of rooms) {
        if (roomName.startsWith('user_')) {
            count += room.size;
        }
    }
    return count;
};
exports.getOnlineUsersCount = getOnlineUsersCount;
// Helper to broadcast typing status
const broadcastTyping = (postId, userId, username, isTyping) => {
    if (exports.io) {
        exports.io.to(`post_${postId}`).emit('user_typing', {
            userId,
            username,
            isTyping,
            timestamp: new Date()
        });
    }
};
exports.broadcastTyping = broadcastTyping;
// Helper to broadcast new comment
const broadcastNewComment = (postId, comment, userId, username) => {
    if (exports.io) {
        const data = {
            postId,
            comment,
            userId,
            username,
            timestamp: new Date()
        };
        exports.io.to(`post_${postId}`).emit('new_comment', data);
        exports.io.emit('new_comment_global', data);
    }
};
exports.broadcastNewComment = broadcastNewComment;
// Helper to broadcast reaction update
const broadcastReactionUpdate = (postId, userId, username, type) => {
    if (exports.io) {
        const data = {
            postId,
            userId,
            username,
            type,
            timestamp: new Date()
        };
        exports.io.to(`post_${postId}`).emit('reaction_updated', data);
        exports.io.emit('reaction_updated_global', data);
    }
};
exports.broadcastReactionUpdate = broadcastReactionUpdate;
//# sourceMappingURL=socketHandler.js.map