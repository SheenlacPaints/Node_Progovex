import { Router, Response } from 'express';
import multer from 'multer';
import { GmailAuthenticatedRequest, gmailAuthMiddleware } from '../middleware/gmailAuth.middleware';
import { gmailTokenRefreshMiddleware } from '../middleware/gmailTokenRefresh.middleware';
import { gmailService, SendEmailParams, DraftParams } from '../services/gmail.service';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(gmailAuthMiddleware);
router.use(gmailTokenRefreshMiddleware);

router.get('/messages', async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { label, pageToken, maxResults, q } = req.query;
    const count = maxResults ? parseInt(maxResults as string) : 50;
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
        if (!existing.isRead && msg.isRead) {
          existing.isRead = msg.isRead;
        }
        if (msg.isStarred) {
          existing.isStarred = true;
        }
        if (msg.hasAttachments) {
          existing.hasAttachments = true;
        }
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
    );
    const buffer = Buffer.from(data.data, 'base64url');
    const mimeType = data.mimeType || 'application/octet-stream';
    const filename = (req.query.filename as string) || 'attachment';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
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

router.post('/messages/draft', upload.array('attachments'), async (req: GmailAuthenticatedRequest, res: Response) => {
  try {
    const { to, cc, bcc, subject, body, html, threadId, inReplyTo, draftId } = req.body;
    const parsedTo = typeof to === 'string' ? to.split(',').map((s: string) => s.trim()) : to || [];
    const parsedCc = typeof cc === 'string' ? cc.split(',').map((s: string) => s.trim()) : cc || [];
    const parsedBcc = typeof bcc === 'string' ? bcc.split(',').map((s: string) => s.trim()) : bcc || [];

    const attachments = (req.files as Express.Multer.File[])?.map((file) => ({
      filename: file.originalname,
      mimeType: file.mimetype,
      data: file.buffer.toString('base64'),
    })) || [];

    const params: DraftParams = {
      to: parsedTo,
      cc: parsedCc,
      bcc: parsedBcc,
      subject: subject || '',
      body: body || '',
      html,
      threadId,
      inReplyTo,
      attachments,
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
