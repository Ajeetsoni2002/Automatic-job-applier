import fs from 'node:fs';
import path from 'node:path';
import { auth } from '@googleapis/gmail';
import { appHome, getEnv } from '@ja/shared';

// Use the OAuth2 class bundled with @googleapis/gmail so client and API share one google-auth-library.
export type OAuthClient = InstanceType<typeof auth.OAuth2>;
export type Credentials = OAuthClient['credentials'];

/** Phase 1 only reads alert emails. `gmail.send` is added in Phase 2. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

export const tokenPath = () => path.join(appHome(), 'gmail-token.json');

export function gmailConfigured(): string | undefined {
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set';
  if (!fs.existsSync(tokenPath()))
    return `no Gmail token at ${tokenPath()} — run: npm run gmail:auth`;
  return undefined;
}

export function createOAuthClient(redirectUri?: string): OAuthClient {
  const env = getEnv();
  return new auth.OAuth2({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  });
}

export function saveToken(tokens: Credentials): void {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/** OAuth client with stored credentials. Refreshed tokens are persisted automatically. */
export function getAuthedClient(): OAuthClient {
  const problem = gmailConfigured();
  if (problem) throw new Error(problem);
  const client = createOAuthClient();
  const stored = JSON.parse(fs.readFileSync(tokenPath(), 'utf8')) as Credentials;
  client.setCredentials(stored);
  client.on('tokens', (t) =>
    saveToken({ ...stored, ...t, refresh_token: t.refresh_token ?? stored.refresh_token }),
  );
  return client;
}
