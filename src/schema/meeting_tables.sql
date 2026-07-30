-- Meeting module tables for SQL Server
-- Prefix: nt_meet_ (follows project convention with nt_ prefix)

-- Main meetings table
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meetings' AND xtype='U')
CREATE TABLE nt_meetings (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_code NVARCHAR(20) NOT NULL UNIQUE,
    meeting_password NVARCHAR(100) NULL,
    title NVARCHAR(500) NOT NULL DEFAULT 'Quick Meeting',
    description NVARCHAR(MAX) NULL,
    meeting_type NVARCHAR(20) NOT NULL DEFAULT 'instant',
    visibility NVARCHAR(20) NOT NULL DEFAULT 'public',
    host_user_id INT NOT NULL,
    co_hosts NVARCHAR(MAX) NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'scheduled',
    start_time DATETIME2 NULL,
    end_time DATETIME2 NULL,
    actual_start DATETIME2 NULL,
    actual_end DATETIME2 NULL,
    max_participants INT NULL DEFAULT 100,
    waiting_room BIT NOT NULL DEFAULT 0,
    allow_join_before_host BIT NOT NULL DEFAULT 1,
    mute_on_join BIT NOT NULL DEFAULT 1,
    camera_off_on_join BIT NOT NULL DEFAULT 0,
    allow_recording BIT NOT NULL DEFAULT 1,
    allow_screen_share BIT NOT NULL DEFAULT 1,
    allow_chat BIT NOT NULL DEFAULT 1,
    allow_reactions BIT NOT NULL DEFAULT 1,
    allow_hand_raise BIT NOT NULL DEFAULT 1,
    auto_end_minutes INT NULL,
    lock_meeting BIT NOT NULL DEFAULT 0,
    timezone NVARCHAR(50) NULL DEFAULT 'UTC',
    recurrence_rule NVARCHAR(500) NULL,
    calendar_event_id NVARCHAR(255) NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    updated_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);

-- Meeting participants
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_participants' AND xtype='U')
CREATE TABLE nt_meeting_participants (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NULL,
    display_name NVARCHAR(200) NULL,
    email NVARCHAR(200) NULL,
    role NVARCHAR(20) NOT NULL DEFAULT 'participant',
    status NVARCHAR(20) NOT NULL DEFAULT 'invited',
    joined_at DATETIME2 NULL,
    left_at DATETIME2 NULL,
    duration_seconds INT NULL DEFAULT 0,
    is_muted BIT NOT NULL DEFAULT 0,
    is_camera_on BIT NOT NULL DEFAULT 1,
    is_hand_raised BIT NOT NULL DEFAULT 0,
    is_screen_sharing BIT NOT NULL DEFAULT 0,
    is_spotlight BIT NOT NULL DEFAULT 0,
    is_pinned BIT NOT NULL DEFAULT 0,
    socket_id NVARCHAR(100) NULL,
    network_quality INT NULL DEFAULT 5,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_participant_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting invitations
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_invitations' AND xtype='U')
CREATE TABLE nt_meeting_invitations (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    email NVARCHAR(200) NOT NULL,
    user_id INT NULL,
    invited_by INT NOT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending',
    token NVARCHAR(255) NULL,
    responded_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_invitation_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting messages (chat)
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_messages' AND xtype='U')
CREATE TABLE nt_meeting_messages (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    sender_id INT NULL,
    sender_name NVARCHAR(200) NOT NULL,
    message_type NVARCHAR(20) NOT NULL DEFAULT 'text',
    content NVARCHAR(MAX) NOT NULL,
    is_private BIT NOT NULL DEFAULT 0,
    recipient_id INT NULL,
    is_deleted BIT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_message_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting reactions
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_reactions' AND xtype='U')
CREATE TABLE nt_meeting_reactions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NULL,
    user_name NVARCHAR(200) NOT NULL,
    emoji NVARCHAR(20) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_reaction_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting hand raise events
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_hands' AND xtype='U')
CREATE TABLE nt_meeting_hands (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NULL,
    user_name NVARCHAR(200) NOT NULL,
    is_raised BIT NOT NULL DEFAULT 1,
    raised_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    lowered_at DATETIME2 NULL,
    CONSTRAINT FK_meeting_hand_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting recordings
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_recordings' AND xtype='U')
CREATE TABLE nt_meeting_recordings (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    recorded_by INT NULL,
    file_url NVARCHAR(500) NULL,
    file_size BIGINT NULL DEFAULT 0,
    duration_seconds INT NULL DEFAULT 0,
    status NVARCHAR(20) NOT NULL DEFAULT 'recording',
    started_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    stopped_at DATETIME2 NULL,
    CONSTRAINT FK_meeting_recording_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting attendance log
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_attendance' AND xtype='U')
CREATE TABLE nt_meeting_attendance (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NULL,
    display_name NVARCHAR(200) NOT NULL,
    email NVARCHAR(200) NULL,
    action NVARCHAR(20) NOT NULL,
    timestamp DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    ip_address NVARCHAR(45) NULL,
    user_agent NVARCHAR(500) NULL,
    CONSTRAINT FK_meeting_attendance_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting polls
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_polls' AND xtype='U')
CREATE TABLE nt_meeting_polls (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    created_by INT NULL,
    question NVARCHAR(500) NOT NULL,
    options NVARCHAR(MAX) NOT NULL,
    is_anonymous BIT NOT NULL DEFAULT 0,
    is_active BIT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    closed_at DATETIME2 NULL,
    CONSTRAINT FK_meeting_poll_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Meeting poll votes
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_poll_votes' AND xtype='U')
CREATE TABLE nt_meeting_poll_votes (
    id INT IDENTITY(1,1) PRIMARY KEY,
    poll_id INT NOT NULL,
    user_id INT NULL,
    option_index INT NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_poll_vote_poll FOREIGN KEY (poll_id) REFERENCES nt_meeting_polls(id) ON DELETE CASCADE
);

-- Meeting logs (activity audit trail)
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='nt_meeting_logs' AND xtype='U')
CREATE TABLE nt_meeting_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NULL,
    action NVARCHAR(100) NOT NULL,
    details NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_meeting_log_meeting FOREIGN KEY (meeting_id) REFERENCES nt_meetings(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_meetings_code ON nt_meetings(meeting_code);
CREATE INDEX IF NOT EXISTS idx_meetings_host ON nt_meetings(host_user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON nt_meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_start ON nt_meetings(start_time);
CREATE INDEX IF NOT EXISTS idx_participants_meeting ON nt_meeting_participants(meeting_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON nt_meeting_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_status ON nt_meeting_participants(status);
CREATE INDEX IF NOT EXISTS idx_invitations_meeting ON nt_meeting_invitations(meeting_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON nt_meeting_invitations(email);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON nt_meeting_messages(meeting_id);
CREATE INDEX IF NOT EXISTS idx_reactions_meeting ON nt_meeting_reactions(meeting_id);
CREATE INDEX IF NOT EXISTS idx_attendance_meeting ON nt_meeting_attendance(meeting_id);
CREATE INDEX IF NOT EXISTS idx_logs_meeting ON nt_meeting_logs(meeting_id);
