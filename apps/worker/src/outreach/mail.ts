// Sending through Gmail SMTP and reading replies/bounces through Gmail IMAP, both with the App
// Password of the sending account (SMTP_USER / SMTP_APP_PASSWORD).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { getEnv } from '@ja/shared';

export function smtpConfigured(): string | undefined {
  const env = getEnv();
  return env.SMTP_USER && env.SMTP_APP_PASSWORD
    ? undefined
    : 'SMTP_USER / SMTP_APP_PASSWORD not set';
}

export interface OutgoingMail {
  fromName: string;
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; path: string }>;
  /** Message-ID of the email this one replies to (keeps the follow-up in the same thread). */
  inReplyTo?: string;
}

/** Sends one plain-text email. Returns the Message-ID Gmail will thread replies on. */
export async function sendMail(mail: OutgoingMail): Promise<string> {
  const env = getEnv();
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_APP_PASSWORD! },
  });
  const info = await transport.sendMail({
    from: { name: mail.fromName, address: env.SMTP_USER! },
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments,
    ...(mail.inReplyTo && { inReplyTo: mail.inReplyTo, references: [mail.inReplyTo] }),
  });
  transport.close();
  return info.messageId;
}

export interface InboxHit {
  date?: Date;
  subject: string;
  snippet: string;
}

/** Read-only access to the sending mailbox, for reply and bounce checks. */
export async function withSentMailbox<T>(
  fn: (search: (query: string) => Promise<InboxHit[]>) => Promise<T>,
): Promise<T> {
  const env = getEnv();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_APP_PASSWORD! },
    logger: false,
  });
  await client.connect();
  const boxes = await client.list();
  const allMail = boxes.find((b) => b.specialUse === '\\All')?.path ?? '[Gmail]/All Mail';
  const lock = await client.getMailboxLock(allMail, { readOnly: true });
  try {
    return await fn(async (query) => {
      const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
      const hits: InboxHit[] = [];
      for (const uid of uids.slice(-3)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        hits.push({
          date: parsed.date,
          subject: parsed.subject ?? '',
          snippet: (parsed.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      }
      return hits;
    });
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}
