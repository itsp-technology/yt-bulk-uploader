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
          'https://www.googleapis.com/auth/youtube.upload',
          'https://www.googleapis.com/auth/youtube',
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
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
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

      // Check authorization header for all subsequent routes
      const userId = request.headers.get('x-user-id');
      if (!userId) {
        return Response.json({ error: 'Unauthorized: Missing x-user-id' }, { status: 401, headers });
      }

      // 3. Playlists: List
      if (url.pathname === '/api/playlists' && request.method === 'GET') {
        const { token } = await getValidAccessToken(env, userId);
        const res = await fetch(
          'https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50',
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = (await res.json()) as any;
        return Response.json(data.items || [], { headers });
      }

      // 4. Playlists: Create
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
            snippet: { title: body.title, description: body.description },
            status: { privacyStatus: body.privacy || 'unlisted' },
          }),
        });
        const data = (await res.json()) as any;
        return Response.json(data, { headers });
      }

      // 5. Initialize Resumable Upload
      if (url.pathname === '/api/uploads/initialize' && request.method === 'POST') {
        const { token } = await getValidAccessToken(env, userId);
        const body = (await request.json()) as any;

        const initialRes = await fetch(
          'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': body.mimeType || 'video/*',
              'X-Upload-Content-Length': body.fileSize.toString(),
            },
            body: JSON.stringify({
              snippet: {
                title: body.title,
                description: body.description,
                tags: Array.isArray(body.tags)
                  ? body.tags
                  : body.tags?.split(',').map((t: string) => t.trim()),
                categoryId: body.categoryId || '27',
              },
              status: {
                privacyStatus: body.privacyStatus || 'unlisted',
                selfDeclaredMadeForKids: Boolean(body.isMadeForKids),
                embeddable: true,
              },
            }),
          }
        );

        const uploadUri = initialRes.headers.get('Location');
        if (!uploadUri) {
          const errData = await initialRes.text();
          return Response.json(
            { error: 'Failed to obtain resumable URI', details: errData },
            { status: 500, headers }
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
          JSON.stringify(body.tags || []),
          body.fileSize,
          uploadUri,
          body.playlistId || null
        ).run();

        return Response.json({ uploadUri, uploadId }, { headers });
      }

      // 6. Attach to Playlist
      if (url.pathname === '/api/playlists/attach' && request.method === 'POST') {
        const { token } = await getValidAccessToken(env, userId);
        const body = (await request.json()) as any;

        const res = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            snippet: {
              playlistId: body.playlistId,
              resourceId: { kind: 'youtube#video', videoId: body.videoId },
            },
          }),
        });

        const data = (await res.json()) as any;
        return Response.json(data, { headers });
      }

      return new Response('Not Found', { status: 404, headers });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500, headers });
    }
  },
};