import { Request, Response, NextFunction } from 'express';
import { OAuthTokens } from '../services/auth.service';
import jwt from 'jsonwebtoken';
import { gmailTokenDbService } from '../services/gmailTokenDb.service';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const GMAIL_USER_COOKIE = 'gmail_user_session';

export interface GmailAuthenticatedRequest extends Request {
  tokens?: OAuthTokens;
  user?: any;
  gmailUserId?: string;
}

function signUserId(userId: string): string {
  return jwt.sign({ uid: userId }, SESSION_SECRET, { expiresIn: '7d' });
}

function verifyUserId(token: string): string | null {
  try {
    const decoded = jwt.verify(token, SESSION_SECRET) as { uid: string };
    return decoded.uid;
  } catch {
    return null;
  }
}

export function setGmailUserCookie(res: Response, userId: string) {
  const signed = signUserId(userId);
  res.cookie(GMAIL_USER_COOKIE, signed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearGmailUserCookie(res: Response) {
  res.clearCookie(GMAIL_USER_COOKIE, { path: '/' });
}

export async function gmailAuthMiddleware(req: GmailAuthenticatedRequest, res: Response, next: NextFunction) {
  const cookie = req.cookies?.[GMAIL_USER_COOKIE];
  if (!cookie) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = verifyUserId(cookie);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  try {
    const tokens = await gmailTokenDbService.getTokensByUserId(userId);
    if (!tokens) {
      return res.status(401).json({ error: 'Gmail not connected' });
    }

    req.tokens = tokens;
    req.gmailUserId = userId;
    next();
  } catch (error: any) {
    console.error('[GmailAuth] DB lookup failed:', error.message);
    return res.status(500).json({ error: 'Authentication lookup failed' });
  }
}
