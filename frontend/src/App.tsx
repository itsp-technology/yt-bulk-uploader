// frontend/src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ResumableChunkUploader } from './utils/chunkUploader';

const API_BASE = '';
const DB_NAME = 'yt_bulk_uploader_db';
const STORE_NAME = 'video_queue';
const SAVED_PLAYLIST_KEY = 'yt_selected_playlist_v21';

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
  playlistId: string;
  playlistTitle?: string;
  status: 'QUEUED' | 'UPLOADING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'PAUSED';
  progress: number;
  speedMBps: number;
  processingProgress?: number;
  uploadUri?: string;
  videoId?: string;
  errorMessage?: string;
  playlistAttached?: boolean;
  isAttachingPlaylist?: boolean;
  playlistError?: string;
  uploader?: ResumableChunkUploader;
}

// Native IndexedDB Helper to persist full binary Files across reloads
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported'));
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveAllToIndexedDB(items: VideoFileItem[]) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    // Clear and re-save
    await new Promise<void>((resolve, reject) => {
      const clearReq = store.clear();
      clearReq.onsuccess = () => resolve();
      clearReq.onerror = () => reject(clearReq.error);
    });

    for (const item of items) {
      // Omit uploader instance and transient blob URLs
      const { uploader, previewUrl, ...serializable } = item;
      store.put({
        ...serializable,
        status: serializable.status === 'UPLOADING' ? 'QUEUED' : serializable.status,
      });
    }

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB save failed', e);
  }
}

async function loadAllFromIndexedDB(): Promise<VideoFileItem[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const records = (req.result || []) as VideoFileItem[];
        const hydrated = records.map((rec) => {
          let preview = '';
          if (rec.file && typeof window !== 'undefined') {
            try {
              preview = URL.createObjectURL(rec.file);
            } catch {}
          }
          return {
            ...rec,
            previewUrl: preview,
            uploader: undefined,
            status: rec.status === 'UPLOADING' ? ('QUEUED' as const) : rec.status,
          };
        });
        resolve(hydrated);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export default function App() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>('');
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

  const [videos, setVideos] = useState<VideoFileItem[]>([]);

  const videosRef = useRef<VideoFileItem[]>([]);
  videosRef.current = videos;

  const selectedPlaylistRef = useRef<string>('');
  selectedPlaylistRef.current = selectedPlaylist;

  const playlistsRef = useRef<any[]>([]);
  playlistsRef.current = playlists;

  // Hydrate persistent state safely on mount from IndexedDB (Preserves Files on Refresh)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const savedPlaylist = localStorage.getItem(SAVED_PLAYLIST_KEY);
      if (savedPlaylist) {
        setSelectedPlaylist(savedPlaylist);
      }
    } catch {}

    loadAllFromIndexedDB().then((persistedQueue) => {
      if (persistedQueue.length > 0) {
        setVideos(persistedQueue);
      }
    });
  }, []);

  // Safe beforeunload listener to warn user if a stream is active
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const isWorking = videosRef.current.some(
        (v) => v.status === 'UPLOADING' || v.status === 'PROCESSING'
      );
      if (isWorking) {
        e.preventDefault();
        e.returnValue = 'Videos are currently uploading. Progress will be saved.';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Save complete queue (including binary Files) into IndexedDB
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (videos.length > 0) {
      saveAllToIndexedDB(videos);
    }
  }, [videos]);

  // Read URL query parameters on load
  useEffect(() => {
    if (typeof window === 'undefined') return;

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
    if (typeof window !== 'undefined') {
      localStorage.removeItem('yt_user_id');
      localStorage.removeItem(SAVED_PLAYLIST_KEY);
      try {
        indexedDB.deleteDatabase(DB_NAME);
      } catch {}
    }
    setProfile(null);
    setVideos([]);
  };

  const loginGoogle = async () => {
    const res = await fetch(`${API_BASE}/api/auth/url`);
    const { url } = await res.json();
    if (typeof window !== 'undefined') {
      window.location.href = url;
    }
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

  const handlePlaylistChange = (playlistId: string) => {
    setSelectedPlaylist(playlistId);
    if (typeof window !== 'undefined') {
      localStorage.setItem(SAVED_PLAYLIST_KEY, playlistId);
    }
    const found = playlists.find((p) => p.id === playlistId);
    const title = found?.snippet?.title || '';

    setVideos((items) =>
      items.map((item) =>
        item.status === 'QUEUED' || item.status === 'FAILED'
          ? { ...item, playlistId, playlistTitle: title, playlistAttached: false }
          : item
      )
    );
  };

  const handleAudienceChange = (isMadeForKids: boolean) => {
    setGlobalConfig((prev) => ({ ...prev, isMadeForKids }));
    setVideos((items) =>
      items.map((item) =>
        item.status === 'QUEUED' || item.status === 'FAILED'
          ? { ...item, isMadeForKids }
          : item
      )
    );
  };

  const handlePrivacyChange = (privacyStatus: string) => {
    setGlobalConfig((prev) => ({ ...prev, privacy: privacyStatus }));
    setVideos((items) =>
      items.map((item) =>
        item.status === 'QUEUED' || item.status === 'FAILED'
          ? { ...item, privacyStatus }
          : item
      )
    );
  };

  const createPlaylist = async () => {
    if (!profile || !newPlaylistTitle.trim()) return;
    const res = await fetch(`${API_BASE}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
      body: JSON.stringify({ title: newPlaylistTitle.trim(), privacy: 'unlisted' }),
    });
    if (res.ok) {
      const created = await res.json();
      setPlaylists((p) => [...p, created]);
      handlePlaylistChange(created.id);
      setNewPlaylistTitle('');
    }
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const incoming: VideoFileItem[] = [];
    const currentPlaylist = playlists.find((p) => p.id === selectedPlaylist);

    Array.from(fileList)
      .filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name))
      .forEach((f) => {
        const existingIndex = videosRef.current.findIndex(
          (v) => v.fileName === f.name || Math.abs(v.fileSize - f.size) < 1000
        );

        if (existingIndex !== -1) {
          updateVideo(videosRef.current[existingIndex].id, {
            file: f,
            previewUrl: typeof window !== 'undefined' ? URL.createObjectURL(f) : '',
            status: 'QUEUED',
            errorMessage: undefined,
            playlistId: selectedPlaylist || videosRef.current[existingIndex].playlistId,
            playlistTitle: currentPlaylist?.snippet?.title || videosRef.current[existingIndex].playlistTitle,
          });
        } else {
          incoming.push({
            id: crypto.randomUUID(),
            file: f,
            fileName: f.name,
            fileSize: f.size,
            previewUrl: typeof window !== 'undefined' ? URL.createObjectURL(f) : '',
            title: f.name.replace(/\.[^/.]+$/, ''),
            description: globalConfig.description,
            tags: globalConfig.tags,
            privacyStatus: globalConfig.privacy,
            isMadeForKids: globalConfig.isMadeForKids,
            playlistId: selectedPlaylist,
            playlistTitle: currentPlaylist?.snippet?.title,
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
      previewUrl: typeof window !== 'undefined' ? URL.createObjectURL(file) : '',
      status: 'QUEUED',
      errorMessage: undefined,
    });
  };

  const updateVideo = (id: string, fields: Partial<VideoFileItem>) => {
    setVideos((items) => items.map((item) => (item.id === id ? { ...item, ...fields } : item)));
  };

  const clearCompleted = () => {
    setVideos((items) => {
      const filtered = items.filter((v) => v.status !== 'COMPLETED');
      saveAllToIndexedDB(filtered);
      return filtered;
    });
  };

  // Direct Playlist Attachment Action
  const attachVideoToPlaylist = async (
    itemId: string,
    targetPlaylistId?: string,
    explicitVideoId?: string
  ): Promise<boolean> => {
    if (!profile) return false;

    const item = videosRef.current.find((v) => v.id === itemId);
    if (!item) return false;

    const playlistId = targetPlaylistId || item.playlistId || selectedPlaylistRef.current;
    if (!playlistId) return false;

    updateVideo(itemId, { isAttachingPlaylist: true, playlistError: undefined });

    try {
      const attachRes = await fetch(`${API_BASE}/api/playlists/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': profile.id },
        body: JSON.stringify({
          playlistId,
          videoId: explicitVideoId || item.videoId || '',
          title: item.title,
        }),
      });

      const resData = await attachRes.json().catch(() => ({}));

      if (attachRes.ok && (resData.success || resData.alreadyInPlaylist)) {
        const found = playlistsRef.current.find((p) => p.id === playlistId);
        updateVideo(itemId, {
          playlistAttached: true,
          isAttachingPlaylist: false,
          playlistId,
          videoId: resData.videoId || item.videoId,
          playlistTitle: found?.snippet?.title || item.playlistTitle || 'Selected Playlist',
          playlistError: undefined,
        });
        return true;
      } else {
        const err = resData.error || 'Failed to attach video to playlist';
        updateVideo(itemId, {
          playlistAttached: false,
          isAttachingPlaylist: false,
          playlistError: err,
        });
        return false;
      }
    } catch (err: any) {
      updateVideo(itemId, {
        playlistAttached: false,
        isAttachingPlaylist: false,
        playlistError: err.message,
      });
      return false;
    }
  };

  // Background Cloud Processing & Automated Playlist Attachment
  const runBackgroundProcessingAndAttach = async (
    itemId: string,
    videoId: string,
    targetPlaylistId?: string
  ) => {
    if (!profile) return;

    let isDone = false;
    let attempts = 0;
    let attached = false;

    while (targetPlaylistId && !attached && attempts < 15) {
      attempts++;
      await new Promise((r) => setTimeout(r, 2000));
      const ok = await attachVideoToPlaylist(itemId, targetPlaylistId, videoId);
      if (ok) {
        attached = true;
        break;
      }
    }

    let procAttempts = 0;
    while (!isDone && procAttempts < 30) {
      await new Promise((r) => setTimeout(r, 3000));
      procAttempts++;

      try {
        const res = await fetch(`${API_BASE}/api/uploads/status?videoId=${videoId}`, {
          headers: { 'x-user-id': profile.id },
        });

        if (res.ok) {
          const data = await res.json();

          if (data.processingStatus === 'succeeded' || data.uploadStatus === 'processed') {
            isDone = true;
            updateVideo(itemId, {
              status: 'COMPLETED',
              progress: 100,
              processingProgress: 100,
            });
            return;
          }

          if (data.processingStatus === 'failed' || data.uploadStatus === 'rejected') {
            isDone = true;
            updateVideo(itemId, {
              status: 'FAILED',
              errorMessage: 'YouTube processing was rejected by Google',
            });
            return;
          }

          const realPercentage = data.percentage > 0 ? data.percentage : Math.min(25 + procAttempts * 3, 95);
          updateVideo(itemId, {
            status: 'PROCESSING',
            processingProgress: realPercentage,
          });
        }
      } catch (err) {
        console.warn('Processing status poll error:', err);
      }
    }

    updateVideo(itemId, { status: 'COMPLETED', progress: 100, processingProgress: 100 });
  };

  const uploadSingleVideo = async (item: VideoFileItem) => {
    if (!profile) return;
    if (!item.file) {
      updateVideo(item.id, {
        status: 'FAILED',
        errorMessage: 'File missing from storage. Please reselect.',
      });
      return;
    }

    const effectivePlaylistId = item.playlistId || selectedPlaylistRef.current;
    const currentPlaylist = playlists.find((p) => p.id === effectivePlaylistId);

    updateVideo(item.id, {
      status: 'UPLOADING',
      errorMessage: undefined,
      playlistId: effectivePlaylistId,
      playlistTitle: currentPlaylist?.snippet?.title || item.playlistTitle,
    });

    try {
      let uploadUri = item.uploadUri;

      if (!uploadUri) {
        const safeMimeType = item.file.type && item.file.type.length > 0 ? item.file.type : 'video/mp4';

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
            mimeType: safeMimeType,
            playlistId: effectivePlaylistId || undefined,
          }),
        });

        const data = await initRes.json();
        if (!initRes.ok || !data.uploadUri) {
          const detailMessage = data.error || data.rawDetails || 'Failed to initialize session';
          throw new Error(detailMessage);
        }

        uploadUri = data.uploadUri;
        updateVideo(item.id, { uploadUri });
      }

      const uploader = new ResumableChunkUploader(item.file, uploadUri!, (progress) => {
        updateVideo(item.id, {
          progress: progress.percentage,
          speedMBps: progress.speedMBps,
        });
      });

      updateVideo(item.id, { uploader });
      const { videoId } = await uploader.start();

      const finalVideoId = videoId || item.videoId;
      updateVideo(item.id, {
        status: 'PROCESSING',
        progress: 100,
        videoId: finalVideoId,
        errorMessage: undefined,
      });

      if (finalVideoId) {
        runBackgroundProcessingAndAttach(item.id, finalVideoId, effectivePlaylistId);
      } else {
        updateVideo(item.id, { status: 'COMPLETED', progress: 100 });
      }
    } catch (err: any) {
      console.error(`Upload error for "${item.title}":`, err);
      let displayError = err.message || 'Transmission error';

      if (displayError.includes('exceeded the number of videos')) {
        displayError = 'Channel 24h upload limit reached. YouTube has paused new uploads.';
        setIsProcessing(false);
      }

      updateVideo(item.id, {
        status: 'FAILED',
        errorMessage: displayError,
      });
    }
  };

  const startParallelUploads = async () => {
    if (!profile) return;
    if (isProcessing) return;

    setIsProcessing(true);

    const runWorker = async () => {
      while (true) {
        const nextItem = videosRef.current.find(
          (v) => (v.status === 'QUEUED' || v.status === 'FAILED') && Boolean(v.file)
        );

        if (!nextItem) break;

        updateVideo(nextItem.id, { status: 'UPLOADING' });
        await uploadSingleVideo(nextItem);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrencyLimit, 3) },
      () => runWorker()
    );

    await Promise.all(workers);
    setIsProcessing(false);
  };

  const completedCount = videos.filter((v) => v.status === 'COMPLETED').length;
  const activeCount = videos.filter(
    (v) => v.status === 'UPLOADING' || v.status === 'PROCESSING'
  ).length;

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
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Live Sync & Auto-Playlist Engine</p>
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
          { label: 'Active (Upload / Process)', val: activeCount, color: '#f59e0b' },
          { label: 'Completed (Ready)', val: completedCount, color: '#10b981' },
          {
            label: 'Failed / Action Needed',
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

      {/* Common Configuration */}
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
              onChange={(e) => handlePrivacyChange(e.target.value)}
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
              Target Playlist (Applied Automatically)
            </label>
            <select
              value={selectedPlaylist}
              onChange={(e) => handlePlaylistChange(e.target.value)}
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

        {/* Audience / COPPA */}
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
                onChange={() => handleAudienceChange(false)}
              />
              No, it's not made for kids
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="kidsSetting"
                checked={globalConfig.isMadeForKids === true}
                onChange={() => handleAudienceChange(true)}
              />
              Yes, it's made for kids
            </label>
          </div>
        </div>

        {/* Playlist Creation */}
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

      {/* Drag & Drop Target */}
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
          accept="video/*,.mkv,.mp4,.mov,.webm,.avi,.m4v"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div style={{ fontSize: 28, marginBottom: 8 }}>📁</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f3f4f6' }}>
          Tap to Select or Drag & Drop Videos
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          Videos are safely preserved in browser storage across reloads
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
                  {activeCount} active | {completedCount} completed
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
              {isProcessing ? 'Transmitting / Processing Videos...' : 'Start Parallel Upload'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {videos.map((item) => {
              const sizeMB = (item.fileSize / (1024 * 1024)).toFixed(1);
              const isUploadingPhase = item.status === 'UPLOADING';
              const isProcessingPhase = item.status === 'PROCESSING';

              const barPercentage = isProcessingPhase
                ? item.processingProgress || 15
                : item.progress;

              const barColor =
                item.status === 'COMPLETED'
                  ? '#10b981'
                  : isProcessingPhase
                  ? '#a855f7'
                  : item.status === 'FAILED'
                  ? '#ef4444'
                  : '#3b82f6';

              const currentEffectivePlaylistId = item.playlistId || selectedPlaylist;
              const currentEffectivePlaylistTitle =
                item.playlistTitle ||
                playlists.find((p) => p.id === currentEffectivePlaylistId)?.snippet?.title;

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
                      <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>to re-attach</span>
                      <input
                        type="file"
                        accept="video/*,.mkv,.mp4,.mov,.webm,.avi,.m4v"
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
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                      <input
                        value={item.title}
                        disabled={
                          item.status === 'UPLOADING' ||
                          item.status === 'PROCESSING' ||
                          item.status === 'COMPLETED'
                        }
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

                    {/* Playlist Action & Status Row */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11,
                        marginBottom: 4,
                        flexWrap: 'wrap',
                      }}
                    >
                      {item.playlistAttached ? (
                        <span style={{ color: '#86efac', fontWeight: 600, fontSize: 12 }}>
                          📁 Saved in Playlist: <b>{currentEffectivePlaylistTitle || 'Vivek'}</b> ✓
                        </span>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ color: '#93c5fd' }}>📁 Target Playlist:</span>
                          <select
                            value={currentEffectivePlaylistId}
                            onChange={(e) => {
                              const pid = e.target.value;
                              const pl = playlists.find((p) => p.id === pid);
                              updateVideo(item.id, {
                                playlistId: pid,
                                playlistTitle: pl?.snippet?.title || '',
                                playlistAttached: false,
                              });

                              if (item.status === 'COMPLETED' && pid) {
                                attachVideoToPlaylist(item.id, pid);
                              }
                            }}
                            style={{
                              background: '#0b0f19',
                              color: '#fff',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              padding: '2px 6px',
                              fontSize: 11,
                            }}
                          >
                            <option value="">-- Choose Playlist --</option>
                            {playlists.map((pl) => (
                              <option key={pl.id} value={pl.id}>
                                {pl.snippet?.title}
                              </option>
                            ))}
                          </select>

                          {/* Save to Playlist button on finished items */}
                          {currentEffectivePlaylistId && (
                            <button
                              type="button"
                              onClick={() => attachVideoToPlaylist(item.id, currentEffectivePlaylistId)}
                              disabled={item.isAttachingPlaylist}
                              style={{
                                background: '#2563eb',
                                border: 'none',
                                color: '#fff',
                                borderRadius: 4,
                                padding: '3px 10px',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: item.isAttachingPlaylist ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {item.isAttachingPlaylist ? 'Saving to Playlist...' : 'Save to Playlist ⟳'}
                            </button>
                          )}

                          {item.playlistError && (
                            <span style={{ color: '#ef4444', fontSize: 11 }}>({item.playlistError})</span>
                          )}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, color: barColor }}>
                        {isUploadingPhase && `Uploading: ${item.progress}% (${item.speedMBps} MB/s)`}
                        {isProcessingPhase &&
                          `YouTube Processing: ${item.processingProgress || 15}% (Linking to Playlist...)`}
                        {item.status === 'COMPLETED' &&
                          (item.playlistAttached
                            ? '✓ Completed & Added to Playlist'
                            : '✓ Video Uploaded')}
                        {item.status === 'QUEUED' && (item.file ? 'Queued (Ready)' : 'Queued (Ready)')}
                        {item.status === 'FAILED' && `Failed: ${item.errorMessage || 'Error'}`}
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
                          width: `${barPercentage}%`,
                          height: '100%',
                          background: barColor,
                          transition: 'width 0.3s ease',
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
                      disabled={item.status === 'UPLOADING' || item.status === 'PROCESSING'}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        fontSize: 18,
                        cursor:
                          item.status === 'UPLOADING' || item.status === 'PROCESSING'
                            ? 'not-allowed'
                            : 'pointer',
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