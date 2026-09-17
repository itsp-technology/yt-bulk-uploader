// frontend/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ResumableChunkUploader } from './utils/chunkUploader';

const API_BASE = 'http://localhost:8787';
const QUEUE_STORAGE_KEY = 'yt_upload_queue_v3';

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
  file?: File;
  fileName: string;
  fileSize: number;
  previewUrl: string;
  title: string;
  description: string;
  tags: string;
  privacyStatus: string;
  isMadeForKids: boolean;
  status: 'QUEUED' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'PAUSED';
  progress: number;
  speedMBps: number;
  uploadUri?: string;
  videoId?: string;
  errorMessage?: string;
  uploader?: ResumableChunkUploader;
}

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState('');
  const [newPlaylistTitle, setNewPlaylistTitle] = useState('');
  const [concurrencyLimit, setConcurrencyLimit] = useState<number>(2);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const [globalConfig, setGlobalConfig] = useState({
    privacy: 'unlisted',
    description: '',
    tags: 'bulk, upload',
    categoryId: '27',
    isMadeForKids: false,
  });

  const [videos, setVideos] = useState<VideoFileItem[]>(() => {
    try {
      const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
      if (saved) {
        const parsed: VideoFileItem[] = JSON.parse(saved);
        return parsed.map((v) => ({
          ...v,
          status: v.status === 'UPLOADING' ? 'QUEUED' : v.status,
          uploader: undefined,
          file: undefined,
        }));
      }
    } catch (e) {
      console.error('Failed to load queue from storage', e);
    }
    return [];
  });

  const videosRef = useRef<VideoFileItem[]>([]);
  videosRef.current = videos;

  // Warn user before reload/navigation during uploads
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const isUploading = videosRef.current.some((v) => v.status === 'UPLOADING');
      if (isUploading) {
        e.preventDefault();
        e.returnValue = 'Videos are currently uploading. Reloading will pause progress.';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Save metadata & active session URIs across reloads
  useEffect(() => {
    try {
      const serialized = videos.map(({ uploader, file, previewUrl, ...rest }) => ({
        ...rest,
        previewUrl: previewUrl.startsWith('blob:') ? '' : previewUrl,
      }));
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serialized));
    } catch (e) {
      console.error('Queue save failed', e);
    }
  }, [videos]);

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
    localStorage.removeItem(QUEUE_STORAGE_KEY);
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
    const incoming: VideoFileItem[] = [];

    Array.from(fileList)
      .filter((f) => f.type.startsWith('video/'))
      .forEach((f) => {
        const existingIndex = videosRef.current.findIndex(
          (v) => v.fileName === f.name && Math.abs(v.fileSize - f.size) < 1000
        );

        if (existingIndex !== -1) {
          updateVideo(videosRef.current[existingIndex].id, {
            file: f,
            previewUrl: URL.createObjectURL(f),
            status: 'QUEUED',
            errorMessage: undefined,
          });
        } else {
          incoming.push({
            id: crypto.randomUUID(),
            file: f,
            fileName: f.name,
            fileSize: f.size,
            previewUrl: URL.createObjectURL(f),
            title: f.name.replace(/\.[^/.]+$/, ''),
            description: globalConfig.description,
            tags: globalConfig.tags,
            privacyStatus: globalConfig.privacy,
            isMadeForKids: globalConfig.isMadeForKids,
            status: 'QUEUED',
            progress: 0,
            speedMBps: 0,
          });
        }
      });

    if (incoming.length > 0) {
      setVideos((prev) => [...prev, ...incoming]);
    }
  };

  const handleSingleFileReselect = (id: string, file: File) => {
    updateVideo(id, {
      file,
      fileName: file.name,
      fileSize: file.size,
      previewUrl: URL.createObjectURL(file),
      status: 'QUEUED',
      errorMessage: undefined,
    });
  };

  const updateVideo = (id: string, fields: Partial<VideoFileItem>) => {
    setVideos((items) => items.map((item) => (item.id === id ? { ...item, ...fields } : item)));
  };

  const clearCompleted = () => {
    setVideos((items) => items.filter((v) => v.status !== 'COMPLETED'));
  };

  const uploadSingleVideo = async (item: VideoFileItem) => {
    if (!profile) return;
    if (!item.file) {
      updateVideo(item.id, {
        status: 'FAILED',
        errorMessage: 'File detached. Click Reselect to continue.',
      });
      return;
    }

    updateVideo(item.id, { status: 'UPLOADING', errorMessage: undefined });

    try {
      let uploadUri = item.uploadUri;

      // 1. Get resumable session URI only if not already initiated
      if (!uploadUri) {
        const initRes = await fetch(`${API_BASE}/api/uploads/initialize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
          body: JSON.stringify({
            title: item.title,
            description: item.description,
            tags: item.tags,
            privacyStatus: item.privacyStatus,
            isMadeForKids: item.isMadeForKids,
            categoryId: globalConfig.categoryId,
            fileSize: item.file.size,
            mimeType: item.file.type,
            playlistId: selectedPlaylist || undefined,
          }),
        });

        const data = await initRes.json();
        if (!data.uploadUri) {
          throw new Error(data.error || 'Could not acquire upload session from Google');
        }
        uploadUri = data.uploadUri;
        updateVideo(item.id, { uploadUri });
      }

      // 2. Stream chunked bytes to YouTube directly
      const uploader = new ResumableChunkUploader(item.file, uploadUri!, (progress) => {
        updateVideo(item.id, {
          progress: progress.percentage,
          speedMBps: progress.speedMBps,
        });
      });

      updateVideo(item.id, { uploader });
      const { videoId } = await uploader.start();

      // Video byte upload is 100% complete
      updateVideo(item.id, {
        status: 'COMPLETED',
        progress: 100,
        videoId,
        errorMessage: undefined,
      });

      // 3. Attach to playlist independently (non-fatal if playlist insertion errors)
      if (selectedPlaylist && videoId) {
        try {
          await fetch(`${API_BASE}/api/playlists/attach`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
            body: JSON.stringify({ playlistId: selectedPlaylist, videoId }),
          });
        } catch (playlistErr) {
          console.warn('Playlist attachment error (video was uploaded successfully):', playlistErr);
        }
      }
    } catch (err: any) {
      console.error(`Upload error for "${item.title}":`, err);
      updateVideo(item.id, {
        status: 'FAILED',
        errorMessage: err.message || 'Transmission error',
      });
    }
  };

  const startParallelUploads = async () => {
    if (!profile) return;
    if (isProcessing) return;

    // Verify all pending uploads have their file attached
    const unattached = videosRef.current.filter(
      (v) => (v.status === 'QUEUED' || v.status === 'FAILED') && !v.file
    );
    if (unattached.length > 0) {
      alert('Please click "Reselect File" on items marked red before starting the upload.');
      return;
    }

    setIsProcessing(true);
    const eligible = videosRef.current.filter((v) => v.status === 'QUEUED' || v.status === 'FAILED');

    let cursor = 0;
    const worker = async () => {
      while (cursor < eligible.length) {
        const target = eligible[cursor++];
        await uploadSingleVideo(target);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrencyLimit, eligible.length) },
      () => worker()
    );
    await Promise.all(workers);
    setIsProcessing(false);
  };

  const completedCount = videos.filter((v) => v.status === 'COMPLETED').length;
  const uploadingCount = videos.filter((v) => v.status === 'UPLOADING').length;

  return (
    <div className="app-container">
      {/* Header */}
      <header className="dashboard-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              minWidth: 40,
              height: 40,
              borderRadius: 10,
              background: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              color: '#fff',
              fontSize: 18,
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img
                src={profile.avatar || 'https://via.placeholder.com/40'}
                alt="Channel avatar"
                style={{ width: 38, height: 38, borderRadius: '50%', border: '2px solid #ef4444' }}
              />
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{profile.channel_title || profile.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{profile.email}</div>
              </div>
            </div>
            <button
              onClick={logout}
              style={{
                padding: '6px 12px',
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
              justifyContent: 'center',
              gap: 10,
              padding: '10px 16px',
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontWeight: 600,
              cursor: 'pointer',
              width: '100%',
              maxWidth: 240,
            }}
          >
            Connect YouTube Account
          </button>
        )}
      </header>

      {/* Metrics Row */}
      <div className="metrics-grid">
        {[
          { label: 'Total in Queue', val: videos.length, color: '#3b82f6' },
          { label: 'Active Uploading', val: uploadingCount, color: '#f59e0b' },
          { label: 'Completed', val: completedCount, color: '#10b981' },
          {
            label: 'Failed / Needs Action',
            val: videos.filter((v) => v.status === 'FAILED').length,
            color: '#ef4444',
          },
        ].map((item, idx) => (
          <div
            key={idx}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '12px 16px',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{item.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: item.color }}>{item.val}</div>
          </div>
        ))}
      </div>

      {/* Common Upload Configuration */}
      <section
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 18,
          marginBottom: 20,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Common Upload Configuration</h2>
        <div className="config-grid">
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

        {/* Mandatory COPPA Audience Question */}
        <div
          style={{
            padding: '12px 14px',
            background: '#0b0f19',
            borderRadius: 10,
            border: '1px solid var(--border)',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f3f4f6', marginBottom: 4 }}>
            Audience: Is this content made for kids? (Mandatory YouTube Requirement)
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
            Required by YouTube to comply with COPPA regulations.
          </div>
          <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="kidsSetting"
                checked={globalConfig.isMadeForKids === false}
                onChange={() => setGlobalConfig({ ...globalConfig, isMadeForKids: false })}
              />
              No, it's not made for kids
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="kidsSetting"
                checked={globalConfig.isMadeForKids === true}
                onChange={() => setGlobalConfig({ ...globalConfig, isMadeForKids: true })}
              />
              Yes, it's made for kids
            </label>
          </div>
        </div>

        {/* Quick Playlist Creation */}
        <div className="playlist-action-row">
          <input
            placeholder="Quick create playlist..."
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
              padding: '10px 18px',
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
          padding: '30px 16px',
          textAlign: 'center',
          background: isDragging ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-card)',
          marginBottom: 20,
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
        <div style={{ fontSize: 28, marginBottom: 8 }}>📁</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f3f4f6' }}>
          Tap to Select or Drag & Drop Videos
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          MP4, MOV, MKV, WebM supported
        </div>
      </div>

      {/* Queue View */}
      {videos.length > 0 && (
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>Upload Queue</h2>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {uploadingCount} transmitting | {completedCount} completed
                </p>
              </div>

              {completedCount > 0 && (
                <button
                  onClick={clearCompleted}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Clear Completed
                </button>
              )}
            </div>

            <button
              onClick={startParallelUploads}
              disabled={isProcessing || !profile}
              style={{
                width: '100%',
                padding: '12px 20px',
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
              {isProcessing ? 'Transmitting Videos In Parallel...' : 'Start Parallel Upload'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {videos.map((item) => {
              const sizeMB = (item.fileSize / (1024 * 1024)).toFixed(1);
              return (
                <div key={item.id} className="queue-card">
                  {item.previewUrl ? (
                    <video
                      src={item.previewUrl}
                      style={{
                        width: '100%',
                        maxWidth: 110,
                        height: 65,
                        borderRadius: 8,
                        objectFit: 'cover',
                        background: '#000',
                      }}
                    />
                  ) : (
                    <label
                      style={{
                        width: '100%',
                        maxWidth: 110,
                        height: 65,
                        borderRadius: 8,
                        background: '#1f293d',
                        border: '1px dashed #ef4444',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 11,
                        color: '#f87171',
                        cursor: 'pointer',
                        padding: 4,
                        textAlign: 'center',
                      }}
                    >
                      <span>📎 Reselect</span>
                      <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>to resume</span>
                      <input
                        type="file"
                        accept="video/*"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleSingleFileReselect(item.id, e.target.files[0]);
                          }
                        }}
                      />
                    </label>
                  )}

                  <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
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
                          fontSize: 13,
                        }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {sizeMB} MB
                      </span>
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
                        {item.errorMessage && ` (${item.errorMessage})`}
                      </span>

                      {item.videoId && (
                        <a
                          href={`https://youtu.be/${item.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#ef4444', textDecoration: 'none', fontWeight: 600 }}
                        >
                          View on YouTube ↗
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

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {item.status === 'FAILED' && item.file && (
                      <button
                        onClick={() => uploadSingleVideo(item)}
                        style={{
                          padding: '4px 8px',
                          borderRadius: 6,
                          background: '#ef4444',
                          color: '#fff',
                          border: 'none',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={() => setVideos((vs) => vs.filter((v) => v.id !== item.id))}
                      disabled={item.status === 'UPLOADING'}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        fontSize: 18,
                        cursor: item.status === 'UPLOADING' ? 'not-allowed' : 'pointer',
                        padding: 4,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}