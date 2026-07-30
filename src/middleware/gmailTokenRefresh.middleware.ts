import { Response, NextFunction } from 'express';
import { GmailAuthenticatedRequest } from './gmailAuth.middleware';
import { authService } from '../services/auth.service';
import { gmailTokenDbService } from '../services/gmailTokenDb.service';

export async function gmailTokenRefreshMiddleware(
  req: GmailAuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  if (!req.tokens) {
    return next();
  }

  try {
    const now = Date.now();
    const expiryDate = req.tokens.expiry_date || 0;
    const buffer = 5 * 60 * 1000;

    if (now >= expiryDate - buffer) {
      const refreshedTokens = await authService.refreshAccessToken(req.tokens);
      req.tokens = refreshedTokens;

      if (req.gmailUserId) {
        await gmailTokenDbService.updateTokens(req.gmailUserId, refreshedTokens);
      }
    }

    next();
  } catch (error: any) {
    console.error('[GmailTokenRefresh] Token refresh failed:', error.message);
    return _res.status(401).json({ error: 'Token refresh failed, please re-authenticate' });
  }
}
