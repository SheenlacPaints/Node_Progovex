"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logout = exports.refreshToken = exports.authorizeRoles = exports.authorizeOwner = exports.authorizeModerator = exports.authorizeAdmin = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const mssql_1 = __importDefault(require("mssql"));
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    console.log('🔐 Auth middleware - Token received:', token ? 'Yes' : 'No');
    console.log('🔐 Auth middleware - Token value:', token?.substring(0, 50) + '...');
    console.log('🔐 Auth middleware - JWT_SECRET exists:', !!process.env.JWT_SECRET);
    if (!token) {
        console.log('❌ No token provided');
        return res.status(401).json({ error: 'Access token required' });
    }
    try {
        // Verify the token
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || 'default_secret');
        console.log('✅ Token verified successfully', decoded);
        // Get user details from database
        const pool = await (0, database_1.getSQLServerPool)();
        const userResult = await pool.request()
            .input('userId', mssql_1.default.Int, decoded.id || decoded.username)
            .query(`
                SELECT id, username, cemail as email, full_name, role, is_active 
                FROM users 
                WHERE id = @userId AND is_active = 1
            `);
        const user = userResult.recordset[0];
        if (!user) {
            console.log('❌ User not found or inactive');
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        // Check session in database (optional - uncomment if you want session validation)
        // const sessionResult = await pool.request()
        //     .input('token', sql.NVarChar, token)
        //     .input('userId', sql.Int, user.id)
        //     .query('SELECT * FROM nt_sessions WHERE token = @token AND cuserid = @userId AND expires_at > GETDATE()');
        // console.log('🔍 Session check - Found:', sessionResult.recordset.length);
        // if (sessionResult.recordset.length === 0) {
        //     console.log('❌ Session not found or expired');
        //     return res.status(401).json({ error: 'Session expired' });
        // }
        // Set user in request
        req.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            fullName: user.full_name,
            role: user.role || 'user',
            type: decoded.type || 'standard'
        };
        console.log(`✅ Authentication successful for user: ${user.username} (ID: ${user.id})`);
        next();
    }
    catch (error) {
        console.error('❌ Token verification error:', error);
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            console.error('JWT Error:', error.message);
            return res.status(403).json({ error: 'Invalid token' });
        }
        if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
            console.error('JWT Error: Token expired');
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(500).json({ error: 'Authentication failed' });
    }
};
exports.authenticateToken = authenticateToken;
const authorizeAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        console.log(`❌ Admin access denied for user: ${req.user?.username} (Role: ${req.user?.role})`);
        return res.status(403).json({ error: 'Admin access required' });
    }
    console.log(`✅ Admin access granted for user: ${req.user?.username}`);
    next();
};
exports.authorizeAdmin = authorizeAdmin;
const authorizeModerator = (req, res, next) => {
    if (req.user?.role !== 'admin' && req.user?.role !== 'moderator') {
        console.log(`❌ Moderator access denied for user: ${req.user?.username} (Role: ${req.user?.role})`);
        return res.status(403).json({ error: 'Moderator access required' });
    }
    console.log(`✅ Moderator access granted for user: ${req.user?.username}`);
    next();
};
exports.authorizeModerator = authorizeModerator;
// Optional: Middleware to check if user is the owner of a resource
const authorizeOwner = (req, res, next) => {
    const userId = parseInt(req.params.userId || req.params.id);
    if (req.user?.id !== userId && req.user?.role !== 'admin') {
        console.log(`❌ Owner access denied for user: ${req.user?.username} (UserID: ${req.user?.id}, TargetID: ${userId})`);
        return res.status(403).json({ error: 'You are not authorized to perform this action' });
    }
    console.log(`✅ Owner access granted for user: ${req.user?.username}`);
    next();
};
exports.authorizeOwner = authorizeOwner;
// Optional: Middleware to check if user has one of multiple roles
const authorizeRoles = (roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'User not authenticated' });
        }
        if (!roles.includes(req.user.role)) {
            console.log(`❌ Role access denied for user: ${req.user.username} (Role: ${req.user.role}, Required: ${roles.join(', ')})`);
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        console.log(`✅ Role access granted for user: ${req.user.username} (Role: ${req.user.role})`);
        next();
    };
};
exports.authorizeRoles = authorizeRoles;
// Optional: Refresh token middleware
const refreshToken = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }
        const pool = await (0, database_1.getSQLServerPool)();
        const sessionResult = await pool.request()
            .input('refreshToken', mssql_1.default.NVarChar, refreshToken)
            .query('SELECT * FROM nt_sessions WHERE token = @refreshToken AND expires_at > GETDATE()');
        if (sessionResult.recordset.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }
        const decoded = jsonwebtoken_1.default.verify(refreshToken, process.env.JWT_SECRET || 'default_secret');
        // Generate new tokens
        const newAccessToken = jsonwebtoken_1.default.sign({ id: decoded.id, username: decoded.username, email: decoded.email, role: decoded.role }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '15m' });
        const newRefreshToken = jsonwebtoken_1.default.sign({ id: decoded.id, username: decoded.username, email: decoded.email, role: decoded.role }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '7d' });
        // Update session with new tokens
        await pool.request()
            .input('oldRefreshToken', mssql_1.default.NVarChar, refreshToken)
            .input('newRefreshToken', mssql_1.default.NVarChar, newRefreshToken)
            .input('newAccessToken', mssql_1.default.NVarChar, newAccessToken)
            .query(`
                UPDATE nt_sessions 
                SET token = @newRefreshToken, 
                    access_token = @newAccessToken,
                    expires_at = DATEADD(DAY, 7, GETDATE()) 
                WHERE token = @oldRefreshToken
            `);
        res.json({
            success: true,
            accessToken: newAccessToken,
            refreshToken: newRefreshToken
        });
    }
    catch (error) {
        console.error('Refresh token error:', error);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
};
exports.refreshToken = refreshToken;
// Optional: Logout middleware
const logout = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            const pool = await (0, database_1.getSQLServerPool)();
            await pool.request()
                .input('token', mssql_1.default.NVarChar, token)
                .query('DELETE FROM nt_sessions WHERE token = @token');
        }
        res.json({ success: true, message: 'Logged out successfully' });
    }
    catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Failed to logout' });
    }
};
exports.logout = logout;
//# sourceMappingURL=auth.js.map