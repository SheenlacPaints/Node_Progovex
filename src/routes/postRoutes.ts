// backend/src/routes/postRoutes.ts
import { Router } from 'express';
import {
    createPost,
    getPosts,
    getPost,
    updatePost,
    deletePost,
    getComments,
    addComment,
    deleteComment,
    addReaction,
    removeReaction,
    getReactions,
    sharePost,
    getFeed,
    savePost,
    unsavePost,
    reportPost,
    getSavedPosts,
    getTrendingHashtags,
    getPostsSimple,
    addCommentReaction,
    removeCommentReaction,
    votePoll,
    getUserPollVote,
    getResharedFeed,
    getReshareStatus,
    unResharePost,
    resharePost
} from '../controllers/postController';
import { authenticateToken, authorizeModerator } from '../middleware/auth';
import { upload } from '../utils/fileUpload';
import { strictLimiter } from '../middleware/rateLimiter';

const router = Router();

// Protected routes (require authentication)
router.post('/', authenticateToken, upload.array('media', 10), createPost);
router.get('/', authenticateToken, getPosts);
router.get('/feed', authenticateToken, getFeed);
router.get('/saved', authenticateToken, getSavedPosts);
router.get('/trending/hashtags', authenticateToken, getTrendingHashtags);  // Add this line
router.get('/:id', authenticateToken, getPost);
router.put('/:id', authenticateToken, updatePost);
router.delete('/:id', authenticateToken, deletePost);
router.get('/simple', authenticateToken, getPostsSimple);

// Comment routes
router.get('/:id/comments', authenticateToken, getComments);
router.post('/comments', authenticateToken, strictLimiter, addComment);
router.delete('/comments/:id', authenticateToken, deleteComment);
router.post('/comments/:id/like', authenticateToken, addCommentReaction);
router.delete('/comments/:id/like', authenticateToken, removeCommentReaction);


// Reaction routes
router.post('/:id/reactions', authenticateToken, addReaction);
router.delete('/:id/reactions', authenticateToken, removeReaction);
router.get('/:id/reactions', authenticateToken, getReactions);

// Share route
router.post('/:id/share', authenticateToken, sharePost);

// Save/Unsave post
router.post('/:id/save', authenticateToken, savePost);
router.delete('/:id/save', authenticateToken, unsavePost);

// Report post
router.post('/:id/report', authenticateToken, reportPost);
router.post('/:id/poll/vote', authenticateToken, votePoll);
router.get('/:id/poll/user-vote', authenticateToken, getUserPollVote);


// Add these routes to your existing router
// Reshare routes
router.post('/:id/reshare', authenticateToken, resharePost);
router.delete('/:id/reshare', authenticateToken, unResharePost);
router.get('/:id/reshare/status', authenticateToken, getReshareStatus);
router.get('/reshared/feed', authenticateToken, getResharedFeed);


export default router;