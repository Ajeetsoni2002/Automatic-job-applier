// Operational collections: source runs, LLM usage, processed emails, task queue, locks.
import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { SOURCE_NAMES } from '../types.js';

// ---- SourceRun: one row per source per pipeline run ----
const SourceRunSchema = new Schema(
  {
    runId: { type: String, required: true },
    source: { type: String, enum: SOURCE_NAMES, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    status: { type: String, enum: ['running', 'ok', 'failed', 'skipped'], required: true },
    fetched: { type: Number, default: 0 },
    inserted: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    filtered: { type: Number, default: 0 },
    error: { type: String },
  },
  { versionKey: false },
);
SourceRunSchema.index({ startedAt: -1 });
SourceRunSchema.index({ source: 1, startedAt: -1 });

export type SourceRun = InferSchemaType<typeof SourceRunSchema>;
export const SourceRunModel =
  (mongoose.models.SourceRun as mongoose.Model<SourceRun>) ??
  mongoose.model('SourceRun', SourceRunSchema);

// ---- LlmUsage: aggregated per day + model + purpose ----
const LlmUsageSchema = new Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD in app timezone
    model: { type: String, required: true },
    purpose: { type: String, required: true },
    calls: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
  },
  { versionKey: false },
);
LlmUsageSchema.index({ date: 1, model: 1, purpose: 1 }, { unique: true });

export type LlmUsage = InferSchemaType<typeof LlmUsageSchema>;
export const LlmUsageModel =
  (mongoose.models.LlmUsage as mongoose.Model<LlmUsage>) ??
  mongoose.model('LlmUsage', LlmUsageSchema);

// ---- ProcessedEmail: Gmail idempotency ----
const ProcessedEmailSchema = new Schema(
  {
    gmailMessageId: { type: String, required: true, unique: true },
    sender: { type: String },
    subject: { type: String },
    parser: { type: String },
    parsedJobs: { type: Number, default: 0 },
    processedAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

export type ProcessedEmail = InferSchemaType<typeof ProcessedEmailSchema>;
export const ProcessedEmailModel =
  (mongoose.models.ProcessedEmail as mongoose.Model<ProcessedEmail>) ??
  mongoose.model('ProcessedEmail', ProcessedEmailSchema);

// ---- Task: MongoDB-backed queue (consumed by the worker) ----
const TaskSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    runAt: { type: Date, default: () => new Date() },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lockedUntil: { type: Date },
    idempotencyKey: { type: String },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
  },
  { timestamps: true, versionKey: false },
);
TaskSchema.index({ status: 1, runAt: 1 });
TaskSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export type Task = InferSchemaType<typeof TaskSchema>;
export const TaskModel =
  (mongoose.models.Task as mongoose.Model<Task>) ?? mongoose.model('Task', TaskSchema);

// ---- Lock: prevents overlapping pipeline runs ----
const LockSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export type Lock = InferSchemaType<typeof LockSchema>;
export const LockModel =
  (mongoose.models.Lock as mongoose.Model<Lock>) ?? mongoose.model('Lock', LockSchema);
