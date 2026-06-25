"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeModerator = exports.authorizeAdmin = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    console.log("token..........", token);
    console.log('🔐 Auth middleware - Token received:', token ? 'Yes' : 'No');
    console.log('🔐 Auth middleware - Token value:', token?.substring(0, 50) + '...');
    console.log('🔐 Auth middleware - JWT_SECRET exists:', !!process.env.JWT_SECRET);
    if (!token) {
        console.log('❌ No token provided');
        return res.status(401).json({ error: 'Access token required' });
    }
    try {
        // Try to verify with the secret
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || 'default_secret');
        console.log('✅ Token verified successfully', decoded);
        console.log('✅ Decoded user:', { id: decoded.username, username: decoded.username, role: "3" });
        // Check session in database
        // const [sessions] = await mysqlPool.execute(
        //     'SELECT * FROM nt_sessions WHERE token = ? AND expires_at > NOW()',
        //     [token]
        // );
        // console.log('🔍 Session check - Found:', (sessions as any[]).length);
        // if ((sessions as any[]).length === 0) {
        //     console.log('❌ Session not found or expired');
        //     return res.status(401).json({ error: 'Session expired' });
        // }
        req.user = {
            id: decoded.username,
            username: decoded.FullName,
            email: decoded.email,
            type: decoded.type || 'standard'
        };
        console.log('✅ Authentication successful');
        next();
    }
    catch (error) {
        console.error('❌ Token verification error:', error);
        if (error instanceof jsonwebtoken_1.default.JsonWebTokenError) {
            console.error('JWT Error:', error.message);
        }
        return res.status(403).json({ error: 'Invalid token' });
    }
};
exports.authenticateToken = authenticateToken;
const authorizeAdmin = (req, res, next) => {
    // if (req.user?.role !== 'admin') {
    //     return res.status(403).json({ error: 'Admin access required' });
    // }
    next();
};
exports.authorizeAdmin = authorizeAdmin;
const authorizeModerator = (req, res, next) => {
    // if (req.user?.role !== 'admin' && req.user?.role !== 'moderator') {
    //     return res.status(403).json({ error: 'Moderator access required' });
    // }
    next();
};
exports.authorizeModerator = authorizeModerator;
//# sourceMappingURL=auth.js.map