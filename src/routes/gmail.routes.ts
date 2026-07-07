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
    clearEmailCacheDev
} from '../controllers/gmail.controller';

const router = Router();

router.options('/emails', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200);
});

// ==============================================
// ✅ CORS MIDDLEWARE - MUST BE FIRST
// ==============================================
const corsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Set CORS headers for ALL responses
    if (origin && ['http://localhost:4200', 'http://localhost:3000'].includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Authorization');

    // ✅ Handle OPTIONS IMMEDIATELY - before any other middleware
    if (req.method === 'OPTIONS') {
        console.log(`✅ OPTIONS request handled for: ${req.path}`);
        return res.sendStatus(200);
    }

    next();
};

// ✅ Apply CORS middleware FIRST (before any route-specific middleware)
router.use(corsMiddleware);

// ==============================================
// PUBLIC ROUTES (No authentication required)
// ==============================================
router.get('/auth', handleGmailAuth);
router.get('/callback', handleGmailCallback);

// ==============================================
// PROTECTED ROUTES - EMAIL CRUD
// ==============================================

// ✅ Status & Connection (No authentication for status? Keep as is)
router.get('/status', authenticateToken, checkGmailStatus);

// ✅ Email CRUD - GET routes
router.get('/emails', authenticateToken, getGmailEmails);
router.get('/emails/search', authenticateToken, searchGmailEmails);
router.get('/emails/sync', authenticateToken, syncGmailEmails);
router.get('/emails/:id', authenticateToken, getGmailEmail);
router.get('/emails/:id/navigation', authenticateToken, getGmailNavigation);
router.get('/counts', authenticateToken, getGmailFolderCounts);
router.get('/labels', authenticateToken, getGmailLabels);

// ✅ Send email with attachments
router.post('/emails/send', authenticateToken, upload.array('attachments', 10), sendGmailEmail);
router.post('/emails/drafts', authenticateToken, upload.array('attachments', 10), saveGmailDraft);

// ✅ Email actions
router.post('/emails/:id/read', authenticateToken, markGmailRead);
router.post('/emails/:id/unread', authenticateToken, markGmailUnread);
router.post('/emails/:id/star', authenticateToken, toggleGmailStar);
router.delete('/emails/:id', authenticateToken, deleteGmailEmail);
router.post('/emails/:id/trash', authenticateToken, moveGmailToTrash);
router.post('/emails/:id/spam', authenticateToken, moveGmailToSpam);
router.post('/emails/:id/restore', authenticateToken, restoreGmailFromTrash);

// ✅ Labels
router.post('/emails/:id/labels', authenticateToken, addGmailLabel);
router.delete('/emails/:id/labels/:labelId', authenticateToken, removeGmailLabel);

// ✅ Attachments
router.get('/emails/:id/attachments/:attachmentId', authenticateToken, downloadGmailAttachment);

// ✅ Bulk operations
router.post('/emails/bulk/delete', authenticateToken, bulkDeleteEmails);
router.post('/emails/bulk/trash', authenticateToken, bulkMoveToTrash);
router.post('/emails/bulk/read', authenticateToken, bulkMarkAsRead);
router.post('/emails/bulk/unread', authenticateToken, bulkMarkAsUnread);

// ✅ Development - Clear cache
router.post('/clear-cache', authenticateToken, clearEmailCacheDev);

export default router;