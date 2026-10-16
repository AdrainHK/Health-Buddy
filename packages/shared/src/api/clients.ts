import { z } from 'zod';

export const CLIENT_GENDERS = ['female', 'male', 'other'] as const;
export const clientGenderSchema = z.enum(CLIENT_GENDERS);
export type ClientGender = z.infer<typeof clientGenderSchema>;

export const clientSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  gender: clientGenderSchema.nullable(),
  birthYear: z.number().int().nullable(),
  managerId: z.uuid(),
  isSynthetic: z.boolean(),
});
export type ClientSummary = z.infer<typeof clientSummarySchema>;

export const clientListResponseSchema = z.object({ clients: z.array(clientSummarySchema) });
export type ClientListResponse = z.infer<typeof clientListResponseSchema>;

export const clientResponseSchema = z.object({ client: clientSummarySchema });
export type ClientResponse = z.infer<typeof clientResponseSchema>;
