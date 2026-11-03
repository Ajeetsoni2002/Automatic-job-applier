import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { APPLICATION_STATUSES } from '../types.js';

/**
 * One application attempt for a job on a channel (Phase 3: ATS forms). Holds the form as it was
 * read, the answer chosen for every field, and the evidence of what happened on submit.
 */
const AnswerSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, default: '' },
    kind: { type: String, required: true },
    required: { type: Boolean, default: false },
    options: { type: [String], default: undefined },
    /** string, string[] (multi-select) or boolean (checkbox). Empty string = leave blank. */
    value: { type: Schema.Types.Mixed, default: '' },
    source: { type: String, default: '' },
    needsInput: { type: Boolean, default: false },
    needsReview: { type: Boolean, default: false },
    note: { type: String },
    step: { type: Number },
    section: { type: String },
  },
  { _id: false },
);

const ApplicationSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    channel: { type: String, required: true },
    ats: { type: String },
    applyUrl: { type: String, required: true },
    mode: { type: String, required: true },
    status: { type: String, enum: APPLICATION_STATUSES, required: true },
    docId: { type: Schema.Types.ObjectId, ref: 'TailoredDoc' },
    answers: { type: [AnswerSchema], default: [] },
    screenshots: {
      type: [{ label: String, path: String, takenAt: Date, _id: false }],
      default: [],
    },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    confirmation: { type: String },
    approvedAt: { type: Date },
    submittedAt: { type: Date },
    preparedAt: { type: Date },
  },
  { timestamps: true },
);

ApplicationSchema.index({ jobId: 1, channel: 1 }, { unique: true });
ApplicationSchema.index({ status: 1, updatedAt: -1 });
ApplicationSchema.index({ submittedAt: -1 });

export type Application = InferSchemaType<typeof ApplicationSchema>;
export const ApplicationModel =
  (mongoose.models.Application as mongoose.Model<Application>) ??
  mongoose.model('Application', ApplicationSchema);

/** Answers you gave to form questions, reused for similarly worded questions later. */
const SavedAnswerSchema = new Schema(
  {
    questionKey: { type: String, required: true, unique: true },
    question: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    /** Field kind it was given for (text, date, file, textarea…). */
    kind: { type: String },
  },
  { timestamps: true },
);

export type SavedAnswer = InferSchemaType<typeof SavedAnswerSchema>;
export const SavedAnswerModel =
  (mongoose.models.SavedAnswer as mongoose.Model<SavedAnswer>) ??
  mongoose.model('SavedAnswer', SavedAnswerSchema);
