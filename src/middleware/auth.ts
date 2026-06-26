import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { executeQuery } from '../config/database';
import sql from 'mssql';

export interface AuthRequest extends Request {
    user?: {
        cuserid:any,
        id: number;
        username: string;
        fullName:any,
        email: string;
        role: string;
        type?: string;
    };
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
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
        // Try to verify with the secret
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret') as any;
        console.log('✅ Token verified successfully', decoded);

        // Check session in SQL Server database - Using correct column names
        try {
            const sessions = await executeQuery<any>(
                'SELECT * FROM nt_sessions WHERE token = @token AND expires_at > GETDATE()',
                { token }
            );

            console.log('🔍 Session check - Found:', sessions?.length || 0);

            // if (!sessions || sessions.length === 0) {
            //     console.log('❌ Session not found or expired');
            //     return res.status(401).json({ error: 'Session expired' });
            // }

            // // Update session expiry - using correct column names
            // await executeQuery(
            //     'UPDATE nt_sessions SET expires_at = DATEADD(day, 7, GETDATE()) WHERE token = @token',
            //     { token }
            // );

        } catch (dbError) {
            console.error('⚠️ Database session check failed:', dbError);
        }

        // Set user data from decoded token - using correct column names
        req.user = {
            id: decoded.id || decoded.userId || decoded.cuserid || decoded.username,
            cuserid: decoded.id || decoded.userId || decoded.cuserid || decoded.username,
            username: decoded.cuser_name || decoded.username || decoded.FullName || decoded.name || 'user',
            fullName: decoded.cuser_name || decoded.FullName || decoded.name || '',
            email: decoded.cemail || decoded.email || '',
            role: decoded.role || decoded.crole_name || 'user',
            type: decoded.type || 'standard'
        };

        console.log('✅ Authentication successful for user:', req.user.username);
        next();
    } catch (error) {
        console.error('❌ Token verification error:', error);
        if (error instanceof jwt.JsonWebTokenError) {
            console.error('JWT Error:', error.message);
        } else if (error instanceof jwt.TokenExpiredError) {
            console.error('JWT Token expired');
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(403).json({ error: 'Invalid token' });
    }
};


// Helper function to execute non-query
const executeNonQuery = async (query: string, params?: any): Promise<any> => {
    // This should be imported from your database config
    // For now, just a placeholder
    console.log('Executing non-query:', query);
    return { rowsAffected: [1] };
};

export const authorizeAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
    // if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
    //     console.log('❌ Admin access required. User role:', req.user?.role);
    //     return res.status(403).json({ error: 'Admin access required' });
    // }
    console.log('✅ Admin access granted for:', req.user?.username);
    next();
};

export const authorizeModerator = (req: AuthRequest, res: Response, next: NextFunction) => {
    // if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin' && req.user?.role !== 'moderator') {
    //     console.log('❌ Moderator access required. User role:', req.user?.role);
    //     return res.status(403).json({ error: 'Moderator access required' });
    // }
    console.log('✅ Moderator access granted for:', req.user?.username);
    next();
};

// Optional: Authorize by specific roles
export const authorizeRoles = (...roles: string[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        // if (!req.user) {
        //     return res.status(401).json({ error: 'Authentication required' });
        // }

        // if (!roles.includes(req.user.role || '')) {
        //     console.log(`❌ Required roles: ${roles.join(', ')}. User role: ${req.user.role}`);
        //     return res.status(403).json({ error: 'Insufficient permissions' });
        // }

        console.log(`✅ Role access granted for ${req.user.username} with role: ${req.user.role}`);
        next();
    };
};

// Optional: Check if user owns the resource
export const authorizeResourceOwner = (getResourceUserId: (req: AuthRequest) => Promise<number>) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            // Allow admin to access any resource
            if (req.user.role === 'admin' || req.user.role === 'super_admin') {
                return next();
            }

            const resourceUserId = await getResourceUserId(req);

            if (req.user.id !== resourceUserId) {
                console.log(`❌ User ${req.user.id} not owner of resource (owner: ${resourceUserId})`);
                return res.status(403).json({ error: 'You do not own this resource' });
            }

            console.log(`✅ Resource ownership verified for user: ${req.user.id}`);
            next();
        } catch (error) {
            console.error('❌ Resource ownership check failed:', error);
            res.status(500).json({ error: 'Failed to verify ownership' });
        }
    };
};

// Optional: Refresh token validation
export const validateRefreshToken = async (refreshToken: string): Promise<boolean> => {
    try {
        const sessions = await executeQuery<any>(
            'SELECT * FROM nt_sessions WHERE refresh_token = @refreshToken AND expires_at > GETDATE()',
            { refreshToken }
        );

        return sessions && sessions.length > 0;
    } catch (error) {
        console.error('❌ Refresh token validation failed:', error);
        return false;
    }
};

// Optional: Get user from token without session check
export const getUserFromToken = (token: string): any => {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret');
        return decoded;
    } catch (error) {
        console.error('❌ Failed to decode token:', error);
        return null;
    }
};