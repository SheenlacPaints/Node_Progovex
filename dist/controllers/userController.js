"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivateAccount = exports.changePassword = exports.getActivityLog = exports.getUserStats = exports.deleteNotification = exports.markAllNotificationsRead = exports.markAllAsRead = exports.markNotificationRead = exports.getNotifications = exports.searchUsers = exports.getUserPosts = exports.getFollowing = exports.getFollowers = exports.unfollowUser = exports.followUser = exports.updateAvatar = exports.updateUserProfile = exports.getUserProfile = void 0;
const database_1 = require("../config/database");
const errorHandler_1 = require("../middleware/errorHandler");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const mssql_1 = __importDefault(require("mssql"));
const getUserProfile = async (req, res) => {
    try {
        const { username } = req.params;
        const currentUserId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        let query = '';
        let request = pool.request();
        if (username) {
            query = 'SELECT id, username, full_name, avatar_url, bio, created_at FROM users WHERE username = @username';
            request.input('username', mssql_1.default.NVarChar, username);
        }
        else {
            query = 'SELECT id, username, full_name, avatar_url, bio, created_at FROM users WHERE id = @userId';
            request.input('userId', mssql_1.default.Int, currentUserId);
        }
        const result = await request.query(query);
        const user = result.recordset[0];
        if (!user) {
            throw new errorHandler_1.AppError('User not found', 404);
        }
        // Get follower counts
        const [followersResult, followingResult, isFollowingResult] = await Promise.all([
            pool.request()
                .input('userId', mssql_1.default.Int, user.id)
                .query('SELECT COUNT(*) as count FROM nt_follows WHERE following_id = @userId'),
            pool.request()
                .input('userId', mssql_1.default.Int, user.id)
                .query('SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = @userId'),
            pool.request()
                .input('followerId', mssql_1.default.Int, currentUserId)
                .input('followingId', mssql_1.default.Int, user.id)
                .query('SELECT id FROM nt_follows WHERE follower_id = @followerId AND following_id = @followingId')
        ]);
        res.json({
            success: true,
            user: {
                ...user,
                followers_count: followersResult.recordset[0]?.count || 0,
                following_count: followingResult.recordset[0]?.count || 0,
                is_following: isFollowingResult.recordset.length > 0
            }
        });
    }
    catch (error) {
        console.error('Error getting user profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get user profile',
            error: error.message
        });
    }
};
exports.getUserProfile = getUserProfile;
const updateUserProfile = async (req, res) => {
    try {
        const { fullName, bio } = req.body;
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        await pool.request()
            .input('fullName', mssql_1.default.NVarChar, fullName)
            .input('bio', mssql_1.default.NVarChar, bio)
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE users SET full_name = @fullName, bio = @bio WHERE id = @userId');
        await database_1.ActivityLog.create({
            userId: userId.toString(),
            action: 'update_profile',
            entityType: 'user',
            details: { fullName, bio },
            ipAddress: req.ip
        });
        res.json({ success: true, message: 'Profile updated successfully' });
    }
    catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
};
exports.updateUserProfile = updateUserProfile;
const updateAvatar = async (req, res) => {
    // if (!req.file) {
    //     throw new AppError('No file uploaded', 400);
    // }
    // const avatarUrl = await processImage(req.file.buffer, req.file.originalname);
    // const userId = req.user!.id;
    // await mysqlPool.execute(
    //     'UPDATE users SET avatar_url = ? WHERE id = ?',
    //     [avatarUrl, userId]
    // );
    // res.json({ success: true, avatarUrl });
    res.json({ success: true, message: 'Avatar update coming soon' });
};
exports.updateAvatar = updateAvatar;
const followUser = async (req, res) => {
    try {
        const followerId = req.user.id;
        const followingId = parseInt(req.params.userId);
        const pool = await (0, database_1.getSQLServerPool)();
        if (followerId === followingId) {
            throw new errorHandler_1.AppError('Cannot follow yourself', 400);
        }
        // Check if user exists
        const userResult = await pool.request()
            .input('userId', mssql_1.default.Int, followingId)
            .query('SELECT id FROM users WHERE id = @userId');
        if (userResult.recordset.length === 0) {
            throw new errorHandler_1.AppError('User not found', 404);
        }
        // Check if already following
        const checkResult = await pool.request()
            .input('followerId', mssql_1.default.Int, followerId)
            .input('followingId', mssql_1.default.Int, followingId)
            .query('SELECT id FROM nt_follows WHERE follower_id = @followerId AND following_id = @followingId');
        if (checkResult.recordset.length > 0) {
            throw new errorHandler_1.AppError('Already following this user', 400);
        }
        await pool.request()
            .input('followerId', mssql_1.default.Int, followerId)
            .input('followingId', mssql_1.default.Int, followingId)
            .query('INSERT INTO nt_follows (follower_id, following_id) VALUES (@followerId, @followingId)');
        // Create notification
        await pool.request()
            .input('followingId', mssql_1.default.Int, followingId)
            .input('followerId', mssql_1.default.Int, followerId)
            .input('content', mssql_1.default.NVarChar, `${req.user.username} started following you`)
            .query(`
                INSERT INTO nt_notifications (cuserid, type, reference_id, content) 
                VALUES (@followingId, 'follow', @followerId, @content)
            `);
        await database_1.ActivityLog.create({
            userId: followerId.toString(),
            action: 'follow',
            entityType: 'user',
            entityId: followingId.toString(),
            ipAddress: req.ip
        });
        res.json({ success: true, message: 'User followed' });
    }
    catch (error) {
        console.error('Error following user:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to follow user',
            error: error.message
        });
    }
};
exports.followUser = followUser;
const unfollowUser = async (req, res) => {
    try {
        const followerId = req.user.id;
        const followingId = parseInt(req.params.userId);
        const pool = await (0, database_1.getSQLServerPool)();
        await pool.request()
            .input('followerId', mssql_1.default.Int, followerId)
            .input('followingId', mssql_1.default.Int, followingId)
            .query('DELETE FROM nt_follows WHERE follower_id = @followerId AND following_id = @followingId');
        res.json({ success: true, message: 'User unfollowed' });
    }
    catch (error) {
        console.error('Error unfollowing user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unfollow user',
            error: error.message
        });
    }
};
exports.unfollowUser = unfollowUser;
const getFollowers = async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const { page = 1, limit = 20 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('limit', mssql_1.default.Int, Number(limit))
            .input('offset', mssql_1.default.Int, offset)
            .query(`
                SELECT u.id, u.username, u.full_name, u.avatar_url 
                FROM nt_follows f 
                JOIN users u ON f.follower_id = u.id 
                WHERE f.following_id = @userId 
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json({ success: true, followers: result.recordset, page, limit });
    }
    catch (error) {
        console.error('Error getting followers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get followers',
            error: error.message
        });
    }
};
exports.getFollowers = getFollowers;
const getFollowing = async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const { page = 1, limit = 20 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('limit', mssql_1.default.Int, Number(limit))
            .input('offset', mssql_1.default.Int, offset)
            .query(`
                SELECT u.id, u.username, u.full_name, u.avatar_url 
                FROM nt_follows f 
                JOIN users u ON f.following_id = u.id 
                WHERE f.follower_id = @userId 
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json({ success: true, following: result.recordset, page, limit });
    }
    catch (error) {
        console.error('Error getting following:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get following',
            error: error.message
        });
    }
};
exports.getFollowing = getFollowing;
const getUserPosts = async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const { page = 1, limit = 20 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('limit', mssql_1.default.Int, Number(limit))
            .input('offset', mssql_1.default.Int, offset)
            .query(`
                SELECT p.*, 
                    (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id) as likes_count,
                    (SELECT COUNT(*) FROM nt_comments WHERE post_id = p.id) as comments_count
                FROM nt_posts p
                WHERE p.cuserid = @userId AND p.status = 'approved'
                ORDER BY p.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json({ success: true, posts: result.recordset, page, limit });
    }
    catch (error) {
        console.error('Error getting user posts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get user posts',
            error: error.message
        });
    }
};
exports.getUserPosts = getUserPosts;
const searchUsers = async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        const pool = await (0, database_1.getSQLServerPool)();
        if (!q) {
            throw new errorHandler_1.AppError('Search query required', 400);
        }
        const result = await pool.request()
            .input('query', mssql_1.default.NVarChar, `%${q}%`)
            .input('limit', mssql_1.default.Int, Number(limit))
            .query(`
                SELECT id, username, full_name, avatar_url 
                FROM users 
                WHERE username LIKE @query OR full_name LIKE @query
                ORDER BY username
                OFFSET 0 ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json({ success: true, users: result.recordset });
    }
    catch (error) {
        console.error('Error searching users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search users',
            error: error.message
        });
    }
};
exports.searchUsers = searchUsers;
const getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const pool = await (0, database_1.getSQLServerPool)();
        console.log('📥 Fetching notifications for user:', userId);
        console.log('📊 Page:', page, 'Limit:', limit, 'Offset:', offset);
        // Get notifications
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .input('limit', mssql_1.default.Int, limit)
            .input('offset', mssql_1.default.Int, offset)
            .query(`
                SELECT 
                    id, 
                    cuserid, 
                    from_user_id, 
                    type, 
                    reference_id, 
                    reference_type, 
                    content, 
                    is_read, 
                    created_at
                FROM nt_notifications 
                WHERE cuserid = @userId
                ORDER BY created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        // Get unread count
        const unreadResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('SELECT COUNT(*) as count FROM nt_notifications WHERE cuserid = @userId AND is_read = 0');
        const unreadCount = unreadResult.recordset[0]?.count || 0;
        console.log('📊 Notifications found:', result.recordset.length);
        console.log('📊 Unread count:', unreadCount);
        // Format notifications
        const formattedNotifications = [];
        for (const notif of result.recordset) {
            let fromUser = null;
            if (notif.from_user_id) {
                const userResult = await pool.request()
                    .input('userId', mssql_1.default.Int, notif.from_user_id)
                    .query('SELECT username, full_name, avatar_url FROM users WHERE id = @userId');
                const userData = userResult.recordset[0];
                if (userData) {
                    fromUser = {
                        username: userData.username,
                        fullName: userData.full_name,
                        avatarUrl: userData.avatar_url
                    };
                }
            }
            formattedNotifications.push({
                id: notif.id,
                userId: notif.cuserid,
                fromUserId: notif.from_user_id,
                type: notif.type,
                referenceId: notif.reference_id,
                referenceType: notif.reference_type || 'post',
                content: notif.content || getDefaultNotificationContent(notif.type, fromUser),
                isRead: notif.is_read === 1,
                createdAt: notif.created_at,
                fromUser: fromUser
            });
        }
        res.json({
            success: true,
            notifications: formattedNotifications,
            unreadCount: unreadCount,
            page,
            limit
        });
    }
    catch (error) {
        console.error('Error in getNotifications:', error);
        res.json({
            success: true,
            notifications: [],
            unreadCount: 0,
            page: 1,
            limit: 20
        });
    }
};
exports.getNotifications = getNotifications;
// Helper function
function getDefaultNotificationContent(type, fromUser) {
    const username = fromUser?.username || 'Someone';
    switch (type) {
        case 'like': return `${username} liked your post`;
        case 'comment': return `${username} commented on your post`;
        case 'follow': return `${username} started following you`;
        case 'approval': return 'Your post has been approved';
        case 'mention': return `${username} mentioned you`;
        case 'share': return `${username} shared your post`;
        default: return 'New notification';
    }
}
const markNotificationRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const notificationId = req.params.id;
        const pool = await (0, database_1.getSQLServerPool)();
        console.log('📌 Marking notification as read:', notificationId, 'for user:', userId);
        const result = await pool.request()
            .input('notificationId', mssql_1.default.Int, notificationId)
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE nt_notifications SET is_read = 1 WHERE id = @notificationId AND cuserid = @userId');
        if (result.rowsAffected[0] === 0) {
            console.log('Notification not found or already read');
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }
        res.json({ success: true });
    }
    catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notification' });
    }
};
exports.markNotificationRead = markNotificationRead;
const markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        console.log('📌 Marking all notifications as read for user:', userId);
        const result = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE nt_notifications SET is_read = 1 WHERE cuserid = @userId AND is_read = 0');
        console.log('Updated rows:', result.rowsAffected[0]);
        res.json({ success: true, message: 'All notifications marked as read' });
    }
    catch (error) {
        console.error('Error marking all as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};
exports.markAllAsRead = markAllAsRead;
const markAllNotificationsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        console.log('📌 Marking all notifications as read for user:', userId);
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE nt_notifications SET is_read = 1 WHERE cuserid = @userId AND is_read = 0');
        res.json({ success: true, message: 'All notifications marked as read' });
    }
    catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};
exports.markAllNotificationsRead = markAllNotificationsRead;
const deleteNotification = async (req, res) => {
    try {
        const userId = req.user.id;
        const notificationId = req.params.id;
        const pool = await (0, database_1.getSQLServerPool)();
        await pool.request()
            .input('notificationId', mssql_1.default.Int, notificationId)
            .input('userId', mssql_1.default.Int, userId)
            .query('DELETE FROM nt_notifications WHERE id = @notificationId AND cuserid = @userId');
        res.json({ success: true });
    }
    catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete notification',
            error: error.message
        });
    }
};
exports.deleteNotification = deleteNotification;
const getUserStats = async (req, res) => {
    try {
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        const [postCount, followersCount, followingCount, totalLikes] = await Promise.all([
            pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .query('SELECT COUNT(*) as count FROM nt_posts WHERE cuserid = @userId'),
            pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .query('SELECT COUNT(*) as count FROM nt_follows WHERE following_id = @userId'),
            pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .query('SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = @userId'),
            pool.request()
                .input('userId', mssql_1.default.Int, userId)
                .query(`
                    SELECT COUNT(*) as count FROM nt_reactions r 
                    JOIN nt_posts p ON r.post_id = p.id 
                    WHERE p.cuserid = @userId
                `)
        ]);
        res.json({
            success: true,
            stats: {
                posts: postCount.recordset[0]?.count || 0,
                followers: followersCount.recordset[0]?.count || 0,
                following: followingCount.recordset[0]?.count || 0,
                totalLikes: totalLikes.recordset[0]?.count || 0
            }
        });
    }
    catch (error) {
        console.error('Error getting user stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get user stats',
            error: error.message
        });
    }
};
exports.getUserStats = getUserStats;
const getActivityLog = async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 50 } = req.query;
        const logs = await database_1.ActivityLog.find({ userId: userId.toString() })
            .sort({ timestamp: -1 })
            .limit(Number(limit));
        res.json({ success: true, logs });
    }
    catch (error) {
        console.error('Error getting activity log:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get activity log',
            error: error.message
        });
    }
};
exports.getActivityLog = getActivityLog;
const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('SELECT password_hash FROM users WHERE id = @userId');
        const user = userResult.recordset[0];
        const isValid = await bcryptjs_1.default.compare(currentPassword, user.password_hash);
        if (!isValid) {
            throw new errorHandler_1.AppError('Current password is incorrect', 401);
        }
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 12);
        await pool.request()
            .input('passwordHash', mssql_1.default.NVarChar, hashedPassword)
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE users SET password_hash = @passwordHash WHERE id = @userId');
        // Invalidate all sessions
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('DELETE FROM nt_sessions WHERE cuserid = @userId');
        res.json({ success: true, message: 'Password changed successfully' });
    }
    catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to change password',
            error: error.message
        });
    }
};
exports.changePassword = changePassword;
const deactivateAccount = async (req, res) => {
    try {
        const userId = req.user.id;
        const { password } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('SELECT password_hash FROM users WHERE id = @userId');
        const user = userResult.recordset[0];
        const isValid = await bcryptjs_1.default.compare(password, user.password_hash);
        if (!isValid) {
            throw new errorHandler_1.AppError('Invalid password', 401);
        }
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('UPDATE users SET is_active = 0 WHERE id = @userId');
        await pool.request()
            .input('userId', mssql_1.default.Int, userId)
            .query('DELETE FROM nt_sessions WHERE cuserid = @userId');
        res.json({ success: true, message: 'Account deactivated' });
    }
    catch (error) {
        console.error('Error deactivating account:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to deactivate account',
            error: error.message
        });
    }
};
exports.deactivateAccount = deactivateAccount;
//# sourceMappingURL=userController.js.map