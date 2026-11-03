import mongoose, { Schema, type InferSchemaType } from 'mongoose';
import { z } from 'zod';
import { getEnv } from '../env.js';
import {
  CHANNEL_MODES,
  CHANNEL_NAMES,
  SOURCE_NAMES,
  type ChannelName,
  type SettingsDto,
  type SourceName,
} from '../types.js';

const SETTINGS_KEY = 'global';

// `sources` and `channels` are free-form maps here; their shape is validated with Zod in the API
// (see SettingsPatchSchema) and normalized by toDto() on every read.
const SettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: SETTINGS_KEY },
    killSwitch: { type: Boolean, default: false },
    minScore: { type: Number, min: 0, max: 100, required: true },
    outreach: {
      minScore: { type: Number, default: 75 },
      followUpDays: { type: Number, default: 4 },
    },
    tailoring: {
      auto: { type: Boolean, default: true },
      minScore: { type: Number, default: 80 },
      dailyLimit: { type: Number, default: 5 },
    },
    sources: { type: Schema.Types.Mixed, default: () => ({}) },
    channels: { type: Schema.Types.Mixed, default: () => ({}) },
    digest: {
      enabled: { type: Boolean, default: true },
    },
  },
  { timestamps: true, minimize: false },
);

export const SettingsPatchSchema = z
  .object({
    killSwitch: z.boolean(),
    minScore: z.number().int().min(0).max(100),
    sources: z.partialRecord(z.enum(SOURCE_NAMES), z.boolean()),
    channels: z.partialRecord(
      z.enum(CHANNEL_NAMES),
      z.object({ mode: z.enum(CHANNEL_MODES), dailyLimit: z.number().int().min(0).max(500) }),
    ),
    digest: z.object({ enabled: z.boolean() }),
    outreach: z
      .object({
        minScore: z.number().int().min(0).max(100),
        followUpDays: z.number().int().min(1).max(30),
      })
      .partial(),
    tailoring: z
      .object({
        auto: z.boolean(),
        minScore: z.number().int().min(0).max(100),
        dailyLimit: z.number().int().min(0).max(50),
      })
      .partial(),
  })
  .partial()
  .strict();

type SettingsRecord = InferSchemaType<typeof SettingsSchema>;
export const SettingsModel =
  (mongoose.models.Settings as mongoose.Model<SettingsRecord>) ??
  mongoose.model('Settings', SettingsSchema);

export const DEFAULT_CHANNELS: SettingsDto['channels'] = {
  ats: { mode: 'approve', dailyLimit: 10 },
  cold_email: { mode: 'approve', dailyLimit: 5 },
  // Portals apply only after you connect them (log in once in the browser window).
  naukri: { mode: 'auto', dailyLimit: 5 },
  linkedin: { mode: 'auto', dailyLimit: 5 },
  linkedin_referral: { mode: 'assist', dailyLimit: 10 },
};

export const DEFAULT_TAILORING: SettingsDto['tailoring'] = {
  auto: true,
  minScore: 80,
  dailyLimit: 5,
};

export function defaultSettings(): SettingsDto {
  return {
    killSwitch: false,
    minScore: getEnv().MIN_SCORE,
    tailoring: { ...DEFAULT_TAILORING },
    outreach: { minScore: 75, followUpDays: 4 },
    sources: Object.fromEntries(SOURCE_NAMES.map((s) => [s, true])) as Record<SourceName, boolean>,
    channels: structuredClone(DEFAULT_CHANNELS),
    digest: { enabled: true },
  };
}

function toDto(doc: Record<string, unknown> | null): SettingsDto {
  const def = defaultSettings();
  if (!doc) return def;
  const sources = (doc.sources ?? {}) as Partial<Record<SourceName, boolean>>;
  const channels = (doc.channels ?? {}) as Partial<SettingsDto['channels']>;
  return {
    killSwitch: Boolean(doc.killSwitch),
    minScore: typeof doc.minScore === 'number' ? doc.minScore : def.minScore,
    outreach: {
      ...def.outreach,
      ...((doc.outreach ?? {}) as Partial<SettingsDto['outreach']>),
    },
    tailoring: {
      ...def.tailoring,
      ...((doc.tailoring ?? {}) as Partial<SettingsDto['tailoring']>),
    },
    sources: Object.fromEntries(SOURCE_NAMES.map((s) => [s, sources[s] ?? true])) as Record<
      SourceName,
      boolean
    >,
    channels: Object.fromEntries(
      CHANNEL_NAMES.map((c: ChannelName) => [
        c,
        // "assist" was a placeholder for Naukri before Phase 4 existed.
        channels[c]?.mode && !(c === 'naukri' && channels[c]?.mode === 'assist')
          ? channels[c]
          : def.channels[c],
      ]),
    ) as SettingsDto['channels'],
    digest: { enabled: (doc.digest as { enabled?: boolean } | undefined)?.enabled ?? true },
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : undefined,
  };
}

/** Reads the single settings document, creating it with defaults on first use. */
export async function getSettings(): Promise<SettingsDto> {
  const doc = await SettingsModel.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $setOnInsert: { key: SETTINGS_KEY, ...defaultSettings() } },
    { upsert: true, new: true, lean: true },
  );
  return toDto(doc as Record<string, unknown> | null);
}

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export async function updateSettings(patch: SettingsPatch): Promise<SettingsDto> {
  const set: Record<string, unknown> = {};
  if (patch.killSwitch !== undefined) set.killSwitch = patch.killSwitch;
  if (patch.minScore !== undefined) set.minScore = patch.minScore;
  if (patch.digest?.enabled !== undefined) set['digest.enabled'] = patch.digest.enabled;
  for (const [k, v] of Object.entries(patch.outreach ?? {}))
    if (v !== undefined) set[`outreach.${k}`] = v;
  for (const [k, v] of Object.entries(patch.tailoring ?? {}))
    if (v !== undefined) set[`tailoring.${k}`] = v;
  for (const [k, v] of Object.entries(patch.sources ?? {}))
    if (v !== undefined) set[`sources.${k}`] = v;
  for (const [k, v] of Object.entries(patch.channels ?? {})) if (v) set[`channels.${k}`] = v;

  await getSettings(); // ensure the document exists with defaults
  const doc = await SettingsModel.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: set },
    { new: true, lean: true },
  );
  return toDto(doc as Record<string, unknown> | null);
}
