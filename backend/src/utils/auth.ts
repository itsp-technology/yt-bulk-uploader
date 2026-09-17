// backend/src/utils/auth.ts
import { Env, UserRow } from '../types';

export async function getValidAccessToken(env: Env, userId: string): Promise<{ token: string; user: UserRow }> {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();

  if (!user) throw new Error('User not found');

  // Auto-refresh token if it expires in less than 2 minutes
  if (Date.now() >= user.token_expiry - 120000) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: user.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const data: any = await response.json();
    if (!response.ok) throw new Error(data.error_description || 'Failed to refresh token');

    const newExpiry = Date.now() + data.expires_in * 1000;
    await env.DB.prepare('UPDATE users SET access_token = ?, token_expiry = ? WHERE id = ?')
      .bind(data.access_token, newExpiry, userId)
      .run();

    user.access_token = data.access_token;
    user.token_expiry = newExpiry;
  }

  return { token: user.access_token, user };
}