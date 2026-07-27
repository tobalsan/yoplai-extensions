import type { z } from "zod";
import {
  AddCommentParamsSchema,
  CreateIssueParamsSchema,
  GetCreateMetadataParamsSchema,
  GetIssueParamsSchema,
  GetTransitionsParamsSchema,
  JiraConfigSchema,
  ListCommentsParamsSchema,
  ListParamsSchema,
  SearchParamsSchema,
  SearchUsersParamsSchema,
  TransitionIssueParamsSchema,
  UpdateIssueParamsSchema,
} from "./models.js";

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type ListParams = z.infer<typeof ListParamsSchema>;
export type GetIssueParams = z.infer<typeof GetIssueParamsSchema>;
export type ListCommentsParams = z.infer<typeof ListCommentsParamsSchema>;
export type GetCreateMetadataParams = z.infer<typeof GetCreateMetadataParamsSchema>;
export type GetTransitionsParams = z.infer<typeof GetTransitionsParamsSchema>;
export type SearchParams = z.infer<typeof SearchParamsSchema>;
export type SearchUsersParams = z.infer<typeof SearchUsersParamsSchema>;
export type CreateIssueParams = z.infer<typeof CreateIssueParamsSchema>;
export type UpdateIssueParams = z.infer<typeof UpdateIssueParamsSchema>;
export type AddCommentParams = z.infer<typeof AddCommentParamsSchema>;
export type TransitionIssueParams = z.infer<typeof TransitionIssueParamsSchema>;
