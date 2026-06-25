"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/userRoutes.ts
const express_1 = require("express");
const userController_1 = require("../controllers/userController");
const auth_1 = require("../middleware/auth");
const fileUpload_1 = require("../utils/fileUpload");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticateToken);
// Profile routes
router.get('/profile/:username?', userController_1.getUserProfile);
router.put('/profile', userController_1.updateUserProfile);
router.post('/profile/avatar', fileUpload_1.upload.single('avatar'), userController_1.updateAvatar);
router.post('/profile/change-password', userController_1.changePassword);
router.post('/profile/deactivate', userController_1.deactivateAccount);
// Follow routes
router.post('/:userId/follow', userController_1.followUser);
router.delete('/:userId/follow', userController_1.unfollowUser);
router.get('/:userId/followers', userController_1.getFollowers);
router.get('/:userId/following', userController_1.getFollowing);
// Posts routes
router.get('/:userId/posts', userController_1.getUserPosts);
// Search
router.get('/search', userController_1.searchUsers);
// Notifications routes
router.get('/notifications', auth_1.authenticateToken, userController_1.getNotifications);
router.put('/notifications/:id/read', auth_1.authenticateToken, userController_1.markNotificationRead);
router.put('/notifications/read-all', auth_1.authenticateToken, userController_1.markAllAsRead);
router.delete('/notifications/:id', auth_1.authenticateToken, userController_1.deleteNotification);
// Stats and Activity
router.get('/stats', userController_1.getUserStats);
router.get('/activity', userController_1.getActivityLog);
exports.default = router;
//# sourceMappingURL=userRoutes.js.map