import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { getAuthedClient } from './auth.js';

export interface AlertEmail {
  id: string;
  from: string;
  subject: string;
  date?: Date;
  html: string;
  text: string;
}

export interface GmailReader {
  listMessageIds(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<AlertEmail>;
  /** Releases the connection (IMAP); a no-op for the Gmail API. */
  close?(): Promise<void>;
}

export function createGmailReader(): GmailReader {
  const api = gmail({ version: 'v1', auth: getAuthedClient() });

  return {
    async listMessageIds(query, max) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const res = await api.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(100, max),
          pageToken,
        });
        for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },

    async getMessage(id) {
      const res = await api.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = res.data.payload?.headers ?? [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
      const { html, text } = collectBodies(res.data.payload);
      return {
        id,
        from: header('from'),
        subject: header('subject'),
        date: res.data.internalDate ? new Date(Number(res.data.internalDate)) : undefined,
        html,
        text,
      };
    },
  };
}

function collectBodies(part: gmail_v1.Schema$MessagePart | undefined): {
  html: string;
  text: string;
} {
  let html = '';
  let text = '';
  const walk = (p: gmail_v1.Schema$MessagePart | undefined) => {
    if (!p) return;
    const data = p.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.mimeType === 'text/html' && !html) html = data;
    else if (p.mimeType === 'text/plain' && !text) text = data;
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  return { html, text };
}
