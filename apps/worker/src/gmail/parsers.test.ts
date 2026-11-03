import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.js';
import { unwrapRedirect } from './parsers/common.js';
import { indeedParser, linkedinParser, naukriParser } from './parsers/sites.js';

// Fixtures are synthetic approximations of real alert emails; tune parsers against real samples.

describe('linkedin alert parser', () => {
  it('extracts title, company, location and a canonical link per job', async () => {
    const jobs = await linkedinParser.parse(fixture('linkedin-alert.html'), '');
    expect(jobs).toEqual([
      {
        key: 'linkedin:4012345678',
        title: 'MERN Stack Developer',
        company: 'Acme Fintech',
        location: 'Bengaluru, Karnataka, India (Hybrid)',
        url: 'https://www.linkedin.com/jobs/view/4012345678',
      },
      {
        key: 'linkedin:4012399999',
        title: 'Full Stack Engineer (Node.js/React)',
        company: 'ShopKart',
        location: 'India (Remote)',
        url: 'https://www.linkedin.com/jobs/view/4012399999',
      },
    ]);
  });

  it('matches LinkedIn senders only', () => {
    expect(linkedinParser.matches('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', '')).toBe(
      true,
    );
    expect(linkedinParser.matches('Naukri <info@naukri.com>', '')).toBe(false);
  });
});

describe('naukri alert parser', () => {
  it('skips experience/salary lines and de-duplicates repeated links', async () => {
    const jobs = await naukriParser.parse(fixture('naukri-alert.html'), '');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      key: 'naukri:071025012345',
      title: 'React.js Developer',
      company: 'Globex Tech',
      location: 'Hyderabad',
    });
    expect(jobs[0]!.url).not.toContain('?');
    expect(jobs[1]).toMatchObject({
      title: 'Node.js Backend Developer',
      company: 'Infotech Solutions Pvt. Ltd.',
      location: 'Noida, Delhi / NCR',
    });
  });
});

describe('indeed alert parser', () => {
  it('reads opaque tracking links and jk links, skipping navigation links', async () => {
    const jobs = await indeedParser.parse(fixture('indeed-alert.html'), '');
    expect(jobs.map((j) => j.title)).toEqual([
      'Junior Node.js Developer',
      'MERN Developer',
      'Full Stack Developer',
    ]);
    expect(jobs[0]).toMatchObject({
      company: 'PayStream Technologies Pvt Ltd',
      location: 'Gurugram, Haryana',
      url: 'https://engage.indeed.com/f/a/AbCdEf~~/AAR9hBA~/T1',
    });
    expect(jobs[0]!.key).toMatch(/^indeed:[0-9a-f]{16}$/);
    expect(jobs[1]).toMatchObject({
      key: 'indeed:0011223344556677',
      company: 'CloudNine Labs',
      location: 'Remote',
      url: 'https://in.indeed.com/viewjob?jk=0011223344556677',
    });
  });

  it('does not mistake a company name containing "India" for a location, or a rating for anything', async () => {
    const jobs = await indeedParser.parse(fixture('indeed-alert.html'), '');
    expect(jobs[2]).toMatchObject({
      company: 'Clearwater Analytics India Private Limited',
      location: 'Bengaluru, Karnataka',
    });
  });

  it('gives an id-less job the same key every time it is parsed', async () => {
    const [a] = await indeedParser.parse(fixture('indeed-alert.html'), '');
    const [b] = await indeedParser.parse(fixture('indeed-alert.html'), '');
    expect(a!.key).toBe(b!.key);
  });
});

describe('card boundaries', () => {
  it('never borrows the next card’s company when a card has none', async () => {
    const html = `<table>
      <tr><td><a href="https://www.linkedin.com/comm/jobs/view/1111111111/">Web Developer</a></td></tr>
      <tr><td><a href="https://www.linkedin.com/comm/jobs/view/2222222222/">React Developer</a>
        <p>NextCo · Pune, Maharashtra, India</p></td></tr>
    </table>`;
    const jobs = await linkedinParser.parse(html, '');
    expect(jobs[0]).toMatchObject({ title: 'Web Developer', company: 'Unknown' });
    expect(jobs[1]).toMatchObject({ title: 'React Developer', company: 'NextCo' });
  });
});

describe('unwrapRedirect', () => {
  it('follows nested url params', () => {
    const inner = 'https://in.indeed.com/viewjob?jk=1';
    const wrapped = `https://t.example.com/r?url=${encodeURIComponent(`https://t2.example.com/x?u=${encodeURIComponent(inner)}`)}`;
    expect(unwrapRedirect(wrapped)).toBe(inner);
  });
  it('returns non-redirect links unchanged', () =>
    expect(unwrapRedirect('https://a.com/b?c=d')).toBe('https://a.com/b?c=d'));
});

describe('gmailApiIdFromImap', () => {
  it('converts IMAP X-GM-MSGID (decimal) to the Gmail API id (hex)', async () => {
    const { gmailApiIdFromImap } = await import('./imap.js');
    expect(gmailApiIdFromImap('1846378915738829437')).toBe('199fa7d76162427d');
  });
});
