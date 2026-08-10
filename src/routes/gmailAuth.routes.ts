import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authService } from '../services/auth.service';
import { gmailTokenDbService } from '../services/gmailTokenDb.service';
import { GmailAuthenticatedRequest, setGmailUserCookie, clearGmailUserCookie, gmailAuthMiddleware } from '../middleware/gmailAuth.middleware';

const router = Router();
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';

const getFrontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/+$/, '');

const redirectToFrontend = (res: Response, query: string) => {
  const url = `${getFrontendUrl()}/#/user/email?${query}`;
  console.log('[GmailAuth] Redirecting to frontend:', url);
  return res.redirect(url);
};

router.get('/google', (req, res) => {
  try {
    const userId = req.query.cuserid as string;
    if (!userId) {
      return res.status(400).json({ error: 'cuserid is required' });
    }

    const state = jwt.sign({ uid: userId }, SESSION_SECRET, { expiresIn: '10m' });
    const url = authService.getAuthUrl(state);
    console.log('[GmailAuth] Generated OAuth URL for user:', userId);
    res.json({ url });
  } catch (error: any) {
    console.error('[GmailAuth] Failed to generate OAuth URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/google/callback', async (req, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const errorParam = req.query.error as string;

  console.log('[GmailAuth] Callback hit - query:', JSON.stringify({ code: code ? 'present' : 'missing', state: state ? 'present' : 'missing', error: errorParam }));

  if (errorParam) {
    console.error('[GmailAuth] OAuth error from Google:', errorParam);
    return redirectToFrontend(res, `auth=error&message=${encodeURIComponent(errorParam)}`);
  }

  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  let userId = '';
  if (state) {
    try {
      const decoded = jwt.verify(state, SESSION_SECRET) as { uid: string };
      userId = decoded.uid;
    } catch {
      console.error('[GmailAuth] Invalid or expired state token');
    }
  }

  try {
    console.log('[GmailAuth] Exchanging authorization code for tokens...');
    const tokens = await authService.getTokensFromCode(code);
    console.log('[GmailAuth] Tokens received, fetching user profile...');
    const userProfile = await authService.getUserProfile(tokens);
    console.log('[GmailAuth] User:', userProfile.email);

    if (userId) {
      await gmailTokenDbService.saveTokens(userId, tokens, userProfile.email);
      console.log('[GmailAuth] Tokens saved to DB for user:', userId);
      setGmailUserCookie(res, userId);
    }

    redirectToFrontend(res, 'auth=success');
  } catch (error: any) {
    console.error('[GmailAuth] OAuth callback error:', error.message);
    redirectToFrontend(res, `auth=error&message=${encodeURIComponent(error.message)}`);
  }
});

router.get('/status', gmailAuthMiddleware, async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const userEmail = await gmailTokenDbService.getUserEmail(req.gmailUserId!);
    res.json({
      authenticated: true,
      user: { email: userEmail || '' }
    });
  } catch (error: any) {
    console.error('[GmailAuth] Status check failed:', error.message);
    res.json({ authenticated: false });
  }
});

router.post('/logout', (req: GmailAuthenticatedRequest, res: Response) => {
  clearGmailUserCookie(res);
  res.json({ success: true });
});

export default router;
