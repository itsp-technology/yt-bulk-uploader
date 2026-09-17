import type { D1Database } from '@cloudflare/workers-types';

// backend/src/types.ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  FRONTEND_URL: string;
}

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  access_token: string;
  refresh_token: string;
  token_expiry: number;
  channel_id: string | null;
  channel_title: string | null;
}