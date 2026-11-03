import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApplicationModel,
  connectDb,
  ContactModel,
  JobModel,
  OutreachModel,
  PortalModel,
  SavedAnswerModel,
  SettingsModel,
  SuppressionModel,
  TailoredDocModel,
  TaskModel,
} from '@ja/shared';
import { createApp } from './app.js';

const app = createApp();

describe('auth', () => {
  it('rejects protected routes without a session', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not logged in');
  });

  it('rejects a forged token', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects wrong credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('validates the login body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
  });

  it('logs in, sets an httpOnly cookie, and /me works with it', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'Admin@Example.com', password: 'test-password-123' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']?.[0]).toMatch(/ja_token=.*HttpOnly/i);
    const me = await agent.get('/api/auth/me');
    expect(me.body).toEqual({ email: 'admin@example.com' });
  });
});

const dbUp = await connectDb(
  process.env.MONGODB_URI_TEST_API ?? 'mongodb://127.0.0.1:27017/job-autopilot-test-api',
)
  .then(() => true)
  .catch(() => false);

describe.skipIf(!dbUp)('jobs API (MongoDB)', () => {
  const agent = request.agent(app);
  const base = {
    url: 'https://x',
    canonicalUrl: 'https://x',
    companyNorm: 'acme',
    location: 'Pune',
    descriptionQuality: 'full',
    description: 'JD text',
  };

  beforeAll(async () => {
    expect(mongoose.connection.name).toBe('job-autopilot-test-api');
    await Promise.all([
      JobModel.deleteMany({}),
      SettingsModel.deleteMany({}),
      TaskModel.deleteMany({}),
    ]);
    await JobModel.create([
      {
        ...base,
        source: 'lever',
        sourceJobId: 'a',
        company: 'Acme',
        title: 'MERN Developer',
        titleNorm: 'mern developer',
        dedupeHash: 'h1',
        status: 'scored',
        score: 88,
        workMode: 'hybrid',
        batchYears: [2024, 2025],
        batchMatch: true,
      },
      {
        ...base,
        source: 'lever',
        sourceJobId: 'b',
        company: 'Beta',
        title: 'React Developer',
        titleNorm: 'react developer',
        dedupeHash: 'h2',
        status: 'scored',
        score: 55,
        workMode: 'remote',
      },
      {
        ...base,
        source: 'adzuna',
        sourceJobId: 'c',
        company: 'Gamma',
        title: 'Java Developer',
        titleNorm: 'java developer',
        dedupeHash: 'h3',
        status: 'filtered_out',
        filterReason: 'title has excluded keyword "Java"',
      },
    ]);
    await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'test-password-123' });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('lists active jobs sorted by score, hiding filtered ones and descriptions', async () => {
    const res = await agent.get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((j: { title: string }) => j.title)).toEqual([
      'MERN Developer',
      'React Developer',
    ]);
    expect(res.body.items[0].description).toBeUndefined();
  });

  it('filters by min score, work mode, status and search', async () => {
    expect((await agent.get('/api/jobs?minScore=70')).body.total).toBe(1);
    expect((await agent.get('/api/jobs?workMode=remote')).body.items[0].title).toBe(
      'React Developer',
    );
    expect((await agent.get('/api/jobs?status=filtered_out')).body.items[0].filterReason).toMatch(
      /Java/,
    );
    expect((await agent.get('/api/jobs?q=beta')).body.total).toBe(1);
    const batch = await agent.get('/api/jobs?batch=eligible');
    expect(batch.body.items.map((j: { title: string }) => j.title)).toEqual(['MERN Developer']);
    expect(batch.body.items[0].batchYears).toEqual([2024, 2025]);
    expect((await agent.get('/api/jobs?status=bogus')).status).toBe(400);
  });

  it('returns details and updates status and notes', async () => {
    const list = await agent.get('/api/jobs?minScore=70');
    const id = list.body.items[0].id;
    const detail = await agent.get(`/api/jobs/${id}`);
    expect(detail.body.description).toBe('JD text');

    const patched = await agent
      .patch(`/api/jobs/${id}`)
      .send({ status: 'shortlisted', notes: 'ask Priya for referral' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'shortlisted', notes: 'ask Priya for referral' });
    expect((await agent.patch(`/api/jobs/${id}`).send({ status: 'filtered_out' })).status).toBe(
      400,
    );
    expect((await agent.get('/api/jobs/not-an-id')).status).toBe(400);
  });

  it('refuses status changes on unscored or filtered jobs', async () => {
    const list = await agent.get('/api/jobs?status=filtered_out');
    const res = await agent
      .patch(`/api/jobs/${list.body.items[0].id}`)
      .send({ status: 'shortlisted' });
    expect(res.status).toBe(409);
  });

  it('reads and updates settings with validation', async () => {
    const s = await agent.get('/api/settings');
    expect(s.body).toMatchObject({ killSwitch: false, minScore: 70 });
    const u = await agent.put('/api/settings').send({ minScore: 75, sources: { adzuna: false } });
    expect(u.body).toMatchObject({ minScore: 75, sources: { adzuna: false, lever: true } });
    expect((await agent.put('/api/settings').send({ minScore: 500 })).status).toBe(400);
    expect((await agent.put('/api/settings').send({ unknownField: 1 })).status).toBe(400);
  });

  it('queues one pipeline run at a time and refuses while the kill switch is on', async () => {
    const first = await agent.post('/api/admin/run-pipeline').send({});
    expect(first.status).toBe(202);
    expect((await agent.post('/api/admin/run-pipeline').send({})).status).toBe(409);
    const task = await agent.get(`/api/admin/tasks/${first.body.taskId}`);
    expect(task.body.status).toBe('pending');

    await TaskModel.deleteMany({});
    await agent.put('/api/settings').send({ killSwitch: true });
    const blocked = await agent.post('/api/admin/run-pipeline').send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Kill switch/);
  });

  it('serves application kits: latest version, cover letter edits, missing PDFs', async () => {
    const job = (await agent.get('/api/jobs?minScore=70')).body.items[0];
    const empty = await agent.get(`/api/jobs/${job.id}/docs`);
    expect(empty.body).toMatchObject({ latest: null, llmEnabled: false });

    await TailoredDocModel.create([
      { jobId: job.id, version: 1, status: 'ready', coverLetter: 'old letter text for v1 here' },
      {
        jobId: job.id,
        version: 2,
        status: 'ready',
        coverLetter: 'Dear Hiring Manager, v2 letter body',
        issues: [{ kind: 'cover_letter', message: 'check' }],
      },
    ]);
    const docs = await agent.get(`/api/jobs/${job.id}/docs`);
    expect(docs.body.latest).toMatchObject({
      version: 2,
      hasPdf: false,
      issues: [{ kind: 'cover_letter', message: 'check' }],
    });

    const id = docs.body.latest.id;
    expect((await agent.get(`/api/docs/${id}/resume.pdf`)).status).toBe(404);
    const edited = await agent
      .patch(`/api/docs/${id}`)
      .send({ coverLetter: 'Dear Hiring Manager, my edited letter.' });
    expect(edited.body).toMatchObject({
      coverLetter: 'Dear Hiring Manager, my edited letter.',
      coverLetterEdited: true,
    });
    expect((await agent.patch(`/api/docs/${id}`).send({ coverLetter: 'short' })).status).toBe(400);
  });

  it('refuses to generate kits without an API key', async () => {
    const job = (await agent.get('/api/jobs?minScore=70')).body.items[0];
    const res = await agent.post(`/api/jobs/${job.id}/tailor`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('lets you answer, approve and skip applications', async () => {
    const job = (await agent.get('/api/jobs?minScore=70')).body.items[0];
    const app = await ApplicationModel.create({
      jobId: job.id,
      channel: 'ats',
      ats: 'lever',
      applyUrl: 'https://jobs.lever.co/acme/1/apply',
      mode: 'approve',
      status: 'needs_input',
      answers: [
        {
          key: 'name',
          label: 'Full name',
          kind: 'text',
          required: true,
          value: 'Rahul',
          source: 'profile',
        },
        {
          key: 'g',
          label: 'Gender',
          kind: 'select',
          required: true,
          options: ['Male', 'Female'],
          value: '',
          needsInput: true,
        },
      ],
    });
    const id = String(app._id);

    const listed = await agent.get('/api/applications?status=needs_input');
    expect(listed.body[0]).toMatchObject({
      id,
      job: { title: 'MERN Developer' },
      status: 'needs_input',
    });

    expect((await agent.post(`/api/applications/${id}/approve`)).status).toBe(409); // still needs input
    expect(
      (
        await agent
          .patch(`/api/applications/${id}`)
          .send({ answers: [{ key: 'g', value: 'Robot' }] })
      ).status,
    ).toBe(400);

    const saved = await agent
      .patch(`/api/applications/${id}`)
      .send({ answers: [{ key: 'g', value: 'Female' }] });
    expect(saved.body).toMatchObject({ status: 'ready' });
    expect(saved.body.answers[1]).toMatchObject({
      value: 'Female',
      source: 'user',
      needsInput: false,
    });
    expect(await SavedAnswerModel.findOne({ questionKey: 'gender' }).lean()).toMatchObject({
      value: 'Female',
    });

    const approved = await agent.post(`/api/applications/${id}/approve`);
    expect(approved.status).toBe(202);
    expect(await TaskModel.findById(approved.body.taskId).lean()).toMatchObject({
      type: 'submit_application',
      payload: { appId: id },
    });
    expect((await agent.get(`/api/applications/${id}`)).body.status).toBe('approved');

    expect((await agent.post(`/api/applications/${id}/skip`)).body.status).toBe('skipped');
    expect((await agent.get(`/api/applications/${id}/screenshots/0`)).status).toBe(404);
  });

  it('only prepares applications for ATS jobs that have a kit', async () => {
    const jobs = (await agent.get('/api/jobs')).body.items;
    const lever = jobs.find((j: { source: string }) => j.source === 'lever');
    const res = await agent.post(`/api/jobs/${lever.id}/apply`);
    // The first job got a kit in an earlier test; if this one has none, a kit is asked for.
    expect([202, 409]).toContain(res.status);
    const adzuna = await JobModel.findOne({ source: 'adzuna' }).lean();
    const r2 = await agent.post(`/api/jobs/${adzuna!._id}/apply`);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toMatch(/Greenhouse, Lever and Ashby/);
  });

  it('returns stats', async () => {
    const res = await agent.get('/api/stats');
    expect(res.body.byStatus).toMatchObject({ scored: 1, shortlisted: 1, filtered_out: 1 });
    expect(res.body.llm.mode).toBe('mock');
    expect(res.body.dryRun).toBe(true);
  });

  it('queues recruiter-email drafts, edits, approves, skips and suppresses', async () => {
    await Promise.all([
      ContactModel.deleteMany({}),
      OutreachModel.deleteMany({}),
      SuppressionModel.deleteMany({}),
    ]);
    const job = await JobModel.findOne({ source: 'lever', sourceJobId: 'a' }).lean();
    const jobId = String(job!._id);

    expect((await agent.post(`/api/jobs/${jobId}/contacts`).send({ email: 'nope' })).status).toBe(
      400,
    );
    const queued = await agent
      .post(`/api/jobs/${jobId}/contacts`)
      .send({ email: ' HR@Acme.example ', name: 'Priya' });
    expect(queued.status).toBe(202);
    expect(await TaskModel.findById(queued.body.taskId).lean()).toMatchObject({
      type: 'draft_outreach',
      payload: { jobId, email: 'hr@acme.example', name: 'Priya' },
    });
    // Asking twice while the first is pending doesn't queue a second draft.
    const again = await agent
      .post(`/api/jobs/${jobId}/contacts`)
      .send({ email: 'hr@acme.example' });
    expect(again.body.taskId).toBe(queued.body.taskId);

    const manual = await agent.post('/api/outreach/manual').send({
      company: 'Zeta Labs',
      title: 'Software Engineer',
      email: 'talent@zeta.example',
    });
    expect(manual.status).toBe(202);
    expect(await JobModel.findById(manual.body.jobId).lean()).toMatchObject({
      source: 'manual',
      status: 'shortlisted',
      company: 'Zeta Labs',
      url: 'mailto:talent@zeta.example',
    });

    // The worker writes the draft; here we create it directly.
    const contact = await ContactModel.create({ email: 'hr@acme.example', source: 'manual' });
    const draft = await OutreachModel.create({
      jobId,
      contactId: contact._id,
      email: 'hr@acme.example',
      type: 'cold_email',
      status: 'draft',
      subject: 'Application: MERN Developer',
      body: 'Hi Priya,\n\nA body that is long enough to pass validation.',
      attachResume: true,
    });
    const id = String(draft._id);

    const list = await agent.get('/api/outreach?status=draft');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      id,
      email: 'hr@acme.example',
      job: { title: 'MERN Developer', company: 'Acme' },
      contactSource: 'manual',
    });
    expect((await agent.get('/api/outreach?status=bogus')).status).toBe(400);

    const edited = await agent.patch(`/api/outreach/${id}`).send({ subject: 'New subject here' });
    expect(edited.body).toMatchObject({ subject: 'New subject here', edited: true });

    const approved = await agent.post(`/api/outreach/${id}/approve`);
    expect(approved.body).toMatchObject({ status: 'scheduled' });
    expect(approved.body.scheduledFor).toBeUndefined();
    expect((await agent.post(`/api/outreach/${id}/approve`)).status).toBe(409);

    await agent.post('/api/suppressions').send({ email: 'hr@acme.example' });
    expect((await OutreachModel.findById(id).lean())!.status).toBe('skipped');
    expect((await agent.post(`/api/outreach/${id}/skip`)).status).toBe(409);
    const blocked = await agent
      .post(`/api/jobs/${jobId}/contacts`)
      .send({ email: 'hr@acme.example' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/do-not-email/);
  });

  it('starts an application from a pasted link and carries on after your answers', async () => {
    await agent.put('/api/settings').send({ killSwitch: false });
    expect(
      (await agent.post('/api/applications/from-link').send({ url: 'ftp://x.example/job' })).status,
    ).toBe(400);
    const url = 'https://acme-labs.wd5.myworkdayjobs.com/en-US/careers/job/SDE_123';
    const res = await agent.post('/api/applications/from-link').send({ url, autoSubmit: true });
    expect(res.status).toBe(202);
    expect(await JobModel.findById(res.body.jobId).lean()).toMatchObject({
      source: 'manual',
      company: 'Acme Labs',
      title: 'Job application',
      status: 'shortlisted',
    });
    const app = await ApplicationModel.findById(res.body.appId).lean();
    expect(app).toMatchObject({
      channel: 'link',
      ats: 'workday',
      mode: 'auto',
      status: 'preparing',
    });
    expect(await TaskModel.findById(res.body.taskId).lean()).toMatchObject({
      type: 'link_apply',
      payload: { appId: res.body.appId, submit: true },
    });

    // Pasting the same link again reuses the application.
    const again = await agent
      .post('/api/applications/from-link')
      .send({ url: `${url}#top`, autoSubmit: true });
    expect(again.body.appId).toBe(res.body.appId);
    expect((await agent.post(`/api/applications/${res.body.appId}/retry`)).status).toBe(409);

    // The worker stopped on a question; answering it in auto mode queues the submission.
    await ApplicationModel.updateOne(
      { _id: res.body.appId },
      {
        $set: {
          status: 'needs_input',
          answers: [
            {
              key: 'gender',
              label: 'Gender',
              kind: 'select',
              required: true,
              options: ['Male', 'Female'],
              value: '',
              needsInput: true,
              step: 1,
            },
          ],
        },
      },
    );
    await TaskModel.deleteMany({ type: 'link_apply' });
    const saved = await agent
      .patch(`/api/applications/${res.body.appId}`)
      .send({ answers: [{ key: 'gender', value: 'Male' }] });
    expect(saved.body).toMatchObject({ status: 'approved' });
    expect(saved.body.answers[0]).toMatchObject({ step: 1, value: 'Male' });
    expect(await TaskModel.findOne({ type: 'link_apply' }).lean()).toMatchObject({
      payload: { appId: res.body.appId, submit: true },
    });

    await ApplicationModel.updateOne({ _id: res.body.appId }, { $set: { status: 'needs_login' } });
    expect((await agent.post(`/api/applications/${res.body.appId}/retry`)).status).toBe(202);
  });

  it('remembers every answer you give, including uploaded files', async () => {
    await SavedAnswerModel.deleteMany({});
    const job = await JobModel.findOne({ source: 'lever', sourceJobId: 'b' }).lean();
    const q = (key: string, label: string, kind: string) => ({
      key,
      label,
      kind,
      required: true,
      value: '',
      needsInput: true,
    });
    const app = await ApplicationModel.create({
      jobId: job!._id,
      channel: 'link',
      applyUrl: 'https://x.example/apply',
      mode: 'approve',
      status: 'needs_input',
      answers: [
        q('dob', 'Date of Birth', 'date'),
        q('why', 'Why do you want to join us?', 'textarea'),
        q('138683607', '138683607', 'text'),
        q('photo', 'Upload recent passport size photo', 'file'),
      ],
    });
    const id = String(app._id);

    const typed = await agent.patch(`/api/applications/${id}`).send({
      answers: [
        { key: 'dob', value: '15/08/2002' },
        { key: 'why', value: 'I enjoy building products.' },
        { key: '138683607', value: 'Rahul' },
      ],
    });
    expect(typed.status).toBe(200);
    // A file can't be set by typing a path.
    expect(
      (
        await agent
          .patch(`/api/applications/${id}`)
          .send({ answers: [{ key: 'photo', value: 'C:/Windows/win.ini' }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await agent
          .post(`/api/applications/${id}/answers/photo/file`)
          .set('Content-Type', 'application/octet-stream')
          .set('X-File-Name', 'run.exe')
          .send(Buffer.from('x'))
      ).status,
    ).toBe(400);
    const up = await agent
      .post(`/api/applications/${id}/answers/photo/file`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent('my photo.jpg'))
      .send(Buffer.from('fake-jpeg'));
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('ready');
    const photo = up.body.answers.find((a: { key: string }) => a.key === 'photo');
    expect(photo.value).toMatch(/my_photo\.jpg$/);

    const saved = (await agent.get('/api/saved-answers')).body as Array<{
      id: string;
      question: string;
      value: string;
      kind: string;
    }>;
    expect(saved.map((s) => [s.question, s.kind]).sort()).toEqual([
      ['Date of Birth', 'date'],
      ['Upload recent passport size photo', 'file'],
      ['Why do you want to join us?', 'textarea'],
    ]);
    const dob = saved.find((s) => s.question === 'Date of Birth')!;
    expect(
      (await agent.put(`/api/saved-answers/${dob.id}`).send({ value: '16/08/2002' })).status,
    ).toBe(200);
    expect((await SavedAnswerModel.findById(dob.id).lean())!.value).toBe('16/08/2002');
    await agent.delete(`/api/saved-answers/${dob.id}`);
    expect((await agent.get('/api/saved-answers')).body).toHaveLength(2);
  });

  it('shows job portals, queues a connect, and resumes a paused site', async () => {
    await PortalModel.deleteMany({});
    const list = await agent.get('/api/portals');
    expect(
      list.body.map((p: { name: string; connected: boolean }) => [p.name, p.connected]),
    ).toEqual([
      ['linkedin', false],
      ['naukri', false],
    ]);
    expect((await agent.post('/api/portals/indeed/connect')).status).toBe(404);
    const c1 = await agent.post('/api/portals/linkedin/connect');
    const c2 = await agent.post('/api/portals/linkedin/connect');
    expect(c1.status).toBe(202);
    expect(c2.body.taskId).toBe(c1.body.taskId);
    expect(await TaskModel.findById(c1.body.taskId).lean()).toMatchObject({
      type: 'portal_connect',
      payload: { name: 'linkedin' },
    });

    await PortalModel.create({
      name: 'naukri',
      connected: true,
      pausedUntil: new Date(Date.now() + 3_600_000),
      pauseReason: 'CAPTCHA on www.naukri.com',
    });
    const paused = (await agent.get('/api/portals')).body[1];
    expect(paused).toMatchObject({ connected: true, pauseReason: 'CAPTCHA on www.naukri.com' });
    await agent.post('/api/portals/naukri/resume');
    expect((await agent.get('/api/portals')).body[1].pausedUntil).toBeUndefined();

    // LinkedIn / Naukri applications can be started again like pasted links.
    const job = await JobModel.findOne({ source: 'lever', sourceJobId: 'b' }).lean();
    const app = await ApplicationModel.create({
      jobId: job!._id,
      channel: 'linkedin',
      applyUrl: 'https://www.linkedin.com/jobs/view/1',
      mode: 'auto',
      status: 'needs_login',
    });
    const retry = await agent.post(`/api/applications/${app._id}/retry`);
    expect(retry.status).toBe(202);
    expect(await TaskModel.findById(retry.body.taskId).lean()).toMatchObject({
      type: 'portal_apply',
      payload: { appId: String(app._id), submit: true },
    });
  });
});
