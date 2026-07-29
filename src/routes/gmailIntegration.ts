import { Router } from 'express';
import gmailAuthRoutes from './gmailAuth.routes';
import gmailMailRoutes from './gmailMail.routes';
import gmailLabelRoutes from './gmailLabel.routes';

const router = Router();

router.use('/auth', gmailAuthRoutes);
router.use('/', gmailMailRoutes);
router.use('/', gmailLabelRoutes);

export default router;
