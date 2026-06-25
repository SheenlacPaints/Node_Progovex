"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/emailRoutes.ts
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const emailController_1 = require("../controllers/emailController");
const router = (0, express_1.Router)();
// OAuth callbacks (no auth required)
router.get('/google/callback', emailController_1.googleCallback);
router.get('/outlook/callback', emailController_1.outlookCallback);
// Protected routes
router.get('/connections', auth_1.authenticateToken, emailController_1.getConnectedAccounts);
router.post('/:provider/oauth', auth_1.authenticateToken, emailController_1.initiateOAuth);
router.get('/:provider/status', auth_1.authenticateToken, emailController_1.checkOAuthStatus);
// Email CRUD operations
router.get('/:provider/emails', auth_1.authenticateToken, emailController_1.getGmailEmails);
router.get('/:provider/emails/:id', auth_1.authenticateToken, emailController_1.getEmailById);
router.post('/:provider/emails/:id/read', auth_1.authenticateToken, emailController_1.markEmailAsRead);
router.post('/:provider/emails/:id/star', auth_1.authenticateToken, emailController_1.markEmailAsStarred);
router.post('/:provider/send', auth_1.authenticateToken, emailController_1.sendEmail);
router.delete('/:provider/emails/:id', auth_1.authenticateToken, emailController_1.deleteEmail);
router.post('/:provider/sync', auth_1.authenticateToken, emailController_1.syncEmails);
// IMAP routes
router.post('/imap/test', auth_1.authenticateToken, emailController_1.testIMAPConnection);
router.post('/imap/connect', auth_1.authenticateToken, emailController_1.connectIMAP);
router.delete('/:provider/disconnect', auth_1.authenticateToken, emailController_1.disconnectEmail);
exports.default = router;
//# sourceMappingURL=emailRoutes.js.map