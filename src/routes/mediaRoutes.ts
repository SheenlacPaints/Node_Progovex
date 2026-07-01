// src/routes/mediaRoutes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { streamMedia, getMediaUrl } from '../controllers/mediaController';

const router = Router();

// Protected media routes
router.get('/stream', streamMedia);
router.get('/url', getMediaUrl);

export default router;