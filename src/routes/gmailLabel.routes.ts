import { Router, Response } from 'express';
import { GmailAuthenticatedRequest, gmailAuthMiddleware } from '../middleware/gmailAuth.middleware';
import { gmailTokenRefreshMiddleware } from '../middleware/gmailTokenRefresh.middleware';
import { gmailService } from '../services/gmail.service';

const router = Router();

router.use(gmailAuthMiddleware);
router.use(gmailTokenRefreshMiddleware);

router.get('/labels', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const labels = await gmailService.listLabels(req.tokens!);
    res.json(labels);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
