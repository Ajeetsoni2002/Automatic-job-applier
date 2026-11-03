// Reads alert emails over IMAP with a Gmail App Password. Unlike an OAuth app left in "Testing",
// an App Password doesn't expire every 7 days. Needs 2-Step Verification on the Google account.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getEnv } from '@ja/shared';
import type { AlertEmail, GmailReader } from './client.js';

export function imapConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GMAIL_IMAP_USER && env.GMAIL_IMAP_APP_PASSWORD);
}

/**
 * IMAP's X-GM-MSGID is the decimal form of the Gmail API message id (hex). Using the API form
 * keeps ProcessedEmail ids identical whichever way the mailbox was read.
 */
export function gmailApiIdFromImap(emailId: string): string {
  return BigInt(emailId).toString(16);
}

export async function createImapReader(): Promise<GmailReader> {
  const env = getEnv();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: env.GMAIL_IMAP_USER!, pass: env.GMAIL_IMAP_APP_PASSWORD! },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    const e = err as { authenticationFailed?: boolean; message: string };
    throw new Error(
      e.authenticationFailed
        ? 'Gmail rejected the App Password: check GMAIL_IMAP_USER / GMAIL_IMAP_APP_PASSWORD in .env'
        : `Gmail IMAP connection failed: ${e.message}`,
    );
  }

  // "All Mail" holds every labelled message; its name is localised, so find it by special use.
  const boxes = await client.list();
  const allMail = boxes.find((b) => b.specialUse === '\\All')?.path ?? '[Gmail]/All Mail';
  const lock = await client.getMailboxLock(allMail, { readOnly: true }); // never marks mail as read
  const uidById = new Map<string, number>();

  return {
    async listMessageIds(query, max) {
      const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
      const newest = uids.slice(-max);
      if (!newest.length) return [];
      const msgs = await client.fetchAll(newest.join(','), { uid: true }, { uid: true });
      const ids: string[] = [];
      for (const m of msgs.sort((a, b) => b.uid - a.uid)) {
        const id = m.emailId ? gmailApiIdFromImap(m.emailId) : `uid-${m.uid}`;
        uidById.set(id, m.uid);
        ids.push(id);
      }
      return ids;
    },

    async getMessage(id): Promise<AlertEmail> {
      const uid = uidById.get(id);
      if (uid === undefined) throw new Error(`unknown message id ${id}`);
      const msg = await client.fetchOne(
        String(uid),
        { source: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) throw new Error(`message ${id} could not be fetched`);
      const parsed = await simpleParser(msg.source);
      return {
        id,
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '',
        date: parsed.date ?? (msg.internalDate ? new Date(msg.internalDate) : undefined),
        html: typeof parsed.html === 'string' ? parsed.html : '',
        text: parsed.text ?? '',
      };
    },

    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
}
