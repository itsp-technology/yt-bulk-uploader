import React, { useState, useEffect, useRef } from 'react';
import { ResumableChunkUploader } from './utils/chunkUploader';

const API_BASE = 'http://localhost:8787';

interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: string;
  channel_id: string;
  channel_title: string;
}

interface VideoFileItem {
  id: string;
  file: File;
  previewUrl: string;
  title: string;
  description: string;
  tags: string;
  privacyStatus: string;
  status: 'QUEUED' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'PAUSED';
  progress: number;
  speedMBps: number;
  videoId?: string;
  uploader?: ResumableChunkUploader;
}

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [videos, setVideos] = useState<VideoFileItem[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState('');
  const [newPlaylistTitle, setNewPlaylistTitle] = useState('');
  const [concurrencyLimit, setConcurrencyLimit] = useState<number>(2);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const videosRef = useRef<VideoFileItem[]>([]);
  videosRef.current = videos;

  const [globalConfig, setGlobalConfig] = useState({
    privacy: 'unlisted',
    description: '',
    tags: 'bulk, upload',
    categoryId: '27',
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('userId');
    const storedId = localStorage.getItem('yt_user_id');
    const activeId = idFromUrl || storedId;

    if (activeId) {
      localStorage.setItem('yt_user_id', activeId);
      if (idFromUrl) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      fetchUserData(activeId);
      loadPlaylists(activeId);
    }
  }, []);

  const fetchUserData = async (uid: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: { 'x-user-id': uid },
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
      } else {
        logout();
      }
    } catch {
      logout();
    }
  };

  const logout = () => {
    localStorage.removeItem('yt_user_id');
    setProfile(null);
    setVideos([]);
  };

  const loginGoogle = async () => {
    const res = await fetch(`${API_BASE}/api/auth/url`);
    const { url } = await res.json();
    window.location.href = url;
  };

  const loadPlaylists = async (uid: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/playlists`, {
        headers: { 'x-user-id': uid },
      });
      if (res.ok) {
        const data = await res.json();
        setPlaylists(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const createPlaylist = async () => {
    if (!profile || !newPlaylistTitle.trim()) return;
    const res = await fetch(`${API_BASE}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
      body: JSON.stringify({ title: newPlaylistTitle, privacy: 'unlisted' }),
    });
    if (res.ok) {
      const created = await res.json();
      setPlaylists((p) => [...p, created]);
      setSelectedPlaylist(created.id);
      setNewPlaylistTitle('');
    }
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const newItems: VideoFileItem[] = Array.from(fileList)
      .filter((f) => f.type.startsWith('video/'))
      .map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        previewUrl: URL.createObjectURL(f),
        title: f.name.replace(/\.[^/.]+$/, ''),
        description: globalConfig.description,
        tags: globalConfig.tags,
        privacyStatus: globalConfig.privacy,
        status: 'QUEUED',
        progress: 0,
        speedMBps: 0,
      }));
    setVideos((prev) => [...prev, ...newItems]);
  };

  const updateVideo = (id: string, fields: Partial<VideoFileItem>) => {
    setVideos((items) => items.map((item) => (item.id === id ? { ...item, ...fields } : item)));
  };

  const uploadSingleVideo = async (item: VideoFileItem) => {
    if (!profile) return;
    updateVideo(item.id, { status: 'UPLOADING' });

    try {
      const initRes = await fetch(`${API_BASE}/api/uploads/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          tags: item.tags,
          privacyStatus: item.privacyStatus,
          categoryId: globalConfig.categoryId,
          fileSize: item.file.size,
          mimeType: item.file.type,
          playlistId: selectedPlaylist || undefined,
        }),
      });

      const { uploadUri } = await initRes.json();
      if (!uploadUri) throw new Error('Could not get upload URI');

      const uploader = new ResumableChunkUploader(item.file, uploadUri, (progress) => {
        updateVideo(item.id, {
          progress: progress.percentage,
          speedMBps: progress.speedMBps,
        });
      });

      updateVideo(item.id, { uploader });
      const { videoId } = await uploader.start();

      if (selectedPlaylist) {
        await fetch(`${API_BASE}/api/playlists/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
          body: JSON.stringify({ playlistId: selectedPlaylist, videoId }),
        });
      }

      updateVideo(item.id, { status: 'COMPLETED', progress: 100, videoId });
    } catch {
      updateVideo(item.id, { status: 'FAILED' });
    }
  };

  const startParallelUploads = async () => {
    if (!profile) return;
    if (isProcessing) return;

    setIsProcessing(true);
    const eligible = videosRef.current.filter((v) => v.status === 'QUEUED' || v.status === 'FAILED');

    let cursor = 0;
    const worker = async () => {
      while (cursor < eligible.length) {
        const target = eligible[cursor++];
        await uploadSingleVideo(target);
      }
    };

    const workers = Array.from({ length: Math.min(concurrencyLimit, eligible.length) }, () => worker());
    await Promise.all(workers);
    setIsProcessing(false);
  };

  const completedCount = videos.filter((v) => v.status === 'COMPLETED').length;
  const uploadingCount = videos.filter((v) => v.status === 'UPLOADING').length;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      {/* Top Navigation Bar */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 24px',
          background: 'var(--bg-card)',
          borderRadius: 16,
          border: '1px solid var(--border)',
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              color: '#fff',
              fontSize: 20,
            }}
          >
            ▶
          </div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>YouTube Bulk Studio</h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Resumable Multi-Stream Engine</p>
          </div>
        </div>

        {profile ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{profile.channel_title || profile.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{profile.email}</div>
              </div>
              <img
                src={profile.avatar || 'https://via.placeholder.com/40'}
                alt="Channel avatar"
                style={{ width: 42, height: 42, borderRadius: '50%', border: '2px solid #ef4444' }}
              />
            </div>
            <button
              onClick={logout}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                background: '#1e293b',
                color: '#94a3b8',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={loginGoogle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 20px',
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Connect YouTube Account
          </button>
        )}
      </header>

      {/* Metrics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Total in Queue', val: videos.length, color: '#3b82f6' },
          { label: 'Active Uploading', val: uploadingCount, color: '#f59e0b' },
          { label: 'Completed', val: completedCount, color: '#10b981' },
          { label: 'Failed', val: videos.filter((v) => v.status === 'FAILED').length, color: '#ef4444' },
        ].map((item, idx) => (
          <div
            key={idx}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '16px 20px',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>{item.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: item.color }}>{item.val}</div>
          </div>
        ))}
      </div>

      {/* Common Settings Card */}
      <section
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 24,
          marginBottom: 24,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Common Upload Configuration</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Default Privacy
            </label>
            <select
              value={globalConfig.privacy}
              onChange={(e) => setGlobalConfig({ ...globalConfig, privacy: e.target.value })}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#0b0f19',
                color: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <option value="unlisted">Unlisted (Recommended)</option>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Parallel Stream Limit
            </label>
            <select
              value={concurrencyLimit}
              disabled={isProcessing}
              onChange={(e) => setConcurrencyLimit(Number(e.target.value))}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#0b0f19',
                color: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <option value="1">1 Stream (Sequential)</option>
              <option value="2">2 Concurrent Streams</option>
              <option value="3">3 Concurrent Streams</option>
              <option value="4">4 Concurrent Streams</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Target Playlist
            </label>
            <select
              value={selectedPlaylist}
              onChange={(e) => setSelectedPlaylist(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#0b0f19',
                color: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <option value="">-- Do Not Add To Playlist --</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.snippet?.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <input
            placeholder="Quick create playlist and select..."
            value={newPlaylistTitle}
            onChange={(e) => setNewPlaylistTitle(e.target.value)}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: '#0b0f19',
              color: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          />
          <button
            type="button"
            onClick={createPlaylist}
            style={{
              padding: '10px 20px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Create Playlist
          </button>
        </div>
      </section>

      {/* Drag & Drop File Picker */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        style={{
          border: `2px dashed ${isDragging ? '#3b82f6' : 'var(--border)'}`,
          borderRadius: 16,
          padding: '40px 20px',
          textAlign: 'center',
          background: isDragging ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-card)',
          marginBottom: 24,
          cursor: 'pointer',
        }}
        onClick={() => document.getElementById('file-input')?.click()}
      >
        <input
          id="file-input"
          type="file"
          multiple
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#f3f4f6' }}>
          Drag & Drop Video Files Here, or Click to Browse
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          MP4, MOV, MKV, WebM supported
        </div>
      </div>

      {/* Upload Queue View */}
      {videos.length > 0 && (
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 24,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>Upload Queue</h2>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {uploadingCount} of {videos.length} videos transmitting
              </p>
            </div>

            <button
              onClick={startParallelUploads}
              disabled={isProcessing || !profile}
              style={{
                padding: '12px 28px',
                background: isProcessing ? '#475569' : '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontWeight: 700,
                fontSize: 14,
                cursor: isProcessing ? 'not-allowed' : 'pointer',
                boxShadow: isProcessing ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
              }}
            >
              {isProcessing ? 'Processing Concurrent Uploads...' : 'Start Parallel Upload'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {videos.map((item) => {
              const sizeMB = (item.file.size / (1024 * 1024)).toFixed(1);
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: 16,
                    background: '#0b0f19',
                    borderRadius: 12,
                    border: '1px solid var(--border)',
                  }}
                >
                  <video
                    src={item.previewUrl}
                    style={{ width: 100, height: 60, borderRadius: 8, objectFit: 'cover', background: '#000' }}
                  />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                      <input
                        value={item.title}
                        disabled={item.status === 'UPLOADING' || item.status === 'COMPLETED'}
                        onChange={(e) => updateVideo(item.id, { title: e.target.value })}
                        style={{
                          flex: 1,
                          padding: '6px 10px',
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          color: '#fff',
                          fontSize: 14,
                        }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{sizeMB} MB</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                      <span
                        style={{
                          fontWeight: 600,
                          color:
                            item.status === 'COMPLETED'
                              ? '#10b981'
                              : item.status === 'UPLOADING'
                              ? '#3b82f6'
                              : item.status === 'FAILED'
                              ? '#ef4444'
                              : '#9ca3af',
                        }}
                      >
                        {item.status} {item.speedMBps > 0 && `• ${item.speedMBps} MB/s`}
                      </span>

                      {item.videoId && (
                        <a
                          href={`https://youtu.be/${item.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#ef4444', textDecoration: 'none', fontWeight: 600 }}
                        >
                          View Video ↗
                        </a>
                      )}
                    </div>

                    <div style={{ height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${item.progress}%`,
                          height: '100%',
                          background:
                            item.status === 'COMPLETED'
                              ? '#10b981'
                              : item.status === 'FAILED'
                              ? '#ef4444'
                              : '#3b82f6',
                          transition: 'width 0.2s ease',
                        }}
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => setVideos((vs) => vs.filter((v) => v.id !== item.id))}
                    disabled={item.status === 'UPLOADING'}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#64748b',
                      fontSize: 18,
                      cursor: item.status === 'UPLOADING' ? 'not-allowed' : 'pointer',
                      padding: 8,
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}