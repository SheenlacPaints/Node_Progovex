import { Request, Response } from 'express';
import { executeQuery, executeNonQuery, ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import bcrypt from 'bcryptjs';
import { processImage } from '../utils/fileUpload';
import sql from 'mssql';

export const getUserProfile = async (req: AuthRequest, res: Response) => {
    const { username } = req.params;
    const currentUserId = req.user!.id;

    let query: string;
    let params: any;

    if (username) {
        query = `
            SELECT id, username, full_name, avatar_url, bio, created_at 
            FROM users 
            WHERE username = @username
        `;
        params = { username };
    } else {
        query = `
            SELECT id, username, full_name, avatar_url, bio, created_at 
            FROM users 
            WHERE id = @userId
        `;
        params = { userId: currentUserId };
    }

    const users = await executeQuery<any>(query, params);
    const user = users[0];

    if (!user) {
        throw new AppError('User not found', 404);
    }

    // Get follower counts
    const followers = await executeQuery<any>(
        'SELECT COUNT(*) as count FROM nt_follows WHERE following_id = @userId',
        { userId: user.id }
    );

    const following = await executeQuery<any>(
        'SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = @userId',
        { userId: user.id }
    );

    // Check if current user follows this user
    const isFollowing = await executeQuery<any>(
        'SELECT id FROM nt_follows WHERE follower_id = @followerId AND following_id = @followingId',
        { followerId: currentUserId, followingId: user.id }
    );

    res.json({
        success: true,
        user: {
            ...user,
            followers_count: followers[0]?.count || 0,
            following_count: following[0]?.count || 0,
            is_following: isFollowing && isFollowing.length > 0
        }
    });
};

export const updateUserProfile = async (req: AuthRequest, res: Response) => {
    const { fullName, bio } = req.body;
    const userId = req.user!.id;

    await executeNonQuery(
        'UPDATE users SET full_name = @fullName, bio = @bio WHERE id = @userId',
        { fullName, bio, userId }
    );

    await ActivityLog.create({
        userId: userId.toString(),
        action: 'update_profile',
        entityType: 'user',
        details: { fullName, bio },
        ipAddress: req.ip
    });

    res.json({ success: true, message: 'Profile updated successfully' });
};

export const updateAvatar = async (req: AuthRequest, res: Response) => {
    try {
        if (!req.file) {
            throw new AppError('No file uploaded', 400);
        }

        const avatarUrl = await processImage(req.file.originalname);
        const userId = req.user!.id;

        await executeNonQuery(
            'UPDATE users SET avatar_url = @avatarUrl WHERE id = @userId',
            { avatarUrl, userId }
        );

        res.json({ success: true, avatarUrl });
    } catch (error) {
        console.error('Error updating avatar:', error);
        res.status(500).json({ success: false, message: 'Failed to update avatar' });
    }
};

export const followUser = async (req: AuthRequest, res: Response) => {
    const followerId = req.user!.id;
    const followingId = parseInt(req.params.userId);

    if (followerId === followingId) {
        throw new AppError('Cannot follow yourself', 400);
    }

    // Check if user exists
    const users = await executeQuery<any>(
        'SELECT id FROM users WHERE id = @userId',
        { userId: followingId }
    );

    if (!users || users.length === 0) {
        throw new AppError('User not found', 404);
    }

    try {
        await executeNonQuery(
            'INSERT INTO nt_follows (follower_id, following_id) VALUES (@followerId, @followingId)',
            { followerId, followingId }
        );

        // Create notification
        await executeNonQuery(
            `INSERT INTO nt_notifications (cuserid, from_user_id, type, reference_id, reference_type, content, created_at) 
             VALUES (@userId, @fromUserId, 'follow', @referenceId, 'user', @content, GETDATE())`,
            {
                userId: followingId,
                fromUserId: followerId,
                referenceId: followerId,
                content: `${req.user!.username} started following you`
            }
        );

        await ActivityLog.create({
            userId: followerId.toString(),
            action: 'follow',
            entityType: 'user',
            entityId: followingId.toString(),
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'User followed' });
    } catch (error: any) {
        // Check for duplicate entry error in SQL Server
        if (error.message && error.message.includes('Violation of UNIQUE KEY')) {
            throw new AppError('Already following this user', 400);
        }
        throw error;
    }
};

export const unfollowUser = async (req: AuthRequest, res: Response) => {
    const followerId = req.user!.id;
    const followingId = parseInt(req.params.userId);

    await executeNonQuery(
        'DELETE FROM nt_follows WHERE follower_id = @followerId AND following_id = @followingId',
        { followerId, followingId }
    );

    res.json({ success: true, message: 'User unfollowed' });
};

export const getFollowers = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const followers = await executeQuery<any>(
        `SELECT u.id, u.username, u.full_name, u.avatar_url 
         FROM nt_follows f 
         JOIN users u ON f.follower_id = u.id 
         WHERE f.following_id = @userId 
         ORDER BY f.created_at DESC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
        { userId, offset, limit }
    );

    res.json({ success: true, followers, page, limit });
};

export const getFollowing = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const following = await executeQuery<any>(
        `SELECT u.id, u.username, u.full_name, u.avatar_url 
         FROM nt_follows f 
         JOIN users u ON f.following_id = u.id 
         WHERE f.follower_id = @userId 
         ORDER BY f.created_at DESC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
        { userId, offset, limit }
    );

    res.json({ success: true, following, page, limit });
};

export const getUserPosts = async (req: AuthRequest, res: Response) => {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const posts = await executeQuery<any>(
        `SELECT 
            p.*,
            (SELECT COUNT(*) FROM nt_reactions WHERE post_id = p.id) as likes_count,
            (SELECT COUNT(*) FROM nt_comments WHERE post_id = p.id) as comments_count
         FROM nt_posts p
         WHERE p.cuserid = @userId AND p.status = 'approved'
         ORDER BY p.created_at DESC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
        { userId, offset, limit }
    );

    res.json({ success: true, posts, page, limit });
};

export const searchUsers = async (req: AuthRequest, res: Response) => {
    const q = req.query.q as string;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!q) {
        throw new AppError('Search query required', 400);
    }

    const users = await executeQuery<any>(
        `SELECT id, username, full_name, avatar_url 
         FROM users 
         WHERE username LIKE @searchTerm OR full_name LIKE @searchTerm
         ORDER BY username
         OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`,
        { 
            searchTerm: `%${q}%`,
            limit 
        }
    );

    res.json({ success: true, users });
};

export const getNotifications = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        console.log('📥 Fetching notifications for user:', userId);
        console.log('📊 Page:', page, 'Limit:', limit, 'Offset:', offset);

        // Get notifications with pagination
        const notifications = await executeQuery<any>(
            `SELECT 
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
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            { userId, offset, limit }
        );

        // Get unread count
        const unreadResult = await executeQuery<any>(
            `SELECT COUNT(*) as count 
             FROM nt_notifications 
             WHERE cuserid = @userId AND is_read = 0`,
            { userId }
        );

        const unreadCount = unreadResult[0]?.count || 0;
        console.log('📊 Notifications found:', notifications.length);
        console.log('📊 Unread count:', unreadCount);

        // Format notifications with user data
        const formattedNotifications = [];
        for (const notif of notifications) {
            let fromUser = null;
            if (notif.from_user_id) {
                const userResult = await executeQuery<any>(
                    'SELECT username, full_name, avatar_url FROM users WHERE id = @userId',
                    { userId: notif.from_user_id }
                );
                const userData = userResult[0];
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
    } catch (error) {
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

// Helper function
function getDefaultNotificationContent(type: string, fromUser: any): string {
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

export const markNotificationRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const notificationId = req.params.id;

        console.log('📌 Marking notification as read:', notificationId, 'for user:', userId);

        const result = await executeNonQuery(
            'UPDATE nt_notifications SET is_read = 1 WHERE id = @notificationId AND cuserid = @userId',
            { notificationId, userId }
        );

        if (result.rowsAffected && result.rowsAffected[0] === 0) {
            console.log('Notification not found or already read');
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notification' });
    }
};

export const markAllAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        console.log('📌 Marking all notifications as read for user:', userId);

        const result = await executeNonQuery(
            'UPDATE nt_notifications SET is_read = 1 WHERE cuserid = @userId AND is_read = 0',
            { userId }
        );

        console.log('Updated rows:', result.rowsAffected?.[0] || 0);

        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};

export const markAllNotificationsRead = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        console.log('📌 Marking all notifications as read for user:', userId);

        await executeNonQuery(
            'UPDATE nt_notifications SET is_read = 1 WHERE cuserid = @userId AND is_read = 0',
            { userId }
        );

        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ success: false, message: 'Error updating notifications' });
    }
};

export const deleteNotification = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const notificationId = req.params.id;

    await executeNonQuery(
        'DELETE FROM nt_notifications WHERE id = @notificationId AND cuserid = @userId',
        { notificationId, userId }
    );

    res.json({ success: true });
};

export const getUserStats = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    const postCount = await executeQuery<any>(
        'SELECT COUNT(*) as count FROM nt_posts WHERE cuserid = @userId',
        { userId }
    );

    const followersCount = await executeQuery<any>(
        'SELECT COUNT(*) as count FROM nt_follows WHERE following_id = @userId',
        { userId }
    );

    const followingCount = await executeQuery<any>(
        'SELECT COUNT(*) as count FROM nt_follows WHERE follower_id = @userId',
        { userId }
    );

    const totalLikes = await executeQuery<any>(
        `SELECT COUNT(*) as count FROM nt_reactions r 
         JOIN nt_posts p ON r.post_id = p.id 
         WHERE p.cuserid = @userId`,
        { userId }
    );

    res.json({
        success: true,
        stats: {
            posts: postCount[0]?.count || 0,
            followers: followersCount[0]?.count || 0,
            following: followingCount[0]?.count || 0,
            totalLikes: totalLikes[0]?.count || 0
        }
    });
};

export const getActivityLog = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 50;

    const logs = await ActivityLog.find({ userId: userId.toString() })
        .sort({ timestamp: -1 })
        .limit(limit);

    res.json({ success: true, logs });
};

export const changePassword = async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;

    const users = await executeQuery<any>(
        'SELECT password_hash FROM users WHERE id = @userId',
        { userId }
    );

    const user = users[0];

    if (!user) {
        throw new AppError('User not found', 404);
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
        throw new AppError('Current password is incorrect', 401);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await executeNonQuery(
        'UPDATE users SET password_hash = @hashedPassword WHERE id = @userId',
        { hashedPassword, userId }
    );

    // Invalidate all sessions
    await executeNonQuery(
        'DELETE FROM nt_sessions WHERE cuserid = @userId',
        { userId }
    );

    res.json({ success: true, message: 'Password changed successfully' });
};

export const deactivateAccount = async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { password } = req.body;

    const users = await executeQuery<any>(
        'SELECT password_hash FROM users WHERE id = @userId',
        { userId }
    );

    const user = users[0];
    
    if (!user) {
        throw new AppError('User not found', 404);
    }

    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
        throw new AppError('Invalid password', 401);
    }

    await executeNonQuery(
        'UPDATE users SET is_active = 0 WHERE id = @userId',
        { userId }
    );

    await executeNonQuery(
        'DELETE FROM nt_sessions WHERE cuserid = @userId',
        { userId }
    );

    res.json({ success: true, message: 'Account deactivated' });
};

// Additional user management functions

export const getTopUsers = async (req: AuthRequest, res: Response) => {
    try {
        const limit = parseInt(req.query.limit as string) || 10;

        const topUsers = await executeQuery<any>(
            `SELECT TOP ${limit}
                u.id, 
                u.username, 
                u.full_name, 
                u.avatar_url,
                COUNT(DISTINCT p.id) as post_count,
                COUNT(DISTINCT r.id) as total_likes,
                COUNT(DISTINCT f.follower_id) as follower_count
             FROM users u
             LEFT JOIN nt_posts p ON u.id = p.cuserid AND p.status = 'approved'
             LEFT JOIN nt_reactions r ON p.id = r.post_id
             LEFT JOIN nt_follows f ON u.id = f.following_id
             GROUP BY u.id, u.username, u.full_name, u.avatar_url
             ORDER BY post_count DESC, total_likes DESC`
        );

        res.json({
            success: true,
            users: topUsers
        });
    } catch (error) {
        console.error('Error getting top users:', error);
        res.status(500).json({ success: false, message: 'Failed to get top users' });
    }
};

export const getSuggestedUsers = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const limit = parseInt(req.query.limit as string) || 10;

        const suggestedUsers = await executeQuery<any>(
            `SELECT TOP ${limit}
                u.id, 
                u.username, 
                u.full_name, 
                u.avatar_url,
                (SELECT COUNT(*) FROM nt_follows WHERE following_id = u.id) as follower_count
             FROM users u
             WHERE u.id != @userId
             AND u.id NOT IN (
                 SELECT following_id FROM nt_follows WHERE follower_id = @userId
             )
             AND u.is_active = 1
             ORDER BY NEWID()`,
            { userId }
        );

        res.json({
            success: true,
            users: suggestedUsers
        });
    } catch (error) {
        console.error('Error getting suggested users:', error);
        res.status(500).json({ success: false, message: 'Failed to get suggested users' });
    }
};

export const updateNotificationSettings = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { email_notifications, push_notifications, in_app_notifications } = req.body;

        // Check if settings exist
        const existing = await executeQuery<any>(
            'SELECT id FROM nt_notification_settings WHERE cuserid = @userId',
            { userId }
        );

        if (existing && existing.length > 0) {
            await executeNonQuery(
                `UPDATE nt_notification_settings 
                 SET email_notifications = @email,
                     push_notifications = @push,
                     in_app_notifications = @inApp,
                     updated_at = GETDATE()
                 WHERE cuserid = @userId`,
                {
                    userId,
                    email: email_notifications ? 1 : 0,
                    push: push_notifications ? 1 : 0,
                    inApp: in_app_notifications ? 1 : 0
                }
            );
        } else {
            await executeNonQuery(
                `INSERT INTO nt_notification_settings 
                 (cuserid, email_notifications, push_notifications, in_app_notifications, created_at, updated_at)
                 VALUES (@userId, @email, @push, @inApp, GETDATE(), GETDATE())`,
                {
                    userId,
                    email: email_notifications ? 1 : 0,
                    push: push_notifications ? 1 : 0,
                    inApp: in_app_notifications ? 1 : 0
                }
            );
        }

        res.json({
            success: true,
            message: 'Notification settings updated successfully'
        });
    } catch (error) {
        console.error('Error updating notification settings:', error);
        res.status(500).json({ success: false, message: 'Failed to update notification settings' });
    }
};

export const getNotificationSettings = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;

        const settings = await executeQuery<any>(
            `SELECT 
                email_notifications, 
                push_notifications, 
                in_app_notifications 
             FROM nt_notification_settings 
             WHERE cuserid = @userId`,
            { userId }
        );

        const defaultSettings = {
            email_notifications: true,
            push_notifications: true,
            in_app_notifications: true
        };

        res.json({
            success: true,
            settings: settings[0] || defaultSettings
        });
    } catch (error) {
        console.error('Error getting notification settings:', error);
        res.status(500).json({ success: false, message: 'Failed to get notification settings' });
    }
};