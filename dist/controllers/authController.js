"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMe = exports.resetPassword = exports.forgotPassword = exports.verifyEmail = exports.refreshToken = exports.logout = exports.login = exports.register = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const database_2 = require("../config/database");
const emailWorker_1 = require("../workers/emailWorker");
const crypto_1 = __importDefault(require("crypto"));
const mssql_1 = __importDefault(require("mssql"));
const generateTokens = (userId, username, cemail, role) => {
    const accessToken = jsonwebtoken_1.default.sign({ id: userId, username, cemail, role }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '90m' });
    const refreshToken = jsonwebtoken_1.default.sign({ id: userId, username, cemail, role }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '7d' });
    return { accessToken, refreshToken };
};
const register = async (req, res, next) => {
    try {
        const { username, cemail, password, fullName } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        // Validate input
        if (!username || !cemail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, cemail and password are required'
            });
        }
        const existingResult = await pool.request()
            .input('cemail', mssql_1.default.NVarChar, cemail)
            .input('username', mssql_1.default.NVarChar, username)
            .query('SELECT id FROM users WHERE cemail = @cemail OR username = @username');
        if (existingResult.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email or username'
            });
        }
        const hashedPassword = await bcryptjs_1.default.hash(password, 12);
        const verificationToken = crypto_1.default.randomBytes(32).toString('hex');
        const result = await pool.request()
            .input('username', mssql_1.default.NVarChar, username)
            .input('cemail', mssql_1.default.NVarChar, cemail)
            .input('password_hash', mssql_1.default.NVarChar, hashedPassword)
            .input('full_name', mssql_1.default.NVarChar, fullName || null)
            .input('verification_token', mssql_1.default.NVarChar, verificationToken)
            .query(`
                INSERT INTO users (username, cemail, password_hash, full_name, email_verified, verification_token) 
                OUTPUT INSERTED.id
                VALUES (@username, @cemail, @password_hash, @full_name, 0, @verification_token)
            `);
        const userId = result.recordset[0]?.id;
        // Don't await email - send in background
        (0, emailWorker_1.sendEmail)(cemail, 'Verify Your Email', 'welcome', { name: fullName || username, token: verificationToken }).catch(console.error);
        // Log activity asynchronously
        database_2.ActivityLog.create({
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
    }
    catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during registration'
        });
    }
};
exports.register = register;
const login = async (req, res, next) => {
    try {
        const { cemail, password } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        if (!cemail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }
        const userResult = await pool.request()
            .input('cemail', mssql_1.default.NVarChar, cemail)
            .query('SELECT * FROM users WHERE cemail = @cemail');
        const user = userResult.recordset[0];
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
        const isValidPassword = await bcryptjs_1.default.compare(password, user.password_hash);
        if (!isValidPassword) {
            await database_2.ActivityLog.create({
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
        const { accessToken, refreshToken } = generateTokens(user.id, user.username, user.cemail, user.role);
        console.log('🔑 Generated accessToken:', accessToken.substring(0, 50) + '...');
        console.log('🔑 Generated refreshToken:', refreshToken.substring(0, 50) + '...');
        // Save BOTH tokens for session validation
        await pool.request()
            .input('cuserid', mssql_1.default.Int, user.id)
            .input('token', mssql_1.default.NVarChar, accessToken)
            .input('refresh_token', mssql_1.default.NVarChar, refreshToken)
            .input('ip_address', mssql_1.default.NVarChar, req.ip || null)
            .input('user_agent', mssql_1.default.NVarChar, req.headers['user-agent'] || null)
            .query(`
                INSERT INTO nt_sessions (cuserid, token, refresh_token, ip_address, user_agent, expires_at) 
                VALUES (@cuserid, @token, @refresh_token, @ip_address, @user_agent, DATEADD(DAY, 7, GETDATE()))
            `);
        console.log('✅ Session saved with accessToken');
        // Verify session was saved
        const checkResult = await pool.request()
            .input('token', mssql_1.default.NVarChar, accessToken)
            .query('SELECT * FROM nt_sessions WHERE token = @token');
        console.log('🔍 Session verification - Found:', checkResult.recordset.length);
        await database_2.ActivityLog.create({
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
    }
    catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during login'
        });
    }
};
exports.login = login;
const logout = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        const pool = await (0, database_1.getSQLServerPool)();
        if (token) {
            // Delete by token (now this is the accessToken)
            await pool.request()
                .input('token', mssql_1.default.NVarChar, token)
                .query('DELETE FROM nt_sessions WHERE token = @token');
        }
        await database_2.ActivityLog.create({
            userId: req.user.id.toString(),
            action: 'user_logout',
            entityType: 'user',
            ipAddress: req.ip
        }).catch(console.error);
        res.json({ success: true, message: 'Logged out successfully' });
    }
    catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, message: 'Error during logout' });
    }
};
exports.logout = logout;
const refreshToken = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        if (!refreshToken) {
            return res.status(400).json({ success: false, message: 'Refresh token required' });
        }
        const sessionResult = await pool.request()
            .input('refreshToken', mssql_1.default.NVarChar, refreshToken)
            .query('SELECT * FROM nt_sessions WHERE token = @refreshToken AND expires_at > GETDATE()');
        if (sessionResult.recordset.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }
        const decoded = jsonwebtoken_1.default.verify(refreshToken, process.env.JWT_SECRET || 'default_secret');
        const { accessToken, refreshToken: newRefreshToken } = generateTokens(decoded.id, decoded.username, decoded.cemail, decoded.role);
        await pool.request()
            .input('newRefreshToken', mssql_1.default.NVarChar, newRefreshToken)
            .input('oldRefreshToken', mssql_1.default.NVarChar, refreshToken)
            .query(`
                UPDATE nt_sessions 
                SET token = @newRefreshToken, expires_at = DATEADD(DAY, 7, GETDATE()) 
                WHERE token = @oldRefreshToken
            `);
        res.json({
            success: true,
            accessToken,
            refreshToken: newRefreshToken
        });
    }
    catch (error) {
        console.error('Refresh token error:', error);
        res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
};
exports.refreshToken = refreshToken;
const verifyEmail = async (req, res, next) => {
    try {
        const { token } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        const result = await pool.request()
            .input('token', mssql_1.default.NVarChar, token)
            .query(`
                UPDATE users 
                SET email_verified = 1 
                WHERE verification_token = @token AND email_verified = 0
            `);
        if (result.rowsAffected[0] === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification token' });
        }
        res.json({ success: true, message: 'Email verified successfully' });
    }
    catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({ success: false, message: 'Error verifying email' });
    }
};
exports.verifyEmail = verifyEmail;
const forgotPassword = async (req, res, next) => {
    try {
        const { cemail } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('cemail', mssql_1.default.NVarChar, cemail)
            .query('SELECT id, username, cemail FROM users WHERE cemail = @cemail');
        const user = userResult.recordset[0];
        if (user) {
            const resetToken = crypto_1.default.randomBytes(32).toString('hex');
            await pool.request()
                .input('resetToken', mssql_1.default.NVarChar, resetToken)
                .input('userId', mssql_1.default.Int, user.id)
                .query(`
                    UPDATE users 
                    SET reset_token = @resetToken, reset_token_expires = DATEADD(HOUR, 1, GETDATE()) 
                    WHERE id = @userId
                `);
            (0, emailWorker_1.sendEmail)(user.cemail, 'Password Reset Request', 'reset_password', { name: user.username, token: resetToken }).catch(console.error);
        }
        res.json({
            success: true,
            message: 'If an account exists, you will receive a password reset email'
        });
    }
    catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Error processing request' });
    }
};
exports.forgotPassword = forgotPassword;
const resetPassword = async (req, res, next) => {
    try {
        const { token, newPassword } = req.body;
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('token', mssql_1.default.NVarChar, token)
            .query('SELECT id FROM users WHERE reset_token = @token AND reset_token_expires > GETDATE()');
        const user = userResult.recordset[0];
        if (!user) {
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
        }
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 12);
        await pool.request()
            .input('password_hash', mssql_1.default.NVarChar, hashedPassword)
            .input('userId', mssql_1.default.Int, user.id)
            .query(`
                UPDATE users 
                SET password_hash = @password_hash, reset_token = NULL, reset_token_expires = NULL 
                WHERE id = @userId
            `);
        await pool.request()
            .input('userId', mssql_1.default.Int, user.id)
            .query('DELETE FROM nt_sessions WHERE cuserid = @userId');
        res.json({ success: true, message: 'Password reset successfully' });
    }
    catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Error resetting password' });
    }
};
exports.resetPassword = resetPassword;
const getMe = async (req, res, next) => {
    try {
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('userId', mssql_1.default.Int, req.user.id)
            .query(`
                SELECT id, username, cemail, full_name, avatar_url, bio, role, is_active, email_verified, created_at 
                FROM users 
                WHERE id = @userId
            `);
        const user = userResult.recordset[0];
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, user });
    }
    catch (error) {
        console.error('Get me error:', error);
        res.status(500).json({ success: false, message: 'Error fetching user data' });
    }
};
exports.getMe = getMe;
//# sourceMappingURL=authController.js.map