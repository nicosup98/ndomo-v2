/**
 * ndomo — design_create custom tool (brainstorm-workflow / 30c89728).
 *
 * Write a brainstorm / ADR-style design document to the filesystem under
 * `<projectDir>/.ndomo/designs/YYYY-MM-DD-{slug}-design.md`.
 *
 * DB-free by design: design docs are standalone human-readable artifacts.
 * `planId` and `sessionId` are SOFT references recorded in the markdown
 * frontmatter only (no FK enforcement, no DB connection held).
 *
 * Slug is sanitized (kebab-case, path-traversal-safe) and filename
 * collisions are resolved with a numeric suffix — never overwrites.
 */

import { tool } from "@opencode-ai/plugin";
import type { DesignInput, DesignOption } from "ndomo/db";
import { createDesign, resolveProjectDir } from "ndomo/db";

export default tool({
  description:
    "Create a brainstorm / ADR-style design document on the filesystem at <projectDir>/.ndomo/designs/YYYY-MM-DD-{slug}-design.md. DB-free. slug+title+problem required; planId/sessionId are soft references (no FK check). Filename collisions resolved with a numeric suffix.",
  args: {
    slug: tool.schema.string(),
    title: tool.schema.string(),
    problem: tool.schema.string(),
    goals: tool.schema.array(tool.schema.string()).optional(),
    constraints: tool.schema.array(tool.schema.string()).optional(),
    scope: tool.schema.array(tool.schema.string()).optional(),
    exclusions: tool.schema.array(tool.schema.string()).optional(),
    options: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema.string(),
          description: tool.schema.string().optional(),
          pros: tool.schema.array(tool.schema.string()).optional(),
          cons: tool.schema.array(tool.schema.string()).optional(),
        }),
      )
      .optional(),
    decision: tool.schema.string().optional(),
    tradeoffs: tool.schema.array(tool.schema.string()).optional(),
    consequences: tool.schema.array(tool.schema.string()).optional(),
    openQuestions: tool.schema.array(tool.schema.string()).optional(),
    planId: tool.schema.string().optional(),
    sessionId: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    date: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const input: DesignInput = {
      slug: args.slug,
      title: args.title,
      problem: args.problem,
      ...(args.goals !== undefined && { goals: args.goals }),
      ...(args.constraints !== undefined && { constraints: args.constraints }),
      ...(args.scope !== undefined && { scope: args.scope }),
      ...(args.exclusions !== undefined && { exclusions: args.exclusions }),
      ...(args.options !== undefined && {
        options: args.options as DesignOption[],
      }),
      ...(args.decision !== undefined && { decision: args.decision }),
      ...(args.tradeoffs !== undefined && { tradeoffs: args.tradeoffs }),
      ...(args.consequences !== undefined && { consequences: args.consequences }),
      ...(args.openQuestions !== undefined && { openQuestions: args.openQuestions }),
      ...(args.planId !== undefined && { planId: args.planId }),
      ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
      agent: args.agent ?? ctx.agent ?? "foreman",
      ...(args.date !== undefined && { date: args.date }),
    };
    const result = createDesign(projectDir, input);
    return JSON.stringify(result, null, 2);
  },
});
