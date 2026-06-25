"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/adminRoutes.ts
const express_1 = require("express");
const adminController_1 = require("../controllers/adminController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All admin routes require authentication and admin/moderator role
router.use(auth_1.authenticateToken);
router.use(auth_1.authorizeModerator);
// Post moderation
router.get('/posts/pending', auth_1.authorizeAdmin, adminController_1.getPendingPosts);
router.get('/posts', adminController_1.getAllPostsForAdmin);
router.get('/stats', adminController_1.getPostStats);
router.post('/posts/:id/approve', auth_1.authorizeAdmin, adminController_1.approvePost);
router.post('/posts/:id/reject', auth_1.authorizeAdmin, adminController_1.rejectPost);
router.post('/posts/bulk-approve', auth_1.authorizeAdmin, adminController_1.bulkApprovePosts);
router.post('/posts/bulk-reject', auth_1.authorizeAdmin, adminController_1.bulkRejectPosts);
router.get('/posts/reported', adminController_1.getReportedPosts);
router.post('/reports/:id/resolve', adminController_1.resolveReport);
router.get('/moderation/queue', adminController_1.getModerationQueue);
// User management (admin only)
router.get('/users', auth_1.authorizeAdmin, adminController_1.getAllUsers);
router.put('/users/:id/role', auth_1.authorizeAdmin, adminController_1.updateUserRole);
router.post('/users/:id/suspend', auth_1.authorizeAdmin, adminController_1.suspendUser);
router.post('/users/:id/activate', auth_1.authorizeAdmin, adminController_1.activateUser);
router.delete('/users/:id', auth_1.authorizeAdmin, adminController_1.deleteUser);
router.post('/users/:id/assign-moderator', auth_1.authorizeAdmin, adminController_1.assignModerator);
// System stats and analytics
router.get('/stats', auth_1.authorizeAdmin, adminController_1.getSystemStats);
router.get('/logs', auth_1.authorizeAdmin, adminController_1.getActivityLogs);
router.get('/analytics', auth_1.authorizeAdmin, adminController_1.getAnalytics);
router.get('/health', adminController_1.getSystemHealth);
// Announcements
router.post('/announcements', auth_1.authorizeAdmin, adminController_1.sendAnnouncement);
exports.default = router;
//# sourceMappingURL=adminRoutes.js.map