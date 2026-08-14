import nodemailer from 'nodemailer';

/**
 * Mail service for sending meeting invite emails.
 *
 * Configuration (via .env):
 *   EMAIL_ENABLED   - must be 'true' to actually deliver emails
 *   SMTP_HOST       - smtp server host
 *   SMTP_PORT       - smtp port (default 587)
 *   SMTP_SECURE     - 'true' for SSL/TLS (465), default false (STARTTLS)
 *   SMTP_USER       - smtp username
 *   SMTP_PASS       - smtp password / app password
 *   MAIL_FROM       - from address (default no-reply@progovex.com)
 *   MAIL_FROM_NAME  - from display name (default "Progovex Meetings")
 *   MAIL_LOGO_URL   - absolute url of the app logo shown in the email
 *   MAIL_APP_NAME   - app name shown in the email (default "Progovex Meet")
 */

function frontendUrl(): string {
    return process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:4200';
}

function appName(): string {
    return process.env.MAIL_APP_NAME || 'Progovex Meet';
}

function logoUrl(): string {
    return process.env.MAIL_LOGO_URL || `${frontendUrl()}/assets/images/logos/logo.png`;
}

function emailEnabled(): boolean {
    return process.env.EMAIL_ENABLED === 'true' && !!process.env.SMTP_HOST;
}

function getTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        tls: { rejectUnauthorized: false }
    });
}

function escapeHtml(value: any): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatMeetingDateTime(value: any): string {
    if (!value) return 'On demand';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

export interface MeetingInviteMailData {
    to: string;
    toName?: string;
    title: string;
    hostName: string;
    dateTimeLabel: string;
    meetingCode: string;
    meetingPassword?: string;
    inviteLink: string;
    description?: string;
}

export function buildMeetingInviteHtml(data: Omit<MeetingInviteMailData, 'to' | 'toName'>): string {
    const app = escapeHtml(appName());
    const logo = escapeHtml(logoUrl());
    const title = escapeHtml(data.title);
    const hostName = escapeHtml(data.hostName || 'the host');
    const dateTimeLabel = escapeHtml(data.dateTimeLabel);
    const meetingCode = escapeHtml(data.meetingCode);
    const meetingPassword = data.meetingPassword ? escapeHtml(data.meetingPassword) : '';
    const inviteLink = escapeHtml(data.inviteLink);
    const description = data.description ? escapeHtml(data.description) : '';

    const passwordRow = meetingPassword
        ? `<tr>
                <td style="padding:8px 0;font-size:13px;color:#5f6368;white-space:nowrap;vertical-align:top;">Password</td>
                <td style="padding:8px 0 8px 24px;font-size:13px;color:#1f1f1f;font-weight:600;">${meetingPassword}</td>
           </tr>`
        : '';

    const descriptionRow = description
        ? `<tr>
                <td style="padding:8px 0;font-size:13px;color:#5f6368;white-space:nowrap;vertical-align:top;">Description</td>
                <td style="padding:8px 0 8px 24px;font-size:13px;color:#3c4043;">${description}</td>
           </tr>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f5f6f8;font-family:Roboto,Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f6f8;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #e4e7ec;overflow:hidden;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding:28px 24px 10px;">
              <img src="${logo}" alt="${app}" width="140" style="display:block;max-height:52px;border:0;" />
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td align="center" style="padding:10px 24px 4px;">
              <h1 style="margin:0;font-size:21px;line-height:1.3;color:#1f1f1f;font-weight:700;">You're invited to</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 24px 22px;">
              <p style="margin:0;font-size:19px;line-height:1.3;color:#1a73e8;font-weight:700;">${title}</p>
            </td>
          </tr>

          <!-- Join card -->
          <tr>
            <td style="padding:0 24px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4ff;border:1px solid #d3e3fd;border-radius:10px;">
                <tr>
                  <td style="padding:20px 20px 16px;">
                    <p style="margin:0 0 6px;font-size:14px;color:#5f6368;">Join with <span style="font-weight:700;color:#1f1f1f;">${app}</span></p>
                    <a href="${inviteLink}" style="display:inline-block;background:#1a73e8;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:12px 30px;border-radius:6px;">Join now</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 20px 20px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#5f6368;">Meeting link</p>
                    <a href="${inviteLink}" style="font-size:14px;color:#1a73e8;text-decoration:none;word-break:break-all;">${inviteLink}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Meeting details -->
          <tr>
            <td style="padding:0 24px 10px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;font-size:13px;color:#5f6368;white-space:nowrap;vertical-align:top;">Date &amp; time</td>
                  <td style="padding:8px 0 8px 24px;font-size:13px;color:#1f1f1f;font-weight:600;">${dateTimeLabel}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-size:13px;color:#5f6368;white-space:nowrap;vertical-align:top;">Host</td>
                  <td style="padding:8px 0 8px 24px;font-size:13px;color:#3c4043;">${hostName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-size:13px;color:#5f6368;white-space:nowrap;vertical-align:top;">Meeting ID</td>
                  <td style="padding:8px 0 8px 24px;font-size:13px;color:#1f1f1f;font-weight:600;">${meetingCode}</td>
                </tr>
                ${passwordRow}
                ${descriptionRow}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:18px 24px;background:#fafafa;border-top:1px solid #eceff3;">
              <p style="margin:0;font-size:12px;color:#9aa0a6;line-height:1.5;">
                You were invited to this meeting by <span style="font-weight:600;color:#5f6368;">${hostName}</span>.<br />
                Open the link above to join with ${app}.
              </p>
              <p style="margin:8px 0 0;font-size:12px;color:#b0b6bd;">Powered by ${app}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendMeetingInviteEmail(data: MeetingInviteMailData): Promise<any> {
    const to = String(data.to || '').trim();
    if (!to) return { success: false, skipped: true, reason: 'no recipient email' };

    if (!emailEnabled()) {
        console.log(
            `[Mail] Invite email skipped -> ${to} (subject: "You're invited: ${data.title}"). ` +
            `Set EMAIL_ENABLED=true and configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in .env to send.`
        );
        return { success: true, skipped: true };
    }

    const subject = `You're invited: ${data.title}`;
    const html = buildMeetingInviteHtml(data);

    const transporter = getTransporter();

    try {
        await transporter.sendMail({
            from: `"${process.env.MAIL_FROM_NAME || 'Progovex Meetings'}" <${process.env.MAIL_FROM || 'no-reply@progovex.com'}>`,
            to: data.toName ? `"${data.toName}" <${to}>` : to,
            subject,
            html
        });
        console.log(`[Mail] Invite email sent to ${to}`);
        return { success: true };
    } catch (error: any) {
        console.error(`[Mail] Failed to send invite email to ${to}:`, error.message);
        return { success: false, error: error.message };
    }
}
