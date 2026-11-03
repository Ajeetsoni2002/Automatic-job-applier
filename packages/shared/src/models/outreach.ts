import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { OUTREACH_STATUSES } from '../types.js';

/** A recruiter or hiring-manager address, with where it came from. */
const ContactSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String },
    company: { type: String },
    /** job_post = printed in the job description; manual = you added it. */
    source: { type: String, enum: ['job_post', 'manual'], required: true },
    /** The domain has mail servers (MX). Not proof the mailbox exists. */
    domainOk: { type: Boolean, default: false },
    lastEmailedAt: { type: Date },
  },
  { timestamps: true },
);

export type Contact = InferSchemaType<typeof ContactSchema>;
export const ContactModel =
  (mongoose.models.Contact as mongoose.Model<Contact>) ?? mongoose.model('Contact', ContactSchema);

/** One email (first message or follow-up) to one contact about one job. */
const OutreachSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    email: { type: String, required: true, lowercase: true },
    type: { type: String, enum: ['cold_email', 'follow_up'], required: true },
    /** For follow-ups: the first email of the thread. */
    parentId: { type: Schema.Types.ObjectId, ref: 'Outreach' },
    status: { type: String, enum: OUTREACH_STATUSES, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    edited: { type: Boolean, default: false },
    issues: { type: [String], default: [] },
    attachResume: { type: Boolean, default: true },
    docId: { type: Schema.Types.ObjectId, ref: 'TailoredDoc' },
    scheduledFor: { type: Date },
    messageId: { type: String },
    sentAt: { type: Date },
    repliedAt: { type: Date },
    replySnippet: { type: String },
    error: { type: String },
  },
  { timestamps: true },
);

OutreachSchema.index({ jobId: 1, contactId: 1, type: 1 }, { unique: true });
OutreachSchema.index({ status: 1, scheduledFor: 1 });
OutreachSchema.index({ sentAt: -1 });

export type Outreach = InferSchemaType<typeof OutreachSchema>;
export const OutreachModel =
  (mongoose.models.Outreach as mongoose.Model<Outreach>) ??
  mongoose.model('Outreach', OutreachSchema);

/** Addresses that must never be emailed again (opt-out, bounce, or added by you). */
const SuppressionSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    reason: { type: String, required: true },
  },
  { timestamps: true },
);

export type Suppression = InferSchemaType<typeof SuppressionSchema>;
export const SuppressionModel =
  (mongoose.models.Suppression as mongoose.Model<Suppression>) ??
  mongoose.model('Suppression', SuppressionSchema);
