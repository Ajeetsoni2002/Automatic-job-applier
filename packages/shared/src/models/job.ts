import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import {
  CONFIDENCES,
  DESCRIPTION_QUALITIES,
  JOB_STATUSES,
  JOB_SOURCES,
  WORK_MODES,
} from '../types.js';

const SeenOnSchema = new Schema(
  {
    source: { type: String, enum: JOB_SOURCES, required: true },
    sourceJobId: { type: String, required: true },
    url: { type: String, required: true },
    seenAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const JobSchema = new Schema(
  {
    source: { type: String, enum: JOB_SOURCES, required: true },
    sourceJobId: { type: String, required: true },
    url: { type: String, required: true },
    canonicalUrl: { type: String, required: true },
    company: { type: String, required: true },
    companyNorm: { type: String, required: true },
    title: { type: String, required: true },
    titleNorm: { type: String, required: true },
    location: { type: String, default: '' },
    city: { type: String },
    country: { type: String },
    workMode: { type: String, enum: WORK_MODES, default: 'unknown' },
    experienceMin: { type: Number },
    experienceMax: { type: Number },
    batchYears: { type: [Number], default: [] },
    batchMatch: { type: Boolean },
    salary: {
      min: Number,
      max: Number,
      currency: String,
      period: { type: String, enum: ['year', 'month', 'hour'] },
    },
    description: { type: String, default: '' },
    descriptionQuality: { type: String, enum: DESCRIPTION_QUALITIES, default: 'none' },
    postedAt: { type: Date },
    fetchedAt: { type: Date, required: true, default: () => new Date() },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    dedupeHash: { type: String, required: true },
    seenOn: { type: [SeenOnSchema], default: [] },
    status: { type: String, enum: JOB_STATUSES, default: 'new', required: true },
    filterReason: { type: String },
    score: { type: Number },
    scoreConfidence: { type: String, enum: CONFIDENCES },
    scoredAt: { type: Date },
    notes: { type: String },
  },
  { timestamps: true },
);

JobSchema.index({ source: 1, sourceJobId: 1 }, { unique: true });
JobSchema.index({ dedupeHash: 1 }, { unique: true });
JobSchema.index({ status: 1, score: -1 });
JobSchema.index({ postedAt: -1 });
JobSchema.index({ batchMatch: 1, status: 1 });
JobSchema.index({ fetchedAt: -1 });
JobSchema.index({ title: 'text', company: 'text' });

export type Job = InferSchemaType<typeof JobSchema>;
export type JobDoc = HydratedDocument<Job>;

export const JobModel =
  (mongoose.models.Job as mongoose.Model<Job>) ?? mongoose.model('Job', JobSchema);
