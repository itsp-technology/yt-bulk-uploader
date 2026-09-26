for local set set this key in app.tsx fiel 
const API_BASE = 'http://localhost:8787';




### 1. Project Files Checklist

#### `.dev.vars` (Root Directory)

```env
GOOGLE_CLIENT_ID="YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="YOUR_GOOGLE_CLIENT_SECRET"
GOOGLE_REDIRECT_URI="http://localhost:8787/api/auth/callback"
FRONTEND_URL="http://localhost:5173"

```

#### `frontend/src/App.tsx`

Set the base URL to route locally to port 8787:

```typescript
const API_BASE =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:8787'
    : '';

```

---

### 2. Google Cloud Console Settings

Under **APIs & Services** $\rightarrow$ **Credentials** $\rightarrow$ **OAuth 2.0 Client IDs**:

* **Authorized JavaScript origins:**
* `http://localhost:5173`
* `http://localhost:8787`


* **Authorized redirect URIs:**
* `http://localhost:8787/api/auth/callback`



---

### 3. One-Time Setup Commands

Run in your project root terminal:

```bash
# 1. Install dependencies
npm install
npm --prefix frontend install

# 2. Create local database tables
npx wrangler d1 execute DB --local --command "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_id TEXT UNIQUE, email TEXT, name TEXT, avatar TEXT, access_token TEXT, refresh_token TEXT, token_expiry INTEGER, channel_id TEXT, channel_title TEXT); CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, description TEXT, privacy_status TEXT, tags TEXT, file_size INTEGER, upload_uri TEXT, playlist_id TEXT, status TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"

```

---

### 4. Start Local Application

Run the dev command from the root folder:

```bash
npm run dev

```

Open **`http://localhost:5173`** in your browser and click **Connect YouTube Account**.