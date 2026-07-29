// backend/src/workers/emailWorker.ts
// Minimal stub - SMTP email sending placeholder
// Original used Bull/Redis queue; kept as no-op since EMAIL_ENABLED=false

export async function sendEmail(
    to: string,
    subject: string,
    template: string,
    data: Record<string, any> = {}
): Promise<any> {
    if (process.env.EMAIL_ENABLED !== 'true') {
        console.log(`[EmailWorker] Email disabled, skipping: ${subject} -> ${to}`);
        return { success: true, skipped: true };
    }
    console.log(`[EmailWorker] sendEmail called: ${subject} -> ${to} (template: ${template})`);
    return { success: true };
}
