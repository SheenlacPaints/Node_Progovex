import { google } from 'googleapis';
import { OAuthTokens, AuthService, authService } from './auth.service';
import { buildMimeMessage } from './mime.service';

export interface MessageListParams {
  label?: string;
  pageToken?: string;
  maxResults?: number;
  q?: string;
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
    const response = await gmail.users.messages.list({
      userId: 'me',
      labelIds: params.label ? [params.label] : undefined,
      pageToken: params.pageToken || undefined,
      maxResults: params.maxResults || 50,
      q: params.q || undefined,
    });
    return {
      messages: response.data.messages || [],
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
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
      metadataHeaders: ['From', 'Subject', 'Date', 'To', 'Cc'],
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

    const labelIds: string[] = msg.labelIds || [];
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

    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds,
      from,
      to,
      cc,
      subject: this.decodeHtmlEntities(getHeader('Subject')),
      snippet: this.decodeHtmlEntities(msg.snippet || ''),
      body,
      date: getHeader('Date') || new Date(parseInt(msg.internalDate || '0')).toISOString(),
      isRead: !labelIds.includes('UNREAD'),
      isStarred: labelIds.includes('STARRED'),
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
