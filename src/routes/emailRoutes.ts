// backend/src/routes/emailRoutes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import {
    getConnectedAccounts,
    initiateOAuth,
    googleCallback,
    outlookCallback,
    checkOAuthStatus,
    testIMAPConnection,
    connectIMAP,
    disconnectEmail,
    getGmailEmails,
    getEmailById,
    markEmailAsRead,
    markEmailAsStarred,
    sendEmail,
    deleteEmail,
    syncEmails
} from '../controllers/emailController';

const router = Router();

// OAuth callbacks (no auth required)
router.get('/google/callback', googleCallback);
router.get('/outlook/callback', outlookCallback);

// Protected routes
router.get('/connections', authenticateToken, getConnectedAccounts);
router.post('/:provider/oauth', authenticateToken, initiateOAuth);
router.get('/:provider/status', authenticateToken, checkOAuthStatus);

// Email CRUD operations
router.get('/:provider/emails', authenticateToken, getGmailEmails);
router.get('/:provider/emails/:id', authenticateToken, getEmailById);
router.post('/:provider/emails/:id/read', authenticateToken, markEmailAsRead);
router.post('/:provider/emails/:id/star', authenticateToken, markEmailAsStarred);
router.post('/:provider/send', authenticateToken, sendEmail);
router.delete('/:provider/emails/:id', authenticateToken, deleteEmail);
router.post('/:provider/sync', authenticateToken, syncEmails);

// IMAP routes
router.post('/imap/test', authenticateToken, testIMAPConnection);
router.post('/imap/connect', authenticateToken, connectIMAP);
router.delete('/:provider/disconnect', authenticateToken, disconnectEmail);

export default router;