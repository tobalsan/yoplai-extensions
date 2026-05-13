import type { z } from "zod";
import { JiraConfigSchema } from "./models.js";

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
