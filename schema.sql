-- schema.sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    avatar TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expiry INTEGER NOT NULL, -- Unix timestamp in milliseconds
    channel_id TEXT,
    channel_title TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    privacy_status TEXT DEFAULT 'unlisted',
    tags TEXT, -- JSON stringified array
    playlist_id TEXT,
    youtube_video_id TEXT,
    file_size INTEGER NOT NULL,
    upload_uri TEXT, -- Google resumable session URI
    status TEXT DEFAULT 'PENDING', -- PENDING, UPLOADING, COMPLETED, FAILED
    bytes_uploaded INTEGER DEFAULT 0,
    error_message TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);