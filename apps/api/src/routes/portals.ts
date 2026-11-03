// Phase 4: LinkedIn and Naukri sessions. The worker does the browser work; this only shows state
// and queues it.
import { Router } from 'express';
import {
  ApplicationModel,
  PORTAL_NAMES,
  PortalModel,
  startOfToday,
  TaskModel,
  type PortalDto,
  type PortalName,
} from '@ja/shared';
import { HttpError } from '../http.js';

export const portalsRouter = Router();

function portalName(raw: string): PortalName {
  if (!(PORTAL_NAMES as readonly string[]).includes(raw))
    throw new HttpError(404, 'Unknown portal');
  return raw as PortalName;
}

portalsRouter.get('/portals', async (_req, res) => {
  const docs = await PortalModel.find().lean();
  const now = new Date();
  const out: PortalDto[] = [];
  for (const name of PORTAL_NAMES) {
    const d = docs.find((x) => x.name === name);
    const paused = d?.pausedUntil && d.pausedUntil > now;
    out.push({
      name,
      connected: Boolean(d?.connected),
      checkedAt: d?.checkedAt?.toISOString(),
      pausedUntil: paused ? d!.pausedUntil!.toISOString() : undefined,
      pauseReason: paused ? (d!.pauseReason ?? undefined) : undefined,
      lastAppliedAt: d?.lastAppliedAt?.toISOString(),
      appliedToday: await ApplicationModel.countDocuments({
        channel: name,
        status: 'submitted',
        submittedAt: { $gte: startOfToday() },
      }),
    });
  }
  res.json(out);
});

/** Opens the site's login page in a window on your computer; you log in there yourself. */
portalsRouter.post('/portals/:name/connect', async (req, res) => {
  const name = portalName(req.params.name);
  const active = await TaskModel.findOne({
    type: 'portal_connect',
    'payload.name': name,
    status: { $in: ['pending', 'running'] },
  }).lean();
  const task =
    active ??
    (await TaskModel.create({ type: 'portal_connect', payload: { name }, maxAttempts: 1 }));
  res.status(202).json({ taskId: String(task._id) });
});

/** Lifts a pause after a CAPTCHA / security check, once you've dealt with it. */
portalsRouter.post('/portals/:name/resume', async (req, res) => {
  const name = portalName(req.params.name);
  await PortalModel.updateOne(
    { name },
    { $unset: { pausedUntil: 1, pauseReason: 1, nextAt: 1 } },
    { upsert: true },
  );
  res.json({ ok: true });
});

/** Lets the next application start at the next check (within hours and limits). */
portalsRouter.post('/portals/:name/run-now', async (req, res) => {
  const name = portalName(req.params.name);
  await PortalModel.updateOne({ name }, { $unset: { nextAt: 1 } }, { upsert: true });
  res.json({ ok: true });
});
