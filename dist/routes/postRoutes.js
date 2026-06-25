"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/postRoutes.ts
const express_1 = require("express");
const postController_1 = require("../controllers/postController");
const auth_1 = require("../middleware/auth");
const fileUpload_1 = require("../utils/fileUpload");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// Protected routes (require authentication)
router.post('/', auth_1.authenticateToken, fileUpload_1.upload.array('media', 5), postController_1.createPost);
router.get('/', auth_1.authenticateToken, postController_1.getPosts);
router.get('/feed', auth_1.authenticateToken, postController_1.getFeed);
router.get('/saved', auth_1.authenticateToken, postController_1.getSavedPosts);
router.get('/trending/hashtags', auth_1.authenticateToken, postController_1.getTrendingHashtags); // Add this line
router.get('/:id', auth_1.authenticateToken, postController_1.getPost);
router.put('/:id', auth_1.authenticateToken, postController_1.updatePost);
router.delete('/:id', auth_1.authenticateToken, postController_1.deletePost);
router.get('/simple', auth_1.authenticateToken, postController_1.getPostsSimple);
// Comment routes
router.get('/:id/comments', auth_1.authenticateToken, postController_1.getComments);
router.post('/comments', auth_1.authenticateToken, rateLimiter_1.strictLimiter, postController_1.addComment);
router.delete('/comments/:id', auth_1.authenticateToken, postController_1.deleteComment);
router.post('/comments/:id/like', auth_1.authenticateToken, postController_1.addCommentReaction);
router.delete('/comments/:id/like', auth_1.authenticateToken, postController_1.removeCommentReaction);
// Reaction routes
router.post('/:id/reactions', auth_1.authenticateToken, postController_1.addReaction);
router.delete('/:id/reactions', auth_1.authenticateToken, postController_1.removeReaction);
router.get('/:id/reactions', auth_1.authenticateToken, postController_1.getReactions);
// Share route
router.post('/:id/share', auth_1.authenticateToken, postController_1.sharePost);
// Save/Unsave post
router.post('/:id/save', auth_1.authenticateToken, postController_1.savePost);
router.delete('/:id/save', auth_1.authenticateToken, postController_1.unsavePost);
// Report post
router.post('/:id/report', auth_1.authenticateToken, postController_1.reportPost);
router.post('/:id/poll/vote', auth_1.authenticateToken, postController_1.votePoll);
router.get('/:id/poll/user-vote', auth_1.authenticateToken, postController_1.getUserPollVote);
// Add these routes to your existing router
// Reshare routes
router.post('/:id/reshare', auth_1.authenticateToken, postController_1.resharePost);
router.delete('/:id/reshare', auth_1.authenticateToken, postController_1.unResharePost);
router.get('/:id/reshare/status', auth_1.authenticateToken, postController_1.getReshareStatus);
router.get('/reshared/feed', auth_1.authenticateToken, postController_1.getResharedFeed);
exports.default = router;
//# sourceMappingURL=postRoutes.js.map