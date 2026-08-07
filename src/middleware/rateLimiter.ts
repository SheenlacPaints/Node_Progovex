// backend/src/middleware/rateLimiter.ts
import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
        return req.ip || req.socket.remoteAddress || 'unknown';
    }
});

export const strictLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 150,
    message: 'Too many requests, please slow down',
    standardHeaders: true,
    legacyHeaders: false
});

export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 155,
    message: 'Too many authentication attempts',
    standardHeaders: true,
    legacyHeaders: false
});

// Lenient limiter for media/static file requests (images, videos, etc.)
export const mediaLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 1000, // Allow 1000 requests per minute for media
    message: 'Too many media requests',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: Request) => {
        // Don't rate limit health checks or CORS test
        return req.path === '/health' || req.path === '/cors-test';
    }
});