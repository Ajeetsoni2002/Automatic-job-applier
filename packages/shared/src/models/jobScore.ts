import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { CONFIDENCES } from '../types.js';

const JobScoreSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    confidence: { type: String, enum: CONFIDENCES, required: true },
    reasons: { type: [String], default: [] },
    matchedSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    redFlags: { type: [String], default: [] },
    model: { type: String, required: true },
    promptVersion: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

JobScoreSchema.index({ jobId: 1, createdAt: -1 });

export type JobScore = InferSchemaType<typeof JobScoreSchema>;

export const JobScoreModel =
  (mongoose.models.JobScore as mongoose.Model<JobScore>) ??
  mongoose.model('JobScore', JobScoreSchema);
