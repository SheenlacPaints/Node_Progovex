import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { executeQuery, executeNonQuery, ActivityLog } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { sendEmail } from '../workers/emailWorker';
import { AuthRequest } from '../middleware/auth';
import crypto from 'crypto';
import sql from 'mssql';

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
                message: 'Username, email and password are required'
            });
        }

        // Check if user exists
        const existing = await executeQuery<any>(
            'SELECT id FROM users WHERE cemail = @cemail OR username = @username',
            { cemail, username }
        );

        if (existing && existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email or username'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // Insert new user
        const result = await executeNonQuery(
            `INSERT INTO users (username, cemail, password_hash, full_name, email_verified, verification_token) 
             VALUES (@username, @cemail, @hashedPassword, @fullName, 0, @verificationToken)`,
            {
                username,
                cemail,
                hashedPassword,
                fullName: fullName || null,
                verificationToken
            }
        );

        const userId = result.recordset?.[0]?.id || result.insertId;

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

        const users = await executeQuery<any>(
            'SELECT * FROM users WHERE cemail = @cemail',
            { cemail }
        );

        const user = users[0];

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

        // Save BOTH tokens for session validation
        await executeNonQuery(
            `INSERT INTO nt_sessions (cuserid, token, refresh_token, ip_address, user_agent, expires_at) 
             VALUES (@userId, @accessToken, @refreshToken, @ip, @userAgent, DATEADD(day, 7, GETDATE()))`,
            {
                userId: user.id,
                accessToken,
                refreshToken,
                ip: req.ip || null,
                userAgent: req.headers['user-agent'] || null
            }
        );

        console.log('✅ Session saved with accessToken');

        // Verify session was saved
        const checkSession = await executeQuery<any>(
            'SELECT * FROM nt_sessions WHERE token = @accessToken',
            { accessToken }
        );
        console.log('🔍 Session verification - Found:', checkSession?.length || 0);

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
            await executeNonQuery(
                'DELETE FROM nt_sessions WHERE token = @token',
                { token }
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

        const sessions = await executeQuery<any>(
            'SELECT * FROM nt_sessions WHERE token = @refreshToken AND expires_at > GETDATE()',
            { refreshToken }
        );

        if (!sessions || sessions.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }

        const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET || 'default_secret') as any;

        const { accessToken, refreshToken: newRefreshToken } = generateTokens(
            decoded.id,
            decoded.username,
            decoded.cemail,
            decoded.role
        );

        await executeNonQuery(
            'UPDATE nt_sessions SET token = @newRefreshToken, expires_at = DATEADD(day, 7, GETDATE()) WHERE token = @refreshToken',
            { newRefreshToken, refreshToken }
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

        const result = await executeNonQuery(
            'UPDATE users SET email_verified = 1 WHERE verification_token = @token AND email_verified = 0',
            { token }
        );

        if (result.rowsAffected && result.rowsAffected[0] === 0) {
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

        const users = await executeQuery<any>(
            'SELECT id, username, cemail FROM users WHERE cemail = @cemail',
            { cemail }
        );

        const user = users[0];

        if (user) {
            const resetToken = crypto.randomBytes(32).toString('hex');

            await executeNonQuery(
                'UPDATE users SET reset_token = @resetToken, reset_token_expires = DATEADD(hour, 1, GETDATE()) WHERE id = @userId',
                { resetToken, userId: user.id }
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
            message: 'If an account exists, you will receive a password reset email'
        });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Error processing request' });
    }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { token, newPassword } = req.body;

        const users = await executeQuery<any>(
            'SELECT id FROM users WHERE reset_token = @token AND reset_token_expires > GETDATE()',
            { token }
        );

        const user = users[0];

        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await executeNonQuery(
            'UPDATE users SET password_hash = @hashedPassword, reset_token = NULL, reset_token_expires = NULL WHERE id = @userId',
            { hashedPassword, userId: user.id }
        );

        await executeNonQuery(
            'DELETE FROM nt_sessions WHERE cuserid = @userId',
            { userId: user.id }
        );

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Error resetting password' });
    }
};

export const getMe = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const users = await executeQuery<any>(
            `SELECT 
                id, 
                username, 
                cemail, 
                full_name, 
                avatar_url, 
                bio, 
                role, 
                is_active, 
                email_verified, 
                created_at 
             FROM users 
             WHERE id = @userId`,
            { userId: req.user!.id }
        );

        const user = users[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        console.error('Get me error:', error);
        res.status(500).json({ success: false, message: 'Error fetching user data' });
    }
};

// Additional helper functions for SQL Server

// Change password
export const changePassword = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user!.id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        // Get user with password hash
        const users = await executeQuery<any>(
            'SELECT password_hash FROM users WHERE id = @userId',
            { userId }
        );

        const user = users[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Verify current password
        const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        // Update password
        await executeNonQuery(
            'UPDATE users SET password_hash = @hashedPassword WHERE id = @userId',
            { hashedPassword, userId }
        );

        // Delete all sessions for this user (force re-login)
        await executeNonQuery(
            'DELETE FROM nt_sessions WHERE cuserid = @userId',
            { userId }
        );

        await ActivityLog.create({
            userId: userId.toString(),
            action: 'password_changed',
            entityType: 'user',
            ipAddress: req.ip
        }).catch(console.error);

        res.json({
            success: true,
            message: 'Password changed successfully. Please login again.'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, message: 'Error changing password' });
    }
};

// Update profile
export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { fullName, bio, avatarUrl } = req.body;
        const userId = req.user!.id;

        const result = await executeNonQuery(
            `UPDATE users 
             SET full_name = @fullName, 
                 bio = @bio, 
                 avatar_url = @avatarUrl 
             WHERE id = @userId`,
            { fullName, bio, avatarUrl, userId }
        );

        if (result.rowsAffected && result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Get updated user
        const users = await executeQuery<any>(
            `SELECT id, username, cemail, full_name, avatar_url, bio, role 
             FROM users 
             WHERE id = @userId`,
            { userId }
        );

        await ActivityLog.create({
            userId: userId.toString(),
            action: 'profile_updated',
            entityType: 'user',
            ipAddress: req.ip
        }).catch(console.error);

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: users[0]
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ success: false, message: 'Error updating profile' });
    }
};

// Check if email exists
export const checkEmailExists = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { cemail } = req.query;

        if (!cemail) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const users = await executeQuery<any>(
            'SELECT id FROM users WHERE cemail = @cemail',
            { cemail }
        );

        res.json({
            success: true,
            exists: users && users.length > 0
        });
    } catch (error) {
        console.error('Check email error:', error);
        res.status(500).json({ success: false, message: 'Error checking email' });
    }
};

// Resend verification email
export const resendVerificationEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { cemail } = req.body;

        if (!cemail) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const users = await executeQuery<any>(
            'SELECT id, username, cemail, verification_token FROM users WHERE cemail = @cemail AND email_verified = 0',
            { cemail }
        );

        const user = users[0];

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found or already verified'
            });
        }

        // Send verification email
        sendEmail(
            user.cemail,
            'Verify Your Email',
            'welcome',
            { name: user.username, token: user.verification_token }
        ).catch(console.error);

        res.json({
            success: true,
            message: 'Verification email sent successfully'
        });
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ success: false, message: 'Error sending verification email' });
    }
};

export default {
    register,
    login,
    logout,
    refreshToken,
    verifyEmail,
    forgotPassword,
    resetPassword,
    getMe,
    changePassword,
    updateProfile,
    checkEmailExists,
    resendVerificationEmail
};