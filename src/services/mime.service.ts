import { SendEmailParams, AttachmentData } from './gmail.service';

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateBoundary(): string {
  return `----=_Part_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function buildMimeMessage(params: SendEmailParams): Promise<string> {
  const boundary = generateBoundary();
  const lines: string[] = [];

  // Headers
  lines.push(`From: me`);
  lines.push(`To: ${params.to.join(', ')}`);
  if (params.cc && params.cc.length > 0) {
    lines.push(`Cc: ${params.cc.join(', ')}`);
  }
  if (params.bcc && params.bcc.length > 0) {
    lines.push(`Bcc: ${params.bcc.join(', ')}`);
  }
  lines.push(`Subject: ${params.subject}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${Date.now()}.${Math.random().toString(36).substr(2, 9)}@gmail-clone>`);

  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${params.inReplyTo}`);
    lines.push(`References: ${params.inReplyTo}`);
  }

  const hasAttachments = params.attachments && params.attachments.length > 0;

  if (hasAttachments || params.html) {
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);

    // Body part
    if (params.html) {
      lines.push(`Content-Type: multipart/alternative; boundary="${boundary}_alt"`);
      lines.push('');
      lines.push(`--${boundary}_alt`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(params.body);
      lines.push('');
      lines.push(`--${boundary}_alt`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(params.html);
      lines.push('');
      lines.push(`--${boundary}_alt--`);
    } else {
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(params.body);
    }

    lines.push('');
    lines.push(`--${boundary}`);

    // Attachments
    if (params.attachments) {
      for (const attachment of params.attachments) {
        lines.push(`Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`);
        lines.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
        lines.push(`Content-Transfer-Encoding: base64`);
        lines.push('');
        lines.push(encodeBase64Wrap(attachment.data));
        lines.push('');
        lines.push(`--${boundary}`);
      }
    }
  } else {
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push('');
    lines.push(params.body);
  }

  return base64UrlEncode(lines.join('\r\n'));
}

function encodeBase64Wrap(base64Data: string): string {
  const clean = base64Data.replace(/[^A-Za-z0-9+/=]/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 76) {
    lines.push(clean.substring(i, i + 76));
  }
  return lines.join('\r\n');
}
