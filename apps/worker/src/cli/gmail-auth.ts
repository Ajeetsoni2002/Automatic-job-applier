// One-time Gmail authorization. Opens a local callback server, prints the Google consent URL,
// and stores the refresh token in APP_HOME (outside the repo).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exec } from 'node:child_process';
import { getEnv } from '@ja/shared';
import { createOAuthClient, GMAIL_SCOPES, saveToken, tokenPath } from '../gmail/auth.js';

const env = getEnv();
if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
  console.error(
    'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (OAuth client type: Desktop app).',
  );
  process.exit(1);
}

const server = http.createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const redirectUri = `http://127.0.0.1:${port}`;
const client = createOAuthClient(redirectUri);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: GMAIL_SCOPES,
});
console.log('\nOpen this URL in your browser and allow access:\n');
console.log(authUrl, '\n');
const opener =
  process.platform === 'win32'
    ? `start "" "${authUrl}"`
    : process.platform === 'darwin'
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
exec(opener, () => undefined);

const code = await new Promise<string>((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    const error = url.searchParams.get('error');
    const c = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      error || !c
        ? `<p>Authorization failed: ${error ?? 'no code'}.</p>`
        : '<p>Done — you can close this tab.</p>',
    );
    if (error) reject(new Error(error));
    else if (c) resolve(c);
  });
  setTimeout(() => reject(new Error('timed out after 5 minutes')), 5 * 60_000).unref();
});
server.close();

const { tokens } = await client.getToken(code);
if (!tokens.refresh_token) {
  console.error(
    'No refresh token returned. Remove the app at https://myaccount.google.com/permissions and run again.',
  );
  process.exit(1);
}
saveToken(tokens);
console.log(`Saved Gmail token to ${tokenPath()}`);
console.log(
  'Reminder: set the OAuth consent screen to "In production", otherwise this token expires in 7 days.',
);
process.exit(0);
