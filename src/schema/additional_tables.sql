-- backend/src/schema/additional_tables.sql

-- Password resets table
CREATE TABLE IF NOT EXISTS password_resets (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_token (token),
    INDEX idx_expires (expires_at)
);

-- Saved nt_posts table
CREATE TABLE IF NOT EXISTS nt_saved_posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    post_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES nt_posts(id) ON DELETE CASCADE,
    UNIQUE KEY unique_save (user_id, post_id),
    INDEX idx_user_id (user_id)
);

-- Reports table
CREATE TABLE IF NOT EXISTS nt_reports (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id INT NOT NULL,
    user_id INT NOT NULL,
    reason VARCHAR(255) NOT NULL,
    description TEXT,
    resolved BOOLEAN DEFAULT false,
    resolved_by INT,
    resolved_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES nt_posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_post_id (post_id),
    INDEX idx_resolved (resolved)
);

-- User activity log (MySQL backup, though main logs go to MongoDB)
CREATE TABLE IF NOT EXISTS user_activity (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INT,
    details JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_action (action),
    INDEX idx_created_at (created_at)
);

-- Announcements table
-- CREATE TABLE IF NOT EXISTS announcements (
--     id INT PRIMARY KEY AUTO_INCREMENT,
--     title VARCHAR(255) NOT NULL,
--     content TEXT NOT NULL,
--     audience ENUM('all', 'active', 'new') DEFAULT 'all',
--     created_by INT NOT NULL,
--     is_active BOOLEAN DEFAULT true,
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--     expires_at TIMESTAMP NULL,
--     FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
--     INDEX idx_active (is_active)
-- );

-- User nt_follows activity (already exists, but adding indexes)
ALTER TABLE nt_follows ADD INDEX idx_follower_following (follower_id, following_id);

-- Post hashtags index for better search
ALTER TABLE nt_posts ADD FULLTEXT INDEX idx_hashtags (hashtags);