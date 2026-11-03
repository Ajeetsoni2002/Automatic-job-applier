import { getEnv } from '@ja/shared';

const MAX_LEN = 4000; // Telegram limit is 4096 characters per message

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramConfigured(): string | undefined {
  const env = getEnv();
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? undefined
    : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set';
}

/** Sends an HTML-formatted message to your own chat. Long messages are split on line breaks. */
export async function sendTelegram(html: string): Promise<void> {
  const problem = telegramConfigured();
  if (problem) throw new Error(problem);
  const env = getEnv();

  const chunks: string[] = [];
  let current = '';
  for (const line of html.split('\n')) {
    if (current.length + line.length + 1 > MAX_LEN) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line.slice(0, MAX_LEN);
  }
  if (current) chunks.push(current);

  for (const text of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }
}
