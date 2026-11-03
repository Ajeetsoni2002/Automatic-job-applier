// Stats, settings, source health and admin actions.
import { Router } from 'express';
import { z } from 'zod';
import {
  dayKey,
  getEnv,
  getSettings,
  JobModel,
  llmEnabled,
  LlmUsageModel,
  SettingsPatchSchema,
  SOURCE_NAMES,
  SourceRunModel,
  startOfToday,
  TaskModel,
  updateSettings,
  type SourceRunDto,
  type StatsDto,
} from '@ja/shared';
import { HttpError, parse } from '../http.js';

export const systemRouter = Router();

systemRouter.get('/stats', async (_req, res) => {
  const env = getEnv();
  const settings = await getSettings();
  const today = startOfToday();
  const [byStatus, bySource, newToday, aboveMinScoreToday, usage, lastRun] = await Promise.all([
    JobModel.aggregate<{ _id: string; n: number }>([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    JobModel.aggregate<{ _id: string; n: number }>([
      { $group: { _id: '$source', n: { $sum: 1 } } },
    ]),
    JobModel.countDocuments({ fetchedAt: { $gte: today } }),
    JobModel.countDocuments({ scoredAt: { $gte: today }, score: { $gte: settings.minScore } }),
    LlmUsageModel.find({ date: dayKey() }).lean(),
    SourceRunModel.findOne({ status: { $in: ['ok', 'failed'] } })
      .sort({ startedAt: -1 })
      .lean(),
  ]);
  const body: StatsDto = {
    byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
    bySource: Object.fromEntries(bySource.map((r) => [r._id, r.n])),
    newToday,
    aboveMinScoreToday,
    llm: {
      callsToday: usage.reduce((s, u) => s + (u.calls ?? 0), 0),
      maxPerDay: env.MAX_LLM_CALLS_PER_DAY,
      inputTokensToday: usage.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
      outputTokensToday: usage.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
      mode: llmEnabled(env) ? 'anthropic' : 'mock',
    },
    dryRun: env.DRY_RUN,
    lastRunAt: lastRun?.startedAt?.toISOString(),
  };
  res.json(body);
});

systemRouter.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

systemRouter.put('/settings', async (req, res) => {
  res.json(await updateSettings(parse(SettingsPatchSchema, req.body)));
});

const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) });

systemRouter.get('/source-runs', async (req, res) => {
  const { limit } = parse(RunsQuery, req.query);
  const runs = await SourceRunModel.find().sort({ startedAt: -1 }).limit(limit).lean();
  const body: SourceRunDto[] = runs.map((r) => ({
    id: String(r._id),
    runId: r.runId,
    source: r.source,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString(),
    status: r.status,
    fetched: r.fetched ?? 0,
    inserted: r.inserted ?? 0,
    duplicates: r.duplicates ?? 0,
    filtered: r.filtered ?? 0,
    error: r.error ?? undefined,
  }));
  res.json(body);
});

const RunBody = z
  .object({
    sources: z.array(z.enum(SOURCE_NAMES)).min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** Queues a pipeline run; the worker picks it up within ~10 seconds. */
systemRouter.post('/admin/run-pipeline', async (req, res) => {
  const body = parse(RunBody, req.body ?? {});
  const settings = await getSettings();
  if (settings.killSwitch)
    throw new HttpError(409, 'Kill switch is on — turn it off in Settings first');
  const active = await TaskModel.findOne({
    type: 'run_pipeline',
    status: { $in: ['pending', 'running'] },
  }).lean();
  if (active) throw new HttpError(409, `A pipeline run is already ${active.status}`);
  const task = await TaskModel.create({ type: 'run_pipeline', payload: body });
  res.status(202).json({ taskId: String(task._id) });
});

systemRouter.get('/admin/tasks/:id', async (req, res) => {
  const task = await TaskModel.findById(req.params.id).lean();
  if (!task) throw new HttpError(404, 'Task not found');
  res.json({
    id: String(task._id),
    type: task.type,
    status: task.status,
    attempts: task.attempts,
    error: task.error ?? undefined,
    result: task.result ?? undefined,
    updatedAt: task.updatedAt,
  });
});
