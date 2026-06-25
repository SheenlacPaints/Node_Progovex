// backend/src/controllers/authController.ts
import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { mysqlPool } from '../config/database';
import { ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { sendEmail } from '../workers/emailWorker';
import { AuthRequest } from '../middleware/auth';
import crypto from 'crypto';

const generateTokens = (userId: number, username: string, cemail: string, role: string) => {
    const accessToken = jwt.sign(
        { id: userId, username, cemail, role },
        process.env.JWT_SECRET || 'default_secret',
        { expiresIn: '90m' }
    );

    const refreshToken = jwt.sign(
        { id: userId, username, cemail, role },
        process.env.JWT_SECRET || 'default_secret',
        { expiresIn: '7d' }
    );

    return { accessToken, refreshToken };
};

export const register = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { username, cemail, password, fullName } = req.body;

        // Validate input
        if (!username || !cemail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, cemail and password are required'
            });
        }

        const [existing] = await mysqlPool.execute(
            'SELECT id FROM users WHERE cemail = ? OR username = ?',
            [cemail, username]
        );

        if ((existing as any[]).length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email or username'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const verificationToken = crypto.randomBytes(32).toString('hex');

        const [result] = await mysqlPool.execute(
            `INSERT INTO users (username, cemail, password_hash, full_name, email_verified, verification_token) 
       VALUES (?, ?, ?, ?, false, ?)`,
            [username, cemail, hashedPassword, fullName || null, verificationToken]
        );

        const userId = (result as any).insertId;

        // Don't await email - send in background
        sendEmail(
            cemail,
            'Verify Your Email',
            'welcome',
            { name: fullName || username, token: verificationToken }
        ).catch(console.error);

        // Log activity asynchronously
        ActivityLog.create({
            userId: userId.toString(),
            action: 'user_registered',
            entityType: 'user',
            details: { cemail, username },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        }).catch(console.error);

        res.status(201).json({
            success: true,
            message: 'Registration successful! Please verify your email.',
            userId
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during registration'
        });
    }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { cemail, password } = req.body;

        if (!cemail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const [users] = await mysqlPool.execute(
            'SELECT * FROM users WHERE cemail = ?',
            [cemail]
        );

        const user = (users as any[])[0];

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        if (!user.is_active) {
            return res.status(401).json({
                success: false,
                message: 'Account is deactivated'
            });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            await ActivityLog.create({
                userId: user.id.toString(),
                action: 'failed_login',
                entityType: 'user',
                details: { reason: 'Invalid password' },
                ipAddress: req.ip
            }).catch(console.error);

            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const { accessToken, refreshToken } = generateTokens(
            user.id,
            user.username,
            user.cemail,
            user.role
        );

        console.log('🔑 Generated accessToken:', accessToken.substring(0, 50) + '...');
        console.log('🔑 Generated refreshToken:', refreshToken.substring(0, 50) + '...');

        // FIX: Save BOTH tokens or at least the accessToken for session validation
        // Option 1: Save accessToken (recommended for session validation)
        await mysqlPool.execute(
            `INSERT INTO nt_sessions (cuserid, token, refresh_token, ip_address, user_agent, expires_at) 
             VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
            [user.id, accessToken, refreshToken, req.ip || null, req.headers['user-agent'] || null]
        );

        console.log('✅ Session saved with accessToken');

        // Verify session was saved
        const [checkSession] = await mysqlPool.execute(
            'SELECT * FROM nt_sessions WHERE token = ?',
            [accessToken]
        );
        console.log('🔍 Session verification - Found:', (checkSession as any[]).length);

        await ActivityLog.create({
            userId: user.id.toString(),
            action: 'user_login',
            entityType: 'user',
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        }).catch(console.error);

        res.json({
            success: true,
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                username: user.username,
                cemail: user.cemail,
                fullName: user.full_name,
                avatarUrl: user.avatar_url,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during login'
        });
    }
};

export const logout = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token) {
            // Delete by token (now this is the accessToken)
            await mysqlPool.execute(
                'DELETE FROM nt_sessions WHERE token = ?',
                [token]
            );
        }

        await ActivityLog.create({
            userId: req.user!.id.toString(),
            action: 'user_logout',
            entityType: 'user',
            ipAddress: req.ip
        }).catch(console.error);

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, message: 'Error during logout' });
    }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ success: false, message: 'Refresh token required' });
        }

        const [sessions] = await mysqlPool.execute(
            'SELECT * FROM nt_sessions WHERE token = ? AND expires_at > NOW()',
            [refreshToken]
        );

        if ((sessions as any[]).length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }

        const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET || 'default_secret') as any;

        const { accessToken, refreshToken: newRefreshToken } = generateTokens(
            decoded.id,
            decoded.username,
            decoded.cemail,
            decoded.role
        );

        await mysqlPool.execute(
            'UPDATE nt_sessions SET token = ?, expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE token = ?',
            [newRefreshToken, refreshToken]
        );

        res.json({
            success: true,
            accessToken,
            refreshToken: newRefreshToken
        });
    } catch (error) {
        console.error('Refresh token error:', error);
        res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
};

export const verifyEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token } = req.body;

        const [result] = await mysqlPool.execute(
            'UPDATE users SET email_verified = true WHERE verification_token = ? AND email_verified = false',
            [token]
        );

        if ((result as any).affectedRows === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
        }

        res.json({ success: true, message: 'Email verified successfully' });
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({ success: false, message: 'Error verifying email' });
    }
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { cemail } = req.body;

        const [users] = await mysqlPool.execute(
            'SELECT id, username FROM users WHERE cemail = ?',
            [cemail]
        );

        const user = (users as any[])[0];

        if (user) {
            const resetToken = crypto.randomBytes(32).toString('hex');

            await mysqlPool.execute(
                'UPDATE users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
                [resetToken, user.id]
            );

            sendEmail(
                user.cemail,
                'Password Reset Request',
                'reset_password',
                { name: user.username, token: resetToken }
            ).catch(console.error);
        }

        res.json({
            success: true,
            message: 'If an account exists, you will receive a password reset cemail'
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Error processing request' });
    }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token, newPassword } = req.body;

        const [users] = await mysqlPool.execute(
            'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > NOW()',
            [token]
        );

        const user = (users as any[])[0];

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await mysqlPool.execute(
            'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
            [hashedPassword, user.id]
        );

        await mysqlPool.execute(
            'DELETE FROM nt_sessions WHERE cuserid = ?',
            [user.id]
        );

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Error resetting password' });
    }
};

export const getMe = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const [users] = await mysqlPool.execute(
            'SELECT id, username, cemail, full_name, avatar_url, bio, role, is_active, email_verified, created_at FROM users WHERE id = ?',
            [req.user!.id]
        );

        const user = (users as any[])[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        console.error('Get me error:', error);
        res.status(500).json({ success: false, message: 'Error fetching user data' });
    }
};