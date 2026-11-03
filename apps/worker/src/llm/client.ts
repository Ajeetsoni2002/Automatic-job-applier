import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { dayKey, getEnv, LlmUsageModel } from '@ja/shared';

export class LlmBudgetExceededError extends Error {}
export class LlmOutputError extends Error {}

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  const env = getEnv();
  client ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    // Keys that aren't scoped to a workspace must name one on every request.
    defaultHeaders: env.ANTHROPIC_WORKSPACE_ID
      ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID }
      : undefined,
  });
  return client;
}

export async function llmCallsToday(): Promise<number> {
  const rows = await LlmUsageModel.find({ date: dayKey() }, { calls: 1 }).lean();
  return rows.reduce((sum, r) => sum + (r.calls ?? 0), 0);
}

async function assertBudget(): Promise<void> {
  const max = getEnv().MAX_LLM_CALLS_PER_DAY;
  if ((await llmCallsToday()) >= max)
    throw new LlmBudgetExceededError(`daily LLM call cap reached (${max})`);
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

async function recordUsage(
  model: string,
  purpose: string,
  usage: UsageLike | undefined,
): Promise<void> {
  await LlmUsageModel.updateOne(
    { date: dayKey(), model, purpose },
    {
      $inc: {
        calls: 1,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      },
    },
    { upsert: true },
  );
}

export interface StructuredCallParams<S extends z.ZodType> {
  purpose: string;
  model: string;
  /** Stable across calls so it can be prompt-cached. */
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  /** Thinking/effort level. Leave unset for Haiku 4.5, which rejects the parameter. */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Server-side refusal fallback (beta): if the model declines, the API re-runs the request on a
   * fallback model in the same call. Recommended for current Sonnet/Opus models on the Claude API.
   */
  fallback?: boolean;
}

export type StructuredCall = <S extends z.ZodType>(
  p: StructuredCallParams<S>,
) => Promise<z.infer<S>>;

/**
 * One Messages API call with a Zod-validated JSON response. Enforces the daily call cap
 * and records token usage. Throws LlmOutputError when the output is unusable.
 */
export const structuredCall: StructuredCall = async ({
  purpose,
  model,
  system,
  user,
  schema,
  maxTokens = 2048,
  effort,
  fallback = false,
}) => {
  await assertBudget();
  const systemBlocks = [
    { type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } },
  ];
  let res;
  try {
    res = fallback
      ? await anthropic().beta.messages.parse({
          model,
          max_tokens: maxTokens,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: systemBlocks,
          messages: [{ role: 'user', content: user }],
          output_config: { format: betaZodOutputFormat(schema), ...(effort && { effort }) },
        })
      : await anthropic().messages.parse({
          model,
          max_tokens: maxTokens,
          system: systemBlocks,
          messages: [{ role: 'user', content: user }],
          output_config: { format: zodOutputFormat(schema), ...(effort && { effort }) },
        });
  } catch (err) {
    // Typed API errors (auth, rate limit, server) propagate as-is; anything else is a parse failure.
    if (err instanceof Anthropic.APIError) throw err;
    throw new LlmOutputError(`could not parse model output: ${(err as Error).message}`);
  }
  await recordUsage(model, purpose, res.usage);

  if (res.stop_reason === 'refusal') throw new LlmOutputError('model declined the request');
  if (res.stop_reason === 'max_tokens')
    throw new LlmOutputError('model output was truncated (max_tokens)');
  if (res.parsed_output == null) throw new LlmOutputError('model output did not match the schema');
  return res.parsed_output as z.infer<typeof schema>;
};
