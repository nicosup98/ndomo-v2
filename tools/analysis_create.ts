/**
 * ndomo — analysis_create custom tool.
 *
 * Create a new analysis record in the standalone analyses table.
 * Use for analyst findings, architecture audits, onboarding notes,
 * or cartography outputs. Optionally link to a source plan via sourcePlanId.
 */

import { tool } from "@opencode-ai/plugin";
import type { InsertAnalysis } from "ndomo/db";
import { closeDb, createAnalysis, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description:
    "Create a new analysis record in the standalone analyses table. Use for analyst findings, architecture audits, onboarding notes, or cartography outputs. Optionally link to a source plan via sourcePlanId.",
  args: {
    slug: tool.schema.string(),
    title: tool.schema.string(),
    projectPath: tool.schema.string(),
    summary: tool.schema.string(),
    findingsJson: tool.schema.string(),
    sourcePlanId: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    sessionId: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    // Validate findingsJson is valid JSON
    try {
      JSON.parse(args.findingsJson);
    } catch {
      throw new Error("ndomo: findingsJson must be valid JSON");
    }

    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const input: InsertAnalysis = {
        slug: args.slug,
        title: args.title,
        projectPath: args.projectPath,
        summary: args.summary,
        findingsJson: args.findingsJson,
        agent: args.agent ?? "ranger",
        createdBy: ctx.agent ?? "ranger",
        ...(args.sourcePlanId !== undefined && { sourcePlanId: args.sourcePlanId }),
        ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
      };
      const result = createAnalysis(db, input);
      return JSON.stringify(result, null, 2);
    } finally {
      closeDb(db);
    }
  },
});
