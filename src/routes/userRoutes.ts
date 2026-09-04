// backend/src/routes/userRoutes.ts
import { Router } from 'express';
import {
    getUserProfile,
    updateUserProfile,
    updateAvatar,
    getUserPosts,
    followUser,
    unfollowUser,
    getFollowers,
    getFollowing,
    searchUsers,
    getNotifications,
    getUserNotifications,
    markNotificationRead,
    deleteNotification,
    clearAllNotifications,
    getUserStats,
    getActivityLog,
    changePassword,
    deactivateAccount,
    markAllNotificationsRead,
    markAllAsRead,
    updateUserNotifications
} from '../controllers/userController';
import { authenticateToken } from '../middleware/auth';
import { upload } from '../utils/fileUpload';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// Profile routes
router.get('/profile/:username?', getUserProfile);
router.put('/profile', updateUserProfile);
router.post('/profile/avatar', upload.single('avatar'), updateAvatar);
router.post('/profile/change-password', changePassword);
router.post('/profile/deactivate', deactivateAccount);

// Follow routes
router.post('/:userId/follow', followUser);
router.delete('/:userId/follow', unfollowUser);
router.get('/:userId/followers', getFollowers);
router.get('/:userId/following', getFollowing);

// Posts routes
router.get('/:userId/posts', getUserPosts); 

// Search
router.get('/search', searchUsers);

// Notifications routes
router.get('/notifications', authenticateToken, getNotifications);
router.get('/notifications/user', authenticateToken, getUserNotifications);
router.put('/notifications/:id/read', authenticateToken, markNotificationRead);
router.put('/notifications/read-all', authenticateToken, markAllAsRead);
router.delete('/notifications', authenticateToken, clearAllNotifications);
router.delete('/notifications/:id', authenticateToken, deleteNotification);
router.put('/notifications/update', authenticateToken, updateUserNotifications);

// Stats and Activity
router.get('/stats', getUserStats);
router.get('/activity', getActivityLog);

export default router;