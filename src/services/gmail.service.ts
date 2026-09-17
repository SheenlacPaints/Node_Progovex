import { google } from 'googleapis';
import { OAuthTokens, AuthService, authService } from './auth.service';
import { buildMimeMessage } from './mime.service';

export interface MessageListParams {
  label?: string;
  pageToken?: string;
  maxResults?: number;
  q?: string;
}

// Gmail filters like is:unread / is:starred / label:work arrive as `q`.
// Gmail's messages.list applies `q` only when it is the sole filter with
// labelIds undefined, so split them apart here.
function splitQueryFilters(q?: string): { labelIds?: string[]; query?: string } {
  if (!q) return { query: undefined };
  const labelMatches = [...q.matchAll(/(?:^|\s)(?:label|in):([\w./-]+)/gi)];
  const labelIds = labelMatches.map(m => m[1].toUpperCase());
  const rest = q
    .replace(/(?:^|\s)(?:label|in):([\w./-]+)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { labelIds: labelIds.length ? labelIds : undefined, query: rest || undefined };
}

export interface SendEmailParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html?: string;
  threadId?: string;
  inReplyTo?: string;
  attachments?: AttachmentData[];
}

export interface DraftParams extends SendEmailParams {
  draftId?: string;
}

export interface AttachmentData {
  filename: string;
  mimeType: string;
  data: string; // base64 encoded
}

export class GmailService {
  private getGmailClient(tokens: OAuthTokens): any {
    const authClient = authService.createClientWithTokens(tokens);
    const authorization = `Bearer ${tokens.access_token}`;

    console.log('[Gmail] getGmailClient - googleapis:', require('googleapis/package.json').version,
      '| token present:', !!tokens.access_token, '| auth header len:', authorization.length);

    const transporter = authClient.transporter;
    const originalTransporterRequest = transporter.request.bind(transporter);
    transporter.request = (opts: any, callback?: any) => {
      if (opts && opts.headers) {
        try {
          if (typeof opts.headers.set === 'function') {
            opts.headers.set('Authorization', authorization);
          } else {
            opts.headers.Authorization = authorization;
          }
        } catch (err) {
          // ignore header-set failures
        }
      }
      const logHeaders: any = {};
      if (opts?.headers) {
        if (typeof opts.headers.entries === 'function') {
          for (const [k, v] of opts.headers.entries()) logHeaders[k] = v;
        } else {
          Object.assign(logHeaders, opts.headers);
        }
      }
      console.log('[Gmail] TRANSPORTER headers:', JSON.stringify(logHeaders));
      return originalTransporterRequest(opts, callback);
    };

    authClient.getRequestHeaders = async () => ({ Authorization: authorization });

    const originalRequest = authClient.request.bind(authClient);
    authClient.request = (opts: any, callback?: any) => {
      const headers: any = { ...(opts?.headers || {}) };
      headers.Authorization = authorization;
      return originalRequest({ ...opts, headers }, callback);
    };

    return google.gmail({ version: 'v1', auth: authClient });
  }

  async listMessages(tokens: OAuthTokens, params: MessageListParams) {
    const gmail = this.getGmailClient(tokens);
    const { labelIds: filterLabelIds, query } = splitQueryFilters(params.q);
    const labelIds = params.label ? [params.label] : filterLabelIds;
    // Keep listing pages until we have enough THREADS (maxResults), because
    // Gmail counts messages while the UI shows one row per thread. Threads
    // are detected by threadId, so a page of 50 messages may only be ~20
    // rows — exactly the "pagination shows few mails" bug.
    const wanted = params.maxResults || 50;
    const seenThreadIds = new Set<string>();
    const collected: any[] = [];
    let pageToken: string | undefined = params.pageToken || undefined;
    let resultSizeEstimate = 0;
    let guard = 0;
    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        labelIds,
        pageToken,
        maxResults: wanted,
        q: query || undefined,
      });
      const messages = response.data.messages || [];
      resultSizeEstimate = response.data.resultSizeEstimate || resultSizeEstimate;
      for (const m of messages) {
        const tid = m.threadId || m.id;
        if (seenThreadIds.has(tid)) continue;
        seenThreadIds.add(tid);
        collected.push(m);
      }
      pageToken = response.data.nextPageToken || undefined;
      guard++;
    } while (pageToken && collected.length < wanted && guard < 5);
    return {
      messages: collected,
      nextPageToken: collected.length >= wanted ? pageToken || null : null,
      resultSizeEstimate,
    };
  }

  async getMessage(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return this.normalizeMessage(response.data);
  }

  // Autocomplete source: harvest unique Name <email> pairs from recent
  // From/To/Cc headers. Cheap (metadata only) and needs no extra Google API
  // scope. filterEmails-like `term` matches name or address substring.
  async getContacts(tokens: OAuthTokens, term: string = '') {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.list({ userId: 'me', maxResults: 100 });
    const ids = (response.data.messages || []).slice(0, 100).map((m: any) => m.id);
    const people = new Map<string, { name: string; email: string }>();
    const lowerTerm = (term || '').toLowerCase().trim();
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const metas = await Promise.all(
        batch.map((id: string) =>
          gmail.users.messages
            .get({
              userId: 'me',
              id,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc'],
            })
            .then((r: any) => r.data)
            .catch(() => null)
        )
      );
      for (const meta of metas) {
        if (!meta) continue;
        const headers: any[] = meta.payload?.headers || [];
        for (const h of headers) {
          const value = h.value || '';
          // Parse "Name <a@b.c>" as well as bare addresses
          const re = /\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*|\s*([^\s<>,;@"]+@[^\s<>,;;"]+)\s*/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(value)) !== null) {
            const name = (m[1] || '').trim();
            const email = (m[2] || m[3] || '').trim().toLowerCase();
            if (!email || !email.includes('@')) continue;
            const existing = people.get(email);
            if (!existing) {
              people.set(email, { name: name || email, email });
            } else if (!existing.name && name) {
              existing.name = name;
            }
          }
        }
      }
    }
    let list = Array.from(people.values());
    if (lowerTerm) {
      list = list.filter(
        p => p.email.includes(lowerTerm) || (p.name || '').toLowerCase().includes(lowerTerm)
      );
    }
    return list.slice(0, 10);
  }

  // Real per-folder counts for the sidebar. Gmail's list API returns
  // resultSizeEstimate without needing to fetch the messages themselves.
  async getFolderCounts(tokens: OAuthTokens) {
    const gmail = this.getGmailClient(tokens);
    const folders: Record<string, string> = {
      inbox: 'INBOX',
      sent: 'SENT',
      drafts: 'DRAFT',
      trash: 'TRASH',
      spam: 'SPAM',
    };
    const counts: Record<string, number> = {};
    const unread: Record<string, number> = {};
    await Promise.all(
      Object.entries(folders).map(async ([folder, label]) => {
        try {
          const total = await gmail.users.messages.list({ userId: 'me', labelIds: [label], maxResults: 1 });
          counts[folder] = total.data.resultSizeEstimate || 0;
          if (folder === 'inbox' || folder === 'spam') {
            const unreadRes = await gmail.users.messages.list({ userId: 'me', labelIds: [label, 'UNREAD'], maxResults: 1 });
            unread[folder] = unreadRes.data.resultSizeEstimate || 0;
          }
        } catch (e: any) {
          console.error(`Count for ${folder} failed:`, e.message);
          counts[folder] = 0;
        }
      })
    );
    return { counts, unread };
  }

  async getAttachment(tokens: OAuthTokens, messageId: string, attachmentId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    return response.data;
  }

  async getMessageMetadata(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'To', 'Cc', 'Bcc'],
    });
    return this.normalizeMessage(response.data);
  }

  private decodeHtmlEntities(text: string): string {
    if (!text) return text;
    return text
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  private normalizeMessage(msg: any) {
    const headers: { name: string; value: string }[] = msg.payload?.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const fromRaw = getHeader('From');
    const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
    const from = fromMatch
      ? { name: fromMatch[1].replace(/"/g, '').trim(), email: fromMatch[2] }
      : { name: fromRaw, email: fromRaw };

    const toRaw = getHeader('To');
    const to = toRaw ? toRaw.split(',').map((s: string) => s.trim()) : [];

    const ccRaw = getHeader('Cc');
    const cc = ccRaw ? ccRaw.split(',').map((s: string) => s.trim()) : [];

    const bccRaw = getHeader('Bcc');
    const bcc = bccRaw ? bccRaw.split(',').map((s: string) => s.trim()) : [];

    const labelIds: string[] = msg.labelIds || [];
    const isFromMe = labelIds.includes('SENT');
    const hasAttachments = labelIds.includes('HAS_ATTACHMENTS') || (msg.payload?.parts || []).length > 1;

    let body = msg.snippet || '';
    if (msg.payload?.body?.data) {
      body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
    } else if (msg.payload?.parts) {
      const textPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/plain');
      const htmlPart = msg.payload.parts.find((p: any) => p.mimeType === 'text/html');
      const part = textPart || htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }

    const attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[] = [];
    if (msg.payload?.parts) {
      for (const part of msg.payload.parts) {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType || 'application/octet-stream',
            size: part.body.size || 0,
            attachmentId: part.body.attachmentId,
          });
        }
        if (part.parts) {
          for (const sub of part.parts) {
            if (sub.filename && sub.body?.attachmentId) {
              attachments.push({
                filename: sub.filename,
                mimeType: sub.mimeType || 'application/octet-stream',
                size: sub.body.size || 0,
                attachmentId: sub.body.attachmentId,
              });
            }
          }
        }
      }
    }

    // Prefer the message's own Date header; fall back to Gmail's internalDate
    // (ms since epoch) so every row always carries a real, exact timestamp.
    const dateHeader = getHeader('Date');
    const internalMs = parseInt(msg.internalDate || '0');
    const dateValue = dateHeader && !isNaN(new Date(dateHeader).getTime())
      ? new Date(dateHeader).toISOString()
      : (internalMs > 0 ? new Date(internalMs).toISOString() : null);

    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds,
      from,
      to,
      cc,
      bcc,
      isFromMe,
      toRecipients: isFromMe ? to : [],
      subject: this.decodeHtmlEntities(getHeader('Subject')),
      snippet: this.decodeHtmlEntities(msg.snippet || ''),
      body,
      date: dateValue,
      isRead: !labelIds.includes('UNREAD'),
      isStarred: labelIds.includes('STARRED'),
      isDraft: labelIds.includes('DRAFT'),
      hasAttachments: attachments.length > 0 || labelIds.includes('HAS_ATTACHMENTS'),
      attachments,
      sizeEstimate: msg.sizeEstimate || 0,
      historyId: msg.historyId,
      internalDate: msg.internalDate,
    };
  }

  async getThreadMessages(tokens: OAuthTokens, threadId: string) {
    const thread = await this.getThread(tokens, threadId);
    if (!thread || !thread.messages) return [];
    return thread.messages.map((msg: any) => this.normalizeMessage(msg));
  }

  async getDrafts(tokens: OAuthTokens, maxResults: number = 50) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.drafts.list({
      userId: 'me',
      maxResults,
    });
    const drafts = response.data.drafts || [];
    const out: any[] = [];
    for (const d of drafts) {
      try {
        const full = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'full' });
        out.push({ draftId: d.id, ...this.normalizeMessage(full.data.message) });
      } catch (e: any) {
        console.error(`Failed to fetch draft ${d.id}:`, e.message);
      }
    }
    return out;
  }

  async sendDraft(tokens: OAuthTokens, draftId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });
    return response.data;
  }

  async getRawMessage(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'raw',
    });
    return response.data;
  }

  async sendMessage(tokens: OAuthTokens, params: SendEmailParams) {
    const gmail = this.getGmailClient(tokens);
    const raw = await buildMimeMessage(params);

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: params.threadId || undefined,
      },
    });
    return response.data;
  }

  async createDraft(tokens: OAuthTokens, params: DraftParams) {
    const gmail = this.getGmailClient(tokens);
    const raw = await buildMimeMessage(params);

    if (params.draftId) {
      const response = await gmail.users.drafts.update({
        userId: 'me',
        id: params.draftId,
        requestBody: {
          id: params.draftId,
          message: { raw },
        },
      });
      return response.data;
    }

    const response = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });
    return response.data;
  }

  async deleteDraft(tokens: OAuthTokens, draftId: string) {
    const gmail = this.getGmailClient(tokens);
    await gmail.users.drafts.delete({
      userId: 'me',
      id: draftId,
    });
  }

  async trashMessage(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.trash({
      userId: 'me',
      id: messageId,
    });
    return response.data;
  }

  async untrashMessage(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.untrash({
      userId: 'me',
      id: messageId,
    });
    return response.data;
  }

  async deleteMessage(tokens: OAuthTokens, messageId: string) {
    const gmail = this.getGmailClient(tokens);
    await gmail.users.messages.delete({
      userId: 'me',
      id: messageId,
    });
  }

  async modifyLabels(
    tokens: OAuthTokens,
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[]
  ) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });
    return response.data;
  }

  async markAsRead(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, [], ['UNREAD']);
  }

  async markAsUnread(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, ['UNREAD'], []);
  }

  async markAsSpam(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, ['SPAM'], ['INBOX']);
  }

  async markAsNotSpam(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, ['INBOX'], ['SPAM']);
  }

  async starMessage(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, ['STARRED'], []);
  }

  async unstarMessage(tokens: OAuthTokens, messageId: string) {
    return this.modifyLabels(tokens, messageId, [], ['STARRED']);
  }

  async listLabels(tokens: OAuthTokens) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.labels.list({
      userId: 'me',
    });
    return response.data.labels || [];
  }

  async getThread(tokens: OAuthTokens, threadId: string) {
    const gmail = this.getGmailClient(tokens);
    const response = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });
    return response.data;
  }

  async batchModify(
    tokens: OAuthTokens,
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[]
  ) {
    const gmail = this.getGmailClient(tokens);
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: messageIds,
        addLabelIds,
        removeLabelIds,
      },
    });
  }

  async batchTrash(tokens: OAuthTokens, messageIds: string[]) {
    const gmail = this.getGmailClient(tokens);
    for (const id of messageIds) {
      await gmail.users.messages.trash({ userId: 'me', id });
    }
  }

  async batchDelete(tokens: OAuthTokens, messageIds: string[]) {
    const gmail = this.getGmailClient(tokens);
    await gmail.users.messages.batchDelete({
      userId: 'me',
      requestBody: {
        ids: messageIds,
      },
    });
  }
}

export const gmailService = new GmailService();
