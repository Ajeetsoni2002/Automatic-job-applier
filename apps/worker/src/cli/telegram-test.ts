import { sendTelegram, telegramConfigured } from '../notify/telegram.js';

const problem = telegramConfigured();
if (problem) {
  console.error(`${problem}. See README → Telegram setup.`);
  process.exit(1);
}
await sendTelegram('✅ <b>Job Autopilot</b>: Telegram is connected.');
console.log('Test message sent.');
