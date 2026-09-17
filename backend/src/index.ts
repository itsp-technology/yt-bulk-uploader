// backend/src/index.ts
import { Env } from './types';
import { getValidAccessToken } from './utils/auth';

const corsHeaders = (frontendUrl: string) => ({
  'Access-Control-Allow-Origin': frontendUrl || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-user-id',
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = corsHeaders(env.FRONTEND_URL);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    try {
      // 1. Google OAuth URL generator
      if (url.pathname === '/api/auth/url' && request.method === 'GET') {
        const scopes = [
          'https://www.googleapis.com/auth/youtube',
          'https://www.googleapis.com/auth/youtube.upload',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/userinfo.email',
        ].join(' ');

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${
          env.GOOGLE_CLIENT_ID
        }&redirect_uri=${encodeURIComponent(
          env.GOOGLE_REDIRECT_URI
        )}&response_type=code&scope=${encodeURIComponent(
          scopes
        )}&access_type=offline&prompt=consent`;

        return Response.json({ url: authUrl }, { headers });
      }

      // 2. OAuth Callback
      if (url.pathname === '/api/auth/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) {
          return new Response('Missing authorization code', { status: 400 });
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: env.GOOGLE_REDIRECT_URI,
            grant_type: 'authorization_code',
          }),
        });
        const tokens = (await tokenRes.json()) as any;

        if (!tokenRes.ok) {
          return new Response(`Token exchange failed: ${JSON.stringify(tokens)}`, { status: 400 });
        }

        const userProfileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const profile = (await userProfileRes.json()) as any;

        const channelRes = await fetch(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true',
          { headers: { Authorization: `Bearer ${tokens.access_token}` } }
        );
        const channelData = (await channelRes.json()) as any;
        const channel = channelData.items?.[0];

        const userId = crypto.randomUUID();
        const tokenExpiry = Date.now() + (tokens.expires_in || 3600) * 1000;

        await env.DB.prepare(`
          INSERT INTO users (id, google_id, email, name, avatar, access_token, refresh_token, token_expiry, channel_id, channel_title)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(google_id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, users.refresh_token),
            token_expiry = excluded.token_expiry,
            channel_id = excluded.channel_id,
            channel_title = excluded.channel_title
        `).bind(
          userId,
          profile.id,
          profile.email,
          profile.name || null,
          profile.picture || null,
          tokens.access_token,
          tokens.refresh_token,
          tokenExpiry,
          channel?.id || null,
          channel?.snippet?.title || null
        ).run();

        const finalUser = await env.DB.prepare('SELECT id FROM users WHERE google_id = ?')
          .bind(profile.id)
          .first<{ id: string }>();

        return Response.redirect(`${env.FRONTEND_URL}/?userId=${finalUser?.id}`, 302);
      }

      // Authorization header validation
      const userId = request.headers.get('x-user-id');
      if (!userId) {
        return Response.json({ error: 'Unauthorized: Missing x-user-id' }, { status: 401, headers });
      }

      // 3. User Profile
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const user = await env.DB.prepare(
          'SELECT id, email, name, avatar, channel_id, channel_title FROM users WHERE id = ?'
        )
          .bind(userId)
          .first<any>();

        if (!user) {
          return Response.json({ error: 'User not found' }, { status: 404, headers });
        }
        return Response.json(user, { headers });
      }

      // 4. Playlists: List
      if (url.pathname === '/api/playlists' && request.method === 'GET') {
        const { token } = await getValidAccessToken(env, userId);
        const res = await fetch(
          'https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=50',
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = (await res.json()) as any;
        return Response.json(data.items || [], { headers });
      }

      // 5. Playlists: Create
      if (url.pathname === '/api/playlists' && request.method === 'POST') {
        const { token } = await getValidAccessToken(env, userId);
        const body = (await request.json()) as any;

        const res = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=snippet,status', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: { title: body.title, description: body.description || '' },
            status: { privacyStatus: body.privacy || 'unlisted' },
          }),
        });
        const data = (await res.json()) as any;
        return Response.json(data, { headers });
      }

      // 6. Initialize Resumable Upload (Includes client Origin to enable browser CORS)
      if (url.pathname === '/api/uploads/initialize' && request.method === 'POST') {
        const { token } = await getValidAccessToken(env, userId);
        const body = (await request.json()) as any;

        const mimeType = body.mimeType && body.mimeType.length > 0 ? body.mimeType : 'video/mp4';
        const clientOrigin = request.headers.get('Origin') || env.FRONTEND_URL || 'http://localhost:5173';

        const sanitizedTags = Array.isArray(body.tags)
          ? body.tags.filter((t: string) => t && t.trim().length > 0)
          : (body.tags || '')
              .split(',')
              .map((t: string) => t.trim())
              .filter((t: string) => t.length > 0);

        const metadataPayload = {
          snippet: {
            title: body.title || 'Untitled Video',
            description: body.description || '',
            tags: sanitizedTags.length > 0 ? sanitizedTags : ['video'],
            categoryId: body.categoryId || '27',
          },
          status: {
            privacyStatus: body.privacyStatus || 'unlisted',
            selfDeclaredMadeForKids: Boolean(body.isMadeForKids),
            embeddable: true,
          },
        };

        const initialRes = await fetch(
          'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': mimeType,
              'X-Upload-Content-Length': String(body.fileSize),
              Origin: clientOrigin,
            },
            body: JSON.stringify(metadataPayload),
          }
        );

        const uploadUri = initialRes.headers.get('Location');
        if (!uploadUri) {
          const errText = await initialRes.text();
          let parsedError = errText;
          try {
            const errJson = JSON.parse(errText);
            parsedError = errJson?.error?.message || errText;
          } catch {}

          return Response.json(
            {
              error: `Google API Error (${initialRes.status}): ${parsedError}`,
              rawDetails: parsedError,
            },
            { status: initialRes.status, headers }
          );
        }

        const uploadId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO uploads (id, user_id, title, description, privacy_status, tags, file_size, upload_uri, playlist_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
        `).bind(
          uploadId,
          userId,
          body.title,
          body.description || null,
          body.privacyStatus || 'unlisted',
          JSON.stringify(sanitizedTags),
          body.fileSize,
          uploadUri,
          body.playlistId || null
        ).run();

        return Response.json({ uploadUri, uploadId }, { headers });
      }

      // 7. Attach Video to Playlist (Auto-resolves Video ID by title if missing)
      if (url.pathname === '/api/playlists/attach' && request.method === 'POST') {
        const { token } = await getValidAccessToken(env, userId);
        const { playlistId, videoId, title } = (await request.json()) as any;

        if (!playlistId) {
          return Response.json({ error: 'Missing playlistId' }, { status: 400, headers });
        }

        let resolvedVideoId = videoId && String(videoId).trim().length > 0 ? String(videoId).trim() : null;

        // Auto-detect videoId from channel uploads if not provided
        if (!resolvedVideoId && title) {
          try {
            const chRes = await fetch(
              'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const chData = (await chRes.json()) as any;
            const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

            if (uploadsPlaylistId) {
              const listRes = await fetch(
                `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=30`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              const listData = (await listRes.json()) as any;
              const cleanTitle = String(title).trim().toLowerCase();
              const match = (listData.items || []).find((it: any) => {
                const itemTitle = String(it.snippet?.title || '').trim().toLowerCase();
                return itemTitle === cleanTitle || itemTitle.startsWith(cleanTitle);
              });
              if (match) {
                resolvedVideoId = match.snippet?.resourceId?.videoId;
              }
            }
          } catch (lookupErr) {
            console.warn('Video ID title lookup notice:', lookupErr);
          }
        }

        if (!resolvedVideoId) {
          return Response.json(
            { error: 'Could not resolve Video ID. The video may still be transcoding.' },
            { status: 400, headers }
          );
        }

        // Check if video is already inside the target playlist
        try {
          const verifyRes = await fetch(
            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (verifyRes.ok) {
            const vData = (await verifyRes.json()) as any;
            const exists = (vData.items || []).some(
              (it: any) => it.snippet?.resourceId?.videoId === resolvedVideoId
            );
            if (exists) {
              return Response.json(
                { success: true, alreadyInPlaylist: true, videoId: resolvedVideoId },
                { headers }
              );
            }
          }
        } catch {}

        let attempts = 0;
        let lastError = '';

        while (attempts < 6) {
          attempts++;

          const res = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              snippet: {
                playlistId: playlistId,
                resourceId: {
                  kind: 'youtube#video',
                  videoId: resolvedVideoId,
                },
              },
            }),
          });

          if (res.ok) {
            const data = await res.json();
            return Response.json({ success: true, item: data, videoId: resolvedVideoId }, { headers });
          }

          const errText = await res.text();
          lastError = errText;

          if (errText.includes('videoAlreadyInPlaylist')) {
            return Response.json(
              { success: true, alreadyInPlaylist: true, videoId: resolvedVideoId },
              { headers }
            );
          }

          if (res.status === 401 || res.status === 403) {
            return Response.json(
              {
                error: 'Permission Denied: Please disconnect and reconnect YouTube to grant playlist write access.',
                details: errText,
              },
              { status: 403, headers }
            );
          }

          await new Promise((resolve) => setTimeout(resolve, attempts * 1500));
        }

        return Response.json(
          { error: `YouTube Playlist linking rejected: ${lastError}`, details: lastError },
          { status: 500, headers }
        );
      }

      // 8. Processing status
      if (url.pathname === '/api/uploads/status' && request.method === 'GET') {
        const videoId = url.searchParams.get('videoId');
        if (!videoId) {
          return Response.json({ error: 'Missing videoId' }, { status: 400, headers });
        }

        const { token } = await getValidAccessToken(env, userId);
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=processingDetails,status&id=${videoId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = (await res.json()) as any;
        const item = data.items?.[0];

        if (!item) {
          return Response.json({ status: 'uploaded', partsProcessed: 100, processingProgress: 100 }, { headers });
        }

        const processingDetails = item.processingDetails || {};
        const statusDetails = item.status || {};

        const processingStatus = processingDetails.processingStatus || 'processing';
        const partsProcessed = processingDetails.processingProgress?.partsProcessed;
        const partsTotal = processingDetails.processingProgress?.partsTotal;
        const timeLeftMs = processingDetails.processingProgress?.timeLeftMs;

        let percentage = 0;
        if (partsTotal && partsTotal > 0) {
          percentage = Math.round((Number(partsProcessed) / Number(partsTotal)) * 100);
        } else if (processingStatus === 'succeeded' || statusDetails.uploadStatus === 'processed') {
          percentage = 100;
        }

        return Response.json(
          {
            processingStatus,
            uploadStatus: statusDetails.uploadStatus,
            percentage,
            timeLeftMs,
          },
          { headers }
        );
      }

      return new Response('Not Found', { status: 404, headers });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers });
    }
  },
};