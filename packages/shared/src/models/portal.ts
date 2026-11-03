import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { PORTAL_NAMES } from '../types.js';

/** Your session on a job site (LinkedIn, Naukri) and whether applying there is paused. */
const PortalSchema = new Schema(
  {
    name: { type: String, enum: PORTAL_NAMES, required: true, unique: true },
    connected: { type: Boolean, default: false },
    checkedAt: { type: Date },
    pausedUntil: { type: Date },
    pauseReason: { type: String },
    lastAppliedAt: { type: Date },
    /** Earliest time the next application may start (random gaps between applications). */
    nextAt: { type: Date },
  },
  { timestamps: true },
);

export type Portal = InferSchemaType<typeof PortalSchema>;
export const PortalModel =
  (mongoose.models.Portal as mongoose.Model<Portal>) ?? mongoose.model('Portal', PortalSchema);
