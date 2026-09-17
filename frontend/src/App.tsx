// frontend/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ResumableChunkUploader } from './utils/chunkUploader';

const API_BASE = 'http://localhost:8787';

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
  const [userId, setUserId] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoFileItem[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState('');
  const [newPlaylistTitle, setNewPlaylistTitle] = useState('');
  const [concurrencyLimit, setConcurrencyLimit] = useState<number>(3);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Ref to access the latest videos state inside async worker loops without race conditions
  const videosRef = useRef<VideoFileItem[]>([]);
  videosRef.current = videos;

  const [globalConfig, setGlobalConfig] = useState({
    privacy: 'unlisted',
    description: '',
    tags: 'code, demo',
    categoryId: '27',
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('userId');
    const storedId = localStorage.getItem('yt_user_id');
    const activeId = idFromUrl || storedId;

    if (activeId) {
      setUserId(activeId);
      localStorage.setItem('yt_user_id', activeId);
      if (idFromUrl) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      loadPlaylists(activeId);
    }
  }, []);

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
      console.error('Failed to load playlists', e);
    }
  };

  const createPlaylist = async () => {
    if (!userId || !newPlaylistTitle.trim()) return;
    const res = await fetch(`${API_BASE}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ title: newPlaylistTitle, privacy: 'unlisted' }),
    });
    if (res.ok) {
      const created = await res.json();
      setPlaylists((p) => [...p, created]);
      setSelectedPlaylist(created.id);
      setNewPlaylistTitle('');
    }
  };

  const onFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const newItems: VideoFileItem[] = Array.from(e.target.files).map((f) => ({
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

  // Upload single video handler
  const uploadSingleVideo = async (item: VideoFileItem) => {
    if (!userId) return;

    updateVideo(item.id, { status: 'UPLOADING' });

    try {
      // 1. Initialize Resumable Session URI
      const initRes = await fetch(`${API_BASE}/api/uploads/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
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
      if (!uploadUri) throw new Error('No upload URI returned from server');

      // 2. Stream Chunks to Google
      const uploader = new ResumableChunkUploader(
        item.file,
        uploadUri,
        (progress) => {
          updateVideo(item.id, {
            progress: progress.percentage,
            speedMBps: progress.speedMBps,
          });
        }
      );

      updateVideo(item.id, { uploader });
      const { videoId } = await uploader.start();

      // 3. Attach to YouTube Playlist
      if (selectedPlaylist) {
        await fetch(`${API_BASE}/api/playlists/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
          body: JSON.stringify({ playlistId: selectedPlaylist, videoId }),
        });
      }

      updateVideo(item.id, { status: 'COMPLETED', progress: 100, videoId });
    } catch (err) {
      console.error(`Upload failed for "${item.title}":`, err);
      updateVideo(item.id, { status: 'FAILED' });
    }
  };

  // Parallel Queue Dispatcher with Concurrency Control
  const startParallelUploads = async () => {
    if (!userId) return alert('Log in with Google first.');
    if (isProcessing) return;

    setIsProcessing(true);

    // Get all items eligible for upload (QUEUED or FAILED)
    const eligibleItems = videosRef.current.filter(
      (v) => v.status === 'QUEUED' || v.status === 'FAILED'
    );

    if (eligibleItems.length === 0) {
      setIsProcessing(false);
      return;
    }

    let cursor = 0;

    // Worker that pulls the next available video item from the shared queue
    const worker = async () => {
      while (cursor < eligibleItems.length) {
        const item = eligibleItems[cursor++];
        await uploadSingleVideo(item);
      }
    };

    // Spawn N parallel workers according to concurrencyLimit
    const activeWorkers = Array.from(
      { length: Math.min(concurrencyLimit, eligibleItems.length) },
      () => worker()
    );

    await Promise.all(activeWorkers);
    setIsProcessing(false);
  };

  return (
    <div style={{ maxWidth: 960, margin: '30px auto', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <h2>Bulk YouTube Video Uploader</h2>

      {!userId ? (
        <button onClick={loginGoogle} style={{ padding: '10px 16px', fontSize: 16, cursor: 'pointer' }}>
          Connect Google Account
        </button>
      ) : (
        <div style={{ padding: 12, background: '#e6fffa', border: '1px solid #38b2ac', borderRadius: 6 }}>
          Google Account Connected (User ID: {userId.substring(0, 8)}...)
        </div>
      )}

      {/* Common Upload Settings */}
      <fieldset style={{ marginTop: 20, padding: 16, borderRadius: 8 }}>
        <legend>Common Upload Settings</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <label>Privacy: </label>
            <select
              value={globalConfig.privacy}
              onChange={(e) => setGlobalConfig({ ...globalConfig, privacy: e.target.value })}
            >
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>

          <div>
            <label>Parallel Limit: </label>
            <select
              value={concurrencyLimit}
              disabled={isProcessing}
              onChange={(e) => setConcurrencyLimit(Number(e.target.value))}
            >
              <option value="1">1 (Sequential)</option>
              <option value="2">2 Concurrent</option>
              <option value="3">3 Concurrent</option>
              <option value="4">4 Concurrent</option>
              <option value="5">5 Concurrent</option>
            </select>
          </div>

          <div>
            <label>Add to Playlist: </label>
            <select value={selectedPlaylist} onChange={(e) => setSelectedPlaylist(e.target.value)}>
              <option value="">-- No Playlist --</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.snippet?.title}</option>
              ))}
            </select>
          </div>

          <div style={{ gridColumn: 'span 3', display: 'flex', gap: 8 }}>
            <input
              placeholder="Create new playlist..."
              value={newPlaylistTitle}
              onChange={(e) => setNewPlaylistTitle(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" onClick={createPlaylist}>Create</button>
          </div>
        </div>
      </fieldset>

      <div style={{ marginTop: 20 }}>
        <input type="file" multiple accept="video/*" onChange={onFilesSelected} />
      </div>

      {/* Queue View */}
      <div style={{ marginTop: 24 }}>
        <h3>
          Queue ({videos.length} videos | {videos.filter((v) => v.status === 'UPLOADING').length} uploading concurrently)
        </h3>

        {videos.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              border: '1px solid #ddd',
              padding: 12,
              marginBottom: 10,
              borderRadius: 6,
              background: item.status === 'UPLOADING' ? '#f0f7ff' : '#fff',
            }}
          >
            <video src={item.previewUrl} width={90} height={55} style={{ background: '#000', borderRadius: 4 }} />

            <div style={{ flex: 1 }}>
              <input
                type="text"
                value={item.title}
                disabled={item.status === 'UPLOADING' || item.status === 'COMPLETED'}
                onChange={(e) => updateVideo(item.id, { title: e.target.value })}
                style={{ width: '100%', marginBottom: 6 }}
              />

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>
                  Status:{' '}
                  <b
                    style={{
                      color:
                        item.status === 'COMPLETED'
                          ? 'green'
                          : item.status === 'UPLOADING'
                          ? '#0066cc'
                          : item.status === 'FAILED'
                          ? 'red'
                          : '#555',
                    }}
                  >
                    {item.status}
                  </b>
                </span>
                {item.speedMBps > 0 && item.status === 'UPLOADING' && (
                  <span style={{ color: '#0066cc', fontWeight: 600 }}>{item.speedMBps} MB/s</span>
                )}
                {item.videoId && (
                  <a href={`https://youtu.be/${item.videoId}`} target="_blank" rel="noreferrer">
                    Watch on YouTube ↗
                  </a>
                )}
              </div>

              <div style={{ background: '#eee', height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 6 }}>
                <div
                  style={{
                    width: `${item.progress}%`,
                    background: item.status === 'FAILED' ? 'red' : item.status === 'COMPLETED' ? 'green' : '#0066cc',
                    height: '100%',
                    transition: 'width 0.2s linear',
                  }}
                />
              </div>
            </div>

            <button
              onClick={() => setVideos((vs) => vs.filter((v) => v.id !== item.id))}
              disabled={item.status === 'UPLOADING'}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {videos.length > 0 && (
        <button
          onClick={startParallelUploads}
          disabled={isProcessing}
          style={{
            marginTop: 16,
            padding: '12px 24px',
            backgroundColor: isProcessing ? '#999' : '#ff0000',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 16,
            cursor: isProcessing ? 'not-allowed' : 'pointer',
          }}
        >
          {isProcessing ? 'Uploading in Parallel...' : 'Upload All in Parallel'}
        </button>
      )}
    </div>
  );
}