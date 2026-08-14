import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { ChatController } from '../controllers/chatController';
import { ChatDbService } from '../services/chatDb.service';
import { resolveUserId } from '../services/chatIdentity.service';

const router = Router();

router.use(authenticateToken);

// Normalize the authenticated identity to the canonical users.ID
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user) {
        const resolved = await resolveUserId(req.user.id);
        if (resolved !== undefined) {
            req.user.id = resolved;
            req.user.cuserid = resolved;
        }
    }
    next();
});

const uploadsDir = path.join(__dirname, '../../uploads/chat');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '';
            cb(null, `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext.toLowerCase()}`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = /\.(png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|txt|csv|zip|mp4|webm|mov|mp3|wav|ogg)$/i.test(file.originalname);
        if (!ok) return cb(new Error('File type not allowed'));
        cb(null, true);
    }
});

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

// Upload a chat attachment -> returns relative url stored in messages
router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const file = req.file;
        if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }
        const url = `/uploads/chat/${file.filename}`;
        res.json({ success: true, url, name: file.originalname, size: file.size, mime: file.mimetype });
    } catch (error: any) {
        console.error('[Chat] upload error:', error);
        res.status(500).json({ error: error.message || 'Failed to upload file' });
    }
});

// Upload a group icon -> updates conversation avatar_url
router.post('/:id/icon', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const userId = toInt(req.user!.id)!;
        const convId = toInt(req.params.id);
        if (!convId) { res.status(400).json({ error: 'Invalid conversation id' }); return; }
        const file = req.file;
        if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

        const conversation = await ChatDbService.getConversation(convId);
        if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
        const myRole = await ChatDbService.getMemberRole(convId, userId);
        if (myRole !== 'owner' && myRole !== 'admin') {
            res.status(403).json({ error: 'Only group admins can change the icon' }); return;
        }

        const url = `/uploads/chat/${file.filename}`;
        await ChatDbService.updateConversation(convId, { avatar_url: url });
        res.json({ success: true, url });
    } catch (error: any) {
        console.error('[Chat] icon upload error:', error);
        res.status(500).json({ error: error.message || 'Failed to upload icon' });
    }
});

router.get('/', ChatController.listChats);
router.get('/users', ChatController.searchUsers);
router.post('/dm', ChatController.createDM);
router.post('/group', ChatController.createGroup);

router.get('/:id', ChatController.getConversation);
router.get('/:id/messages', ChatController.getMessages);
router.post('/:id/messages', ChatController.sendMessage);
router.post('/:id/messages/:messageId/react', ChatController.toggleReaction);
router.post('/:id/messages/:messageId/forward', ChatController.forwardMessage);

router.post('/:id/members', ChatController.addMember);
router.patch('/:id/members/:userId', ChatController.updateMemberRole);
router.delete('/:id/members/:userId', ChatController.removeMember);

router.patch('/:id', ChatController.updateConversation);
router.delete('/:id', ChatController.leaveConversation);

export default router;
