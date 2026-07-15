// backend/src/routes/gmail.routes.ts

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth';
import { upload } from '../utils/fileUpload';
import {
    handleGmailAuth,
    handleGmailCallback,
    checkGmailStatus,
    getGmailEmails,
    getGmailEmail,
    getGmailFolderCounts,
    getGmailLabels,
    searchGmailEmails,
    syncGmailEmails,
    syncAllGmailEmails, // NEW
    sendGmailEmail,
    saveGmailDraft,
    toggleGmailStar,
    markGmailRead,
    markGmailUnread,
    deleteGmailEmail,
    moveGmailToTrash,
    moveGmailToSpam,
    restoreGmailFromTrash,
    downloadGmailAttachment,
    addGmailLabel,
    removeGmailLabel,
    bulkDeleteEmails,
    bulkMoveToTrash,
    bulkMarkAsRead,
    bulkMarkAsUnread,
    getGmailNavigation,
    clearEmailCacheDev,
    debugEmailCount,
    debugTokenStatus,
    debugOAuthFlow
} from '../controllers/gmail.controller';

const router = Router();

// ==============================================
// CORS MIDDLEWARE
// ==============================================
const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    if (origin && ['http://localhost:4200', 'http://localhost:3000'].includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Authorization');

    if (req.method === 'OPTIONS') {
        console.log(`OPTIONS request handled for: ${req.path}`);
        return res.sendStatus(200);
    }

    next();
};

router.use(corsMiddleware);

// ==============================================
// PUBLIC ROUTES (No authentication required)
// ==============================================
router.get('/auth', handleGmailAuth);
router.get('/callback', handleGmailCallback);

// ==============================================
// PROTECTED ROUTES - All require authentication
// ==============================================

// Status - requires auth
router.get('/status', authenticateToken, checkGmailStatus);

router.get('/debug/token', authenticateToken, debugTokenStatus);

router.get('/debug/oauth', debugOAuthFlow);


// Email CRUD
router.get('/emails', authenticateToken, getGmailEmails);
router.get('/emails/search', authenticateToken, searchGmailEmails);
router.get('/emails/sync', authenticateToken, syncGmailEmails);
router.get('/emails/:id', authenticateToken, getGmailEmail);
router.get('/emails/:id/navigation', authenticateToken, getGmailNavigation);
router.get('/counts', authenticateToken, getGmailFolderCounts);
router.get('/labels', authenticateToken, getGmailLabels);

// NEW: Sync all emails
router.post('/sync-all', authenticateToken, syncAllGmailEmails);

// NEW: Debug endpoint
router.get('/debug/counts', authenticateToken, debugEmailCount);

// Send email with attachments
router.post('/emails/send', authenticateToken, upload.array('attachments', 10), sendGmailEmail);
router.post('/emails/drafts', authenticateToken, upload.array('attachments', 10), saveGmailDraft);

// Email actions
router.post('/emails/:id/read', authenticateToken, markGmailRead);
router.post('/emails/:id/unread', authenticateToken, markGmailUnread);
router.post('/emails/:id/star', authenticateToken, toggleGmailStar);
router.delete('/emails/:id', authenticateToken, deleteGmailEmail);
router.post('/emails/:id/trash', authenticateToken, moveGmailToTrash);
router.post('/emails/:id/spam', authenticateToken, moveGmailToSpam);
router.post('/emails/:id/restore', authenticateToken, restoreGmailFromTrash);

// Labels
router.post('/emails/:id/labels', authenticateToken, addGmailLabel);
router.delete('/emails/:id/labels/:labelId', authenticateToken, removeGmailLabel);

// Attachments
router.get('/emails/:id/attachments/:attachmentId', authenticateToken, downloadGmailAttachment);

// Bulk operations
router.post('/emails/bulk/delete', authenticateToken, bulkDeleteEmails);
router.post('/emails/bulk/trash', authenticateToken, bulkMoveToTrash);
router.post('/emails/bulk/read', authenticateToken, bulkMarkAsRead);
router.post('/emails/bulk/unread', authenticateToken, bulkMarkAsUnread);

// Development - Clear cache
router.post('/clear-cache', authenticateToken, clearEmailCacheDev);

export default router;