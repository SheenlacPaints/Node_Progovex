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

// RFC 2045 quoted-printable encoder. Previously the MIME declared
// "Content-Transfer-Encoding: quoted-printable" but pushed the raw text,
// so Gmail truncated long bodies (drafts showed only the first line/point).
function encodeQpLine(line: string): string {
  const bytes = Buffer.from(line, 'utf-8');
  let out = '';
  let lineLength = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const isLastByte = i === bytes.length - 1;
    let token: string;
    if ((byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9) {
      // trailing WSP must be encoded per RFC 2045
      if (isLastByte && (byte === 32 || byte === 9)) {
        token = '=' + byte.toString(16).toUpperCase().padStart(2, '0');
      } else {
        token = String.fromCharCode(byte);
      }
    } else {
      token = '=' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    if (lineLength + token.length > 75) {
      out += '=\r\n'; // soft line break
      lineLength = 0;
    }
    out += token;
    lineLength += token.length;
  }
  return out;
}

function encodeQuotedPrintable(text: string): string {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map(encodeQpLine)
    .join('\r\n');
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
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Message-ID: <${Date.now()}.${Math.random().toString(36).substr(2, 9)}@gmail-clone>`);

  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${params.inReplyTo}`);
    lines.push(`References: ${params.inReplyTo}`);
  }

  const hasAttachments = params.attachments && params.attachments.length > 0;

  if (hasAttachments || params.html) {
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
      lines.push(encodeQuotedPrintable(params.body));
      lines.push('');
      lines.push(`--${boundary}_alt`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(encodeQuotedPrintable(params.html));
      lines.push('');
      lines.push(`--${boundary}_alt--`);
    } else {
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: quoted-printable`);
      lines.push('');
      lines.push(encodeQuotedPrintable(params.body));
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
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push('');
    lines.push(encodeQuotedPrintable(params.body));
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
