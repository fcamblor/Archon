import { z } from '@hono/zod-openapi';

export const updateCheckResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  })
  .openapi('UpdateCheckResponse');

const ccstatuslineAccountUsageSchema = z.object({
  sessionUsage: z.number().int(),
  sessionResetAt: z.string(),
  weeklyUsage: z.number().int(),
  weeklyResetAt: z.string(),
  extraUsageEnabled: z.boolean(),
});

const ccstatuslineAccountSchema = z.object({
  email: z.string(),
  lastUsageAcquiredOn: z.string(),
  usage: ccstatuslineAccountUsageSchema.nullable(),
  lastError: z.string().nullable(),
});

export const ccstatuslineUsagesResponseSchema = z
  .object({
    usages: z.array(ccstatuslineAccountSchema),
    activeEmail: z.string().nullable().optional(),
  })
  .openapi('CcstatuslineUsagesResponse');
