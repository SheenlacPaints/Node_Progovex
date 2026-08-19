import { Router } from 'express';
import { MeetingController } from '../controllers/meetingController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// User search (for invitations) - MUST be before /:code
router.get('/users/search', MeetingController.searchUsers);

// Meeting CRUD
router.post('/', authenticateToken, MeetingController.createMeeting);
router.get('/my', authenticateToken, MeetingController.getUserMeetings);
router.get('/upcoming', authenticateToken, MeetingController.getUpcomingMeetings);
router.get('/stats', authenticateToken, MeetingController.getMeetingStats);
router.get('/calendar', authenticateToken, MeetingController.getCalendarMeetings);

// Schedule
router.post('/schedule', authenticateToken, MeetingController.scheduleMeeting);
router.post('/createMeetingLater', authenticateToken, MeetingController.scheduleMeeting);

// Meeting by code (AFTER specific routes)
router.get('/:code', MeetingController.getMeetingByCode);

// Join / Leave / End
router.post('/:code/join', authenticateToken, MeetingController.joinMeeting);
router.post('/:code/leave', authenticateToken, MeetingController.leaveMeeting);
router.post('/:code/end', authenticateToken, MeetingController.endMeeting);

// Participants
router.get('/:code/participants', MeetingController.getParticipants);
router.post('/:code/participants/update', MeetingController.updateParticipant);
router.post('/:code/waiting/admit', MeetingController.admitFromWaitingRoom);
router.post('/:code/waiting/reject', MeetingController.rejectFromWaitingRoom);
router.post('/:code/waiting/admit-all', MeetingController.admitAll);
router.post('/:code/participants/remove', authenticateToken, MeetingController.removeParticipant);
router.post('/:code/participants/mute-all', authenticateToken, MeetingController.muteAll);
router.post('/:code/participants/transfer-host', authenticateToken, MeetingController.transferHost);
router.post('/:code/participants/assign-cohost', authenticateToken, MeetingController.assignCoHost);

// Invitations
router.post('/:code/invite', authenticateToken, MeetingController.inviteUser);
router.post('/:code/invite-bulk', authenticateToken, MeetingController.inviteBulk);

// Settings
router.put('/:code/settings', authenticateToken, MeetingController.updateMeetingSettings);
router.post('/:code/cancel', authenticateToken, MeetingController.cancelMeeting);
router.delete('/:code', authenticateToken, MeetingController.deleteMeeting);

// Chat
router.get('/:code/messages', MeetingController.getMessages);

// Reactions & Hand
router.post('/:code/reaction', authenticateToken, MeetingController.addReaction);
router.post('/:code/hand', authenticateToken, MeetingController.toggleHand);

export default router;
