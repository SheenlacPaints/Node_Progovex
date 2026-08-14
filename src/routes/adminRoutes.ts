// backend/src/routes/adminRoutes.ts
import { Router } from 'express';
import {
  getPendingPosts,
  approvePost,
  rejectPost,
  bulkApprovePosts,
  bulkRejectPosts,
  getAllUsers,
  updateUserRole,
  suspendUser,
  activateUser,
  deleteUser,
  getSystemStats,
  getActivityLogs,
  getReportedPosts,
  resolveReport,
  approveReportPost,
  removeReportPost,
  reportList,
  getAnalytics,
  sendAnnouncement,
  getModerationQueue,
  assignModerator,
  getSystemHealth,
  getPostStats,
  getAllPostsForAdmin,
  getNewPostNotifications,
  markNotificationRead,
} from '../controllers/adminController';
import { authenticateToken, authorizeAdmin, authorizeModerator } from '../middleware/auth';
import { strictLimiter } from '../middleware/rateLimiter';
import { decryptRequest } from '../middleware/encryption';

const router = Router();

// All admin routes require authentication and admin/moderator role
router.use(authenticateToken);
router.use(authorizeModerator);

// Post moderation
// router.get('/posts/pending', authorizeAdmin, getPendingPosts);
router.get('/posts/pending', getPendingPosts);
router.get('/posts', getAllPostsForAdmin);
router.get('/stats', getPostStats);  


router.post('/posts/:id/approve', decryptRequest, authorizeAdmin, approvePost);
router.post('/posts/:id/reject', decryptRequest, authorizeAdmin, rejectPost);
router.post('/posts/bulk-approve', decryptRequest, authorizeAdmin, bulkApprovePosts);
router.post('/posts/bulk-reject', decryptRequest, authorizeAdmin, bulkRejectPosts);
router.get('/posts/reported', getReportedPosts);
router.post('/reports/:id/resolve', resolveReport);
router.get('/moderation/queue', getModerationQueue);

router.post('/reports/:id/approve', authorizeAdmin, approveReportPost);
router.post('/reports/:id/remove', authorizeAdmin, removeReportPost);
router.get('/reports/:id/list', authorizeAdmin, reportList);

// User management (admin only)
router.get('/users', authorizeAdmin, getAllUsers);
router.put('/users/:id/role', authorizeAdmin, updateUserRole);
router.post('/users/:id/suspend', authorizeAdmin, suspendUser);
router.post('/users/:id/activate', authorizeAdmin, activateUser);
router.delete('/users/:id', authorizeAdmin, deleteUser);
router.post('/users/:id/assign-moderator', authorizeAdmin, assignModerator);

// System stats and analytics
router.get('/stats', authorizeAdmin, getSystemStats);
router.get('/logs', authorizeAdmin, getActivityLogs);
router.get('/analytics', authorizeAdmin, getAnalytics);
router.get('/health', getSystemHealth);

// Announcements
router.post('/announcements', authorizeAdmin, sendAnnouncement);

router.get('/notifications', authorizeAdmin, getNewPostNotifications);
router.put('/notifications/:id/read', authenticateToken, markNotificationRead);

export default router;