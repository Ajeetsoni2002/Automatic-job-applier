import { logger, TaskModel, type SourceName } from '@ja/shared';
import { runPipeline } from './pipeline/run.js';
import { prepareApplication, submitApplication } from './apply/index.js';
import { runLinkApplication } from './apply/link.js';
import { runPortalApplication } from './portals/apply.js';
import { connectPortal } from './portals/session.js';
import { draftOutreach } from './outreach/index.js';
import { tailorJob } from './tailor/index.js';

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

/** Task types the worker executes. The API only enqueues; work happens here. */
const HANDLERS: Record<string, Handler> = {
  run_pipeline: async (p) =>
    runPipeline({
      trigger: 'api',
      sources: Array.isArray(p.sources) ? (p.sources as SourceName[]) : undefined,
      force: Boolean(p.force),
    }),
  tailor_job: async (p) => {
    if (typeof p.jobId !== 'string') throw new Error('tailor_job needs a jobId');
    const trigger = p.trigger === 'shortlist' || p.trigger === 'auto' ? p.trigger : 'manual';
    return tailorJob(p.jobId, trigger);
  },
  prepare_application: async (p) => {
    if (typeof p.jobId !== 'string') throw new Error('prepare_application needs a jobId');
    return prepareApplication(p.jobId);
  },
  submit_application: async (p) => {
    if (typeof p.appId !== 'string') throw new Error('submit_application needs an appId');
    return { status: await submitApplication(p.appId) };
  },
  link_apply: async (p) => {
    if (typeof p.appId !== 'string') throw new Error('link_apply needs an appId');
    return { status: await runLinkApplication(p.appId, { submit: p.submit === true }) };
  },
  portal_apply: async (p) => {
    if (typeof p.appId !== 'string') throw new Error('portal_apply needs an appId');
    return { status: await runPortalApplication(p.appId, { submit: p.submit === true }) };
  },
  portal_connect: async (p) => {
    if (p.name !== 'linkedin' && p.name !== 'naukri')
      throw new Error('portal_connect needs a name');
    return { connected: await connectPortal(p.name) };
  },
  draft_outreach: async (p) => {
    if (typeof p.jobId !== 'string' || typeof p.email !== 'string')
      throw new Error('draft_outreach needs jobId and email');
    return draftOutreach(p.jobId, p.email, {
      name: typeof p.name === 'string' ? p.name : undefined,
      source: 'manual',
    });
  },
};

const LEASE_MS = 50 * 60_000;

async function claimNext() {
  const now = new Date();
  return TaskModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', runAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } }, // abandoned by a crashed worker
      ],
    },
    {
      $set: { status: 'running', lockedUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true },
  ).lean();
}

export async function processTasksOnce(): Promise<number> {
  let processed = 0;
  for (let task = await claimNext(); task; task = await claimNext()) {
    processed++;
    const handler = HANDLERS[task.type];
    try {
      if (!handler) throw new Error(`unknown task type "${task.type}"`);
      const result = await handler((task.payload ?? {}) as Record<string, unknown>);
      await TaskModel.updateOne(
        { _id: task._id },
        { $set: { status: 'done', result, lockedUntil: null } },
      );
    } catch (err) {
      const failed = !handler || (task.attempts ?? 1) >= (task.maxAttempts ?? 3);
      await TaskModel.updateOne(
        { _id: task._id },
        {
          $set: {
            status: failed ? 'failed' : 'pending',
            error: (err as Error).message,
            lockedUntil: null,
            runAt: new Date(Date.now() + 60_000 * (task.attempts ?? 1)),
          },
        },
      );
      logger.error(
        { taskId: String(task._id), type: task.type, err: (err as Error).message },
        'task failed',
      );
    }
  }
  return processed;
}

export function startTaskPoller(intervalMs = 10_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processTasksOnce();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'task poller error');
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
