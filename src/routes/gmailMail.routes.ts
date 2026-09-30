import { Router, Response } from 'express';
import multer from 'multer';
import { GmailAuthenticatedRequest, gmailAuthMiddleware } from '../middleware/gmailAuth.middleware';
import { gmailTokenRefreshMiddleware } from '../middleware/gmailTokenRefresh.middleware';
import { gmailService, SendEmailParams, DraftParams, AttachmentData } from '../services/gmail.service';
import { executeQuery } from '../config/database';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(gmailAuthMiddleware);
router.use(gmailTokenRefreshMiddleware);

router.get('/messages', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { label, pageToken, maxResults, q } = req.query;
    const count = maxResults ? parseInt(maxResults as string) : 50;
    console.log('[Gmail] List messages - access_token present:', !!req.tokens?.access_token,
      '| len:', req.tokens?.access_token?.length,
      '| refresh_token present:', !!req.tokens?.refresh_token,
      '| expiry:', req.tokens?.expiry_date, '| now:', Date.now());
    const result = await gmailService.listMessages(req.tokens!, {
      label: label as string,
      pageToken: pageToken as string,
      maxResults: count,
      q: q as string,
    });

    if (!result.messages || result.messages.length === 0) {
      return res.json({
        messages: [],
        threads: [],
        nextPageToken: null,
        resultSizeEstimate: result.resultSizeEstimate,
      });
    }

    const messages: any[] = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < result.messages.length; i += BATCH_SIZE) {
      const batch = result.messages.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(
        batch.map(async (msg: any) => {
          try {
            return await gmailService.getMessageMetadata(req.tokens!, msg.id);
          } catch (e: any) {
            console.error(`Failed to fetch metadata for ${msg.id}:`, e.message);
            return null;
          }
        })
      );
      messages.push(...fetched.filter(Boolean));
    }

    const threadMap = new Map<string, any>();
    // Messages arrive newest-first from Gmail. A thread row must reflect the
    // LATEST message's state: previously any read message in the thread made
    // the whole row read, which inflated the read count and desynced from
    // Gmail's unread badge (issue 1).
    for (const msg of messages) {
      const tid = msg.threadId || msg.id;
      const existing = threadMap.get(tid);
      if (!existing) {
        threadMap.set(tid, {
          ...msg,
          threadId: tid,
          threadMessageCount: 1,
          participantEmails: [msg.from?.email].filter(Boolean),
        });
      } else {
        existing.threadMessageCount = (existing.threadMessageCount || 1) + 1;
        if (msg.from?.email && !existing.participantEmails.includes(msg.from.email)) {
          existing.participantEmails.push(msg.from.email);
        }
        // older message: only fill fields the newest row lacks
        if (!existing.snippet && msg.snippet) existing.snippet = msg.snippet;
        if (msg.hasAttachments) existing.hasAttachments = true;
      }
    }

    const threads = Array.from(threadMap.values());

    res.json({
      messages,
      threads,
      nextPageToken: result.nextPageToken,
      resultSizeEstimate: result.resultSizeEstimate,
    });
  } catch (error: any) {
    console.error('List messages error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/messages/:id', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const message = await gmailService.getMessage(req.tokens!, req.params.id);
    res.json(message);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/messages/:messageId/attachments/:attachmentId', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const data = await gmailService.getAttachment(
      req.tokens!,
      req.params.messageId,
      req.params.attachmentId
    );    const buffer = Buffer.from(data.data, 'base64url');
    const mimeType = data.mimeType || 'application/octet-stream';
    const filename = (req.query.filename as string) || 'attachment';
    // ?mode=inline streams for in-browser preview; default keeps downloading.
    const inline = (req.query.mode as string) === 'inline';
    const safeName = filename.replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    res.setHeader('Content-Length', buffer.length);
    // Let the browser read the filename header cross-origin.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length');
    res.send(buffer);
  } catch (error: any) {
    // Expired/revoked Google token must surface as 401 (not 500) so the UI
    // can offer "Reconnect Gmail" instead of a generic download failure.
    const msg = error?.message || '';
    const authError = /invalid_grant|Invalid Credentials|invalid credentials|expired|401|Unauthorized/i.test(msg);
    console.error('Attachment fetch error:', msg);
    res.status(authError ? 401 : 500).json({ error: msg || 'Failed to fetch attachment' });
  }
});

router.get('/contacts', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const contacts = await gmailService.getContacts(req.tokens!, (req.query.q as string) || '');
    res.json({ contacts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// App-user suggestions for the compose To/Cc/Bcc autocomplete. Same
// {name,email} shape as /contacts; merges app users (by name/email match)
// with Gmail-sourced contacts.
router.get('/users', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const term = ((req.query.q as string) || '').trim();
    const gmailContacts = await gmailService.getContacts(req.tokens!, term);
    let appUsers: { name: string; email: string; source?: string }[] = [];
    try {
      if (term.length >= 2) {
        const like = `%${term}%`;
        const rows = await executeQuery<any>(
          `SELECT TOP 10
             COALESCE(NULLIF(LTRIM(RTRIM(u.cuser_name)), ''), CONCAT(u.cfirst_name, ' ', u.clast_name), u.cfirst_name) as name,
             u.cemail as email
           FROM users u
           WHERE u.cemail IS NOT NULL AND u.cemail <> ''
             AND (u.cuser_name LIKE @like OR u.cfirst_name LIKE @like
                  OR u.clast_name LIKE @like OR u.cemail LIKE @like)
           ORDER BY u.cuser_name`,
          { like }
        );
        appUsers = (rows || [])
          .filter((r: any) => r.email && r.email.includes('@'))
          .map((r: any) => ({ name: (r.name || '').trim() || r.email, email: r.email, source: 'app' }));
      }
    } catch (dbErr: any) {
      console.error('[Gmail] app-user suggestion lookup failed:', dbErr.message);
    }
    const seen = new Set(appUsers.map((u) => u.email.toLowerCase()));
    const merged = [...appUsers, ...gmailContacts.filter((c: any) => !seen.has(c.email.toLowerCase()))].slice(0, 10);
    res.json({ contacts: merged });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/folder-counts', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const result = await gmailService.getFolderCounts(req.tokens!);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/drafts', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const drafts = await gmailService.getDrafts(req.tokens!);
    res.json({ drafts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/drafts/:id/send', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const result = await gmailService.sendDraft(req.tokens!, req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/messages/:id/raw', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const message = await gmailService.getRawMessage(req.tokens!, req.params.id);
    res.json(message);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/send', upload.array('attachments'), async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { to, cc, bcc, subject, body, html, threadId, inReplyTo } = req.body;
    const parsedTo = typeof to === 'string' ? to.split(',').map((s: string) => s.trim()) : to || [];
    const parsedCc = typeof cc === 'string' ? cc.split(',').map((s: string) => s.trim()) : cc || [];
    const parsedBcc = typeof bcc === 'string' ? bcc.split(',').map((s: string) => s.trim()) : bcc || [];

    const attachments = (req.files as Express.Multer.File[])?.map((file) => ({
      filename: file.originalname,
      mimeType: file.mimetype,
      data: file.buffer.toString('base64'),
    })) || [];

    const params: SendEmailParams = {
      to: parsedTo,
      cc: parsedCc,
      bcc: parsedBcc,
      subject: subject || '',
      body: body || '',
      html,
      threadId,
      inReplyTo,
      attachments,
    };

    const result = await gmailService.sendMessage(req.tokens!, params);
    res.json(result);
  } catch (error: any) {
    console.error('Send message error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Drafts accept either JSON (no files) or multipart/form-data with flat
// fields (to/cc/bcc/subject/body/html/threadId/draftId) + `attachments`
// files, so newly-picked files actually reach Gmail (issue: saved draft
// images not loading).
function draftAttachments(req: GmailAuthenticatedRequest) {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  return files.map((file) => ({
    filename: file.originalname,
    mimeType: file.mimetype,
    data: file.buffer.toString('base64'),
  }));
}

router.post('/messages/draft', upload.array('attachments'), async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const body: any = req.body || {};
    const { to, cc, bcc, subject, body: textBody, html, threadId, inReplyTo, draftId, keepAttachments } = body;
    const parsedTo = typeof to === 'string' ? to.split(',').map((s: string) => s.trim()) : to || [];
    const parsedCc = typeof cc === 'string' ? cc.split(',').map((s: string) => s.trim()) : cc || [];
    const parsedBcc = typeof bcc === 'string' ? bcc.split(',').map((s: string) => s.trim()) : bcc || [];

    // Attachments already stored on the draft being re-saved must be fetched
    // and re-included — Gmail's drafts.update replaces the whole message.
    // Each kept attachment carries the draft's underlying message id.
    const kept: AttachmentData[] = [];
    const keepList: any[] = Array.isArray(keepAttachments) ? keepAttachments : [];
    if (keepList.length > 0) {
      for (const k of keepList) {
        if (!k?.messageId || !k?.attachmentId) continue;
        try {
          const data = await gmailService.getAttachment(req.tokens!, k.messageId, k.attachmentId);
          kept.push({ filename: k.filename, mimeType: k.mimeType, data: data.data });
        } catch (e: any) {
          console.error(`Keep-attachment ${k.attachmentId} failed:`, e.message);
        }
      }
    }

    const params: DraftParams = {
      to: parsedTo,
      cc: parsedCc,
      bcc: parsedBcc,
      subject: subject || '',
      body: textBody || '',
      html,
      threadId,
      inReplyTo,
      attachments: [...kept, ...draftAttachments(req)],
      draftId,
    };

    const result = await gmailService.createDraft(req.tokens!, params);
    res.json(result);
  } catch (error: any) {
    console.error('Draft error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/messages/draft/:id', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.deleteDraft(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/trash', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const result = await gmailService.trashMessage(req.tokens!, req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/untrash', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const result = await gmailService.untrashMessage(req.tokens!, req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/messages/:id', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.deleteMessage(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/read', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.markAsRead(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/unread', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.markAsUnread(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/spam', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.markAsSpam(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/notspam', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.markAsNotSpam(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/star', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.starMessage(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/:id/unstar', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    await gmailService.unstarMessage(req.tokens!, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/threads/:id', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const messages = await gmailService.getThreadMessages(req.tokens!, req.params.id);
    res.json({ threadId: req.params.id, messages });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/batch-read', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { messageIds } = req.body;
    await gmailService.batchModify(req.tokens!, messageIds, [], ['UNREAD']);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/batch-unread', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { messageIds } = req.body;
    await gmailService.batchModify(req.tokens!, messageIds, ['UNREAD'], []);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/batch-trash', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { messageIds } = req.body;
    await gmailService.batchTrash(req.tokens!, messageIds);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/messages/batch-delete', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { messageIds } = req.body;
    await gmailService.batchDelete(req.tokens!, messageIds);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
