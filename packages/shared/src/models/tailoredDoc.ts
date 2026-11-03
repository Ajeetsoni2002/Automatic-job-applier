import mongoose, { Schema, type InferSchemaType } from 'mongoose';

/**
 * One generated application kit (tailored resume + cover letter) for a job. Each regeneration
 * adds a new version; the latest is what the dashboard shows and later phases submit.
 */
const TailoredDocSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['ready', 'failed'], required: true },
    /** Structured resume (see TailoredResumeDto). Company, titles and dates come from the profile. */
    resume: { type: Schema.Types.Mixed },
    coverLetter: { type: String, default: '' },
    coverLetterEdited: { type: Boolean, default: false },
    /** Things a human should check, e.g. a rephrase that was reverted or a skill not in the profile. */
    issues: { type: [{ kind: String, message: String, _id: false }], default: [] },
    resumePdfPath: { type: String },
    notes: { type: String },
    model: { type: String },
    promptVersion: { type: String },
    error: { type: String },
    trigger: { type: String, enum: ['auto', 'manual', 'shortlist'], default: 'manual' },
  },
  { timestamps: true },
);

TailoredDocSchema.index({ jobId: 1, version: -1 }, { unique: true });
TailoredDocSchema.index({ createdAt: -1 });

export type TailoredDoc = InferSchemaType<typeof TailoredDocSchema>;
export const TailoredDocModel =
  (mongoose.models.TailoredDoc as mongoose.Model<TailoredDoc>) ??
  mongoose.model('TailoredDoc', TailoredDocSchema);
