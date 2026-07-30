import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { s3Helper } from '../helpers/s3.helper';
import { MeetingDbService } from '../services/meetingDb.service';
import multer from 'multer';

const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only images are allowed for meeting banners/logos'));
        }
    },
});

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

router.post(
    '/banner',
    (req: any, res: any, next: any) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }
        next();
    },
    upload.single('banner'),
    async (req: AuthRequest, res: Response): Promise<void> => {
        try {
            const file = req.file;
            if (!file) {
                res.status(400).json({ success: false, message: 'No file uploaded' }); return;
            }

            const ext = file.originalname.split('.').pop() || 'jpg';
            const fileName = `banner_${Date.now()}.${ext}`;
            const folderPath = `meetings/banners`;

            const result = await s3Helper.uploadFile(file.buffer, {
                folderPath,
                fileName,
                contentType: file.mimetype,
                metadata: {
                    'uploaded-by': String(req.user?.id || 'anonymous'),
                    'type': 'meeting-banner',
                },
            });

            res.json({
                success: true,
                url: result.url,
                key: result.key,
            });
        } catch (error: any) {
            console.error('[MeetingUpload] Banner upload error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.post(
    '/logo',
    (req: any, res: any, next: any) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }
        next();
    },
    upload.single('logo'),
    async (req: AuthRequest, res: Response): Promise<void> => {
        try {
            const file = req.file;
            if (!file) {
                res.status(400).json({ success: false, message: 'No file uploaded' }); return;
            }

            const ext = file.originalname.split('.').pop() || 'png';
            const fileName = `logo_${Date.now()}.${ext}`;
            const folderPath = `meetings/logos`;

            const result = await s3Helper.uploadFile(file.buffer, {
                folderPath,
                fileName,
                contentType: file.mimetype,
                metadata: {
                    'uploaded-by': String(req.user?.id || 'anonymous'),
                    'type': 'meeting-logo',
                },
            });

            res.json({
                success: true,
                url: result.url,
                key: result.key,
            });
        } catch (error: any) {
            console.error('[MeetingUpload] Logo upload error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.put('/:code/banner', upload.single('banner'), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
        if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

        const userId = toInt(req.user?.id || req.user?.cuserid);
        if (toInt(meeting.host_user_id) !== userId) {
            res.status(403).json({ success: false, message: 'Only host can update' }); return;
        }

        const file = req.file;
        if (!file) {
            res.status(400).json({ success: false, message: 'No file uploaded' }); return;
        }

        const ext = file.originalname.split('.').pop() || 'jpg';
        const fileName = `banner_${meeting.id}_${Date.now()}.${ext}`;
        const folderPath = `meetings/banners`;

        const result = await s3Helper.uploadFile(file.buffer, {
            folderPath,
            fileName,
            contentType: file.mimetype,
            metadata: { 'meeting-id': String(meeting.id) },
        });

        await MeetingDbService.updateMeetingFields(meeting.id, { banner_url: result.url });

        res.json({ success: true, url: result.url, key: result.key });
    } catch (error: any) {
        console.error('[MeetingUpload] Banner update error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/:code/logo', upload.single('logo'), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const meeting = await MeetingDbService.getMeetingByCode(req.params.code);
        if (!meeting) { res.status(404).json({ success: false, message: 'Meeting not found' }); return; }

        const userId = toInt(req.user?.id || req.user?.cuserid);
        if (toInt(meeting.host_user_id) !== userId) {
            res.status(403).json({ success: false, message: 'Only host can update' }); return;
        }

        const file = req.file;
        if (!file) {
            res.status(400).json({ success: false, message: 'No file uploaded' }); return;
        }

        const ext = file.originalname.split('.').pop() || 'png';
        const fileName = `logo_${meeting.id}_${Date.now()}.${ext}`;
        const folderPath = `meetings/logos`;

        const result = await s3Helper.uploadFile(file.buffer, {
            folderPath,
            fileName,
            contentType: file.mimetype,
            metadata: { 'meeting-id': String(meeting.id) },
        });

        await MeetingDbService.updateMeetingFields(meeting.id, { logo_url: result.url });

        res.json({ success: true, url: result.url, key: result.key });
    } catch (error: any) {
        console.error('[MeetingUpload] Logo update error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
