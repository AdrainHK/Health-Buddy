import { z } from 'zod';

export const clientSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  gender: z.enum(['female', 'male', 'other']).nullable(),
  birthYear: z.number().int().nullable(),
  managerId: z.uuid(),
  isSynthetic: z.boolean(),
});
export type ClientSummary = z.infer<typeof clientSummarySchema>;

export const clientListResponseSchema = z.object({ clients: z.array(clientSummarySchema) });
export type ClientListResponse = z.infer<typeof clientListResponseSchema>;

export const clientResponseSchema = z.object({ client: clientSummarySchema });
export type ClientResponse = z.infer<typeof clientResponseSchema>;
