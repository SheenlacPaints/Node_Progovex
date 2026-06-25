"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/authRoutes.ts
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const auth_1 = require("../middleware/auth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// Public routes with rate limiting
router.post('/register', authController_1.register);
router.post('/login', authController_1.login);
router.post('/refresh-token', authController_1.refreshToken);
router.post('/verify-email', authController_1.verifyEmail);
router.post('/forgot-password', rateLimiter_1.authLimiter, authController_1.forgotPassword);
router.post('/reset-password', authController_1.resetPassword);
// Protected routes
router.get('/me', auth_1.authenticateToken, authController_1.getMe);
router.post('/logout', auth_1.authenticateToken, authController_1.logout);
exports.default = router;
//# sourceMappingURL=authRoutes.js.map