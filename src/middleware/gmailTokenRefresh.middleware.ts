import { Response, NextFunction } from 'express';
import { GmailAuthenticatedRequest } from './gmailAuth.middleware';
import { authService } from '../services/auth.service';
import { gmailTokenDbService } from '../services/gmailTokenDb.service';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * True when the stored refresh token can no longer be used (Google returned
 * invalid_grant / invalid_client ...). In that case the only recovery is a
 * fresh OAuth consent — a retry will never succeed.
 */
export function isReauthRequired(error: any): boolean {
  const payload = error?.response?.data ?? {};
  const haystack = [
    error?.message,
    error?.code,
    payload?.error,
    payload?.error_description,
  ]
    .filter(Boolean)
    .join(' ');
  return /invalid_grant|invalid_client|unauthorized_client|invalid_scope/i.test(haystack);
}

/**
 * Refreshes req.tokens when they are expired/near-expiry and persists the
 * result. No-op when the access token is still valid, or when there are no
 * tokens at all. Throws whatever googleapis throws (caller decides how to
 * surface it — see isReauthRequired).
 */
export async function ensureFreshTokens(req: GmailAuthenticatedRequest): Promise<void> {
  if (!req.tokens) {
    return;
  }

  const now = Date.now();
  const expiryDate = req.tokens.expiry_date || 0;
  const shouldRefresh = now >= expiryDate - REFRESH_BUFFER_MS;

  console.log('[GmailTokenRefresh] expiry:', expiryDate, '| now:', now, '| shouldRefresh:', shouldRefresh);

  if (!shouldRefresh) {
    return;
  }

  const refreshedTokens = await authService.refreshAccessToken(req.tokens);
  req.tokens = refreshedTokens;

  if (req.gmailUserId) {
    await gmailTokenDbService.updateTokens(req.gmailUserId, refreshedTokens);
  }
}

export async function gmailTokenRefreshMiddleware(
  req: GmailAuthenticatedRequest,
  _res: Response,
  next: NextFunction
) {
  if (!req.tokens) {
    return next();
  }

  try {
    await ensureFreshTokens(req);
    next();
  } catch (error: any) {
    if (isReauthRequired(error)) {
      console.error('[GmailTokenRefresh] Refresh token revoked/expired — re-auth required:', error.message);
    } else {
      console.error('[GmailTokenRefresh] Token refresh failed:', error.message);
    }
    return _res.status(401).json({ error: 'Token refresh failed, please re-authenticate' });
  }
}
