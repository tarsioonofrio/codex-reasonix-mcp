import { z } from 'zod';

import { REASONING_EFFORTS } from './types.js';

export const REASONIX_STATUS_METHOD = '_reasonix.io/session/status';
export const REASONIX_STATUS_UPDATE_METHOD = '_reasonix.io/session/status_update';
export const REASONIX_STEER_METHOD = '_reasonix.io/session/steer';
export const REASONIX_STATUS_SCHEMA_VERSION = 1;

const usageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheHitTokens: z.number().int().nonnegative(),
    cacheMissTokens: z.number().int().nonnegative(),
    cacheHitRatio: z.number().min(0).max(1).nullable(),
    estimatedCost: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
    usageSource: z.string().min(1),
    // Reasonix v1.38.x reports this additional aggregate counter. It is
    // compatibility metadata and is intentionally projected out before the
    // bridge persists canonical UsageTotals.
    totalTokens: z.number().int().nonnegative().optional(),
    // Reasonix >= 1.19.4 marks each turn/cumulative usage total as estimated.
    // This compatibility-only metadata is projected out before persistence.
    estimated: z.boolean().optional(),
    // Reasonix v1.38.x may expose display/cost bookkeeping alongside the
    // canonical counters. Keep the bridge strict about their shape while
    // treating them as compatibility metadata projected out before storage.
    costComplete: z.boolean().optional(),
    displayComplete: z.boolean().optional(),
    displayStatus: z.string().optional(),
    costQuote: z
      .object({
        original: z.object({ amount: z.string(), currency: z.string() }).strict(),
        estimated: z.boolean(),
        costComplete: z.boolean(),
        displayComplete: z.boolean(),
        complete: z.boolean(),
        displayStatus: z.string(),
        incompleteReason: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const goalRuntimeSchema = z
  .object({
    turnsUsed: z.number().int().nonnegative(),
    turnsLimit: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    requestsUsed: z.number().int().nonnegative(),
    workDurationMs: z.number().int().nonnegative().optional(),
    tokensLimit: z.number().int().nonnegative(),
    noProgressTurns: z.number().int().nonnegative(),
    noProgressLimit: z.number().int().nonnegative(),
    budgetExtensions: z.number().int().nonnegative(),
  })
  .strict();

export const reasonixStatusSchema = z
  .object({
    schemaVersion: z.literal(REASONIX_STATUS_SCHEMA_VERSION),
    sequence: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    state: z.enum(['running', 'idle']),
    model: z.string().min(1),
    effort: z.enum(REASONING_EFFORTS),
    mode: z.enum(['normal', 'plan', 'goal']),
    workMode: z.enum(['economy', 'balanced', 'delivery']),
    plannerMode: z.enum(['off', 'on']),
    goal: z
      .object({
        status: z.enum(['none', 'running', 'complete', 'blocked', 'failed', 'cancelled']),
        objective: z.string().optional(),
        // Goal runtime counters were added by Reasonix v1.38.x. They are
        // diagnostic metadata and do not alter the bridge's task state.
        runtime: goalRuntimeSchema.optional(),
      })
      .strict(),
    phase: z.string().min(1),
    turnOutcome: z
      .object({
        kind: z.enum(['none', 'completed', 'paused', 'cancelled', 'error']),
        reason: z.string().optional(),
        // Error snapshots from Reasonix v1.38.x include a compact diagnostic
        // classification in addition to the canonical outcome kind.
        diagnostic: z
          .object({ kind: z.string().min(1) })
          .strict()
          .optional(),
      })
      .strict(),
    finalReadiness: z
      .object({
        readyForReview: z.boolean(),
        summary: z.string(),
        risks: z.array(z.string()),
      })
      .strict(),
    sandbox: z
      .object({
        mode: z.literal('enforce'),
        engine: z.enum(['bubblewrap', 'seatbelt']),
        available: z.boolean(),
        workspaceRoot: z.string().min(1),
        writeRoots: z.array(z.string()),
        networkEnabled: z.boolean(),
      })
      .strict(),
    usage: z.object({ turn: usageSchema, cumulative: usageSchema }).strict(),
  })
  .strict();

export type ReasonixStatus = z.infer<typeof reasonixStatusSchema>;

export const reasonixStatusUpdateSchema = z
  .object({
    schemaVersion: z.literal(REASONIX_STATUS_SCHEMA_VERSION),
    sequence: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    event: z.enum(['phase', 'usage', 'pause', 'completion', 'error']),
    status: reasonixStatusSchema,
  })
  .strict();

export type ReasonixStatusUpdate = z.infer<typeof reasonixStatusUpdateSchema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

/**
 * Keep the wire boundary tolerant of additive Reasonix metadata while the
 * canonical schema above remains strict for persisted/contract data. Reasonix
 * adds diagnostic fields between releases; none of these fields drive bridge
 * policy or task state, so unknown additions are safely projected out here.
 */
function normalizeStatus(raw: unknown): unknown {
  const source = record(raw);
  const normalized = pick(source, [
    'schemaVersion',
    'sequence',
    'sessionId',
    'state',
    'model',
    'effort',
    'mode',
    'workMode',
    'plannerMode',
    'goal',
    'phase',
    'turnOutcome',
    'finalReadiness',
    'sandbox',
    'usage',
  ]);
  const goal = pick(source.goal, ['status', 'objective', 'runtime']);
  if ('runtime' in goal) {
    goal.runtime = pick(goal.runtime, [
      'turnsUsed',
      'turnsLimit',
      'tokensUsed',
      'requestsUsed',
      'workDurationMs',
      'tokensLimit',
      'noProgressTurns',
      'noProgressLimit',
      'budgetExtensions',
    ]);
  }
  normalized.goal = goal;
  const turnOutcome = pick(source.turnOutcome, ['kind', 'reason', 'diagnostic']);
  if ('diagnostic' in turnOutcome) {
    turnOutcome.diagnostic = pick(turnOutcome.diagnostic, ['kind']);
  }
  normalized.turnOutcome = turnOutcome;
  normalized.finalReadiness = pick(source.finalReadiness, ['readyForReview', 'summary', 'risks']);
  normalized.sandbox = pick(source.sandbox, [
    'mode',
    'engine',
    'available',
    'workspaceRoot',
    'writeRoots',
    'networkEnabled',
  ]);
  const usage = record(source.usage);
  normalized.usage = {
    turn: pick(usage.turn, [
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
      'cacheHitTokens',
      'cacheMissTokens',
      'cacheHitRatio',
      'estimatedCost',
      'currency',
      'usageSource',
      'totalTokens',
      'estimated',
      'costComplete',
      'displayComplete',
      'displayStatus',
      'costQuote',
    ]),
    cumulative: pick(usage.cumulative, [
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
      'cacheHitTokens',
      'cacheMissTokens',
      'cacheHitRatio',
      'estimatedCost',
      'currency',
      'usageSource',
      'totalTokens',
      'estimated',
      'costComplete',
      'displayComplete',
      'displayStatus',
      'costQuote',
    ]),
  };
  return normalized;
}

export function parseReasonixStatus(raw: unknown): ReasonixStatus {
  return reasonixStatusSchema.parse(normalizeStatus(raw));
}

export function parseReasonixStatusUpdate(raw: unknown): ReasonixStatusUpdate {
  const source = record(raw);
  return reasonixStatusUpdateSchema.parse({
    ...pick(source, ['schemaVersion', 'sequence', 'sessionId', 'event']),
    status: normalizeStatus(source.status),
  });
}

export function assertReasonixStatusCapability(meta: unknown): void {
  if (!meta || typeof meta !== 'object')
    throw new Error('Reasonix status capability metadata missing');
  const capabilities = meta as Record<string, unknown>;
  for (const name of [REASONIX_STATUS_METHOD, REASONIX_STATUS_UPDATE_METHOD]) {
    const value = capabilities[name];
    if (
      !value ||
      typeof value !== 'object' ||
      (value as Record<string, unknown>).schemaVersion !== REASONIX_STATUS_SCHEMA_VERSION
    ) {
      throw new Error(`Required Reasonix ACP extension unavailable: ${name} schemaVersion 1`);
    }
  }
}
