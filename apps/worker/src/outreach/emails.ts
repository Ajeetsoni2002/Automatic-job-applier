import dns from 'node:dns/promises';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses that are never a person to write to. */
const NOT_A_RECRUITER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|privacy|legal|abuse|support|help|info@.*\b(adzuna|indeed|naukri|linkedin))|@(.*\.)?(adzuna|indeed|naukri|linkedin|glassdoor|monster|foundit|shine|instahyre|greenhouse|lever|ashbyhq|workday|myworkdayjobs|example)\.|\.(png|jpe?g|gif|svg|webp)$/i;

/** Recruiter-looking email addresses printed in a job description. */
export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/\.+$/, '').toLowerCase();
    if (!NOT_A_RECRUITER.test(email)) found.add(email);
  }
  return [...found];
}

const mxCache = new Map<string, boolean>();

/** True when the domain has mail servers. A cheap check that catches typos and dead domains. */
export async function domainAcceptsMail(email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  let ok = false;
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    ok = mx.length > 0;
  } catch {
    ok = false;
  }
  mxCache.set(domain, ok);
  return ok;
}

export const isValidEmail = (s: string) =>
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s.trim());
