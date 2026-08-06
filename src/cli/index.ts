#!/usr/bin/env bun
/**
 * ndomo CLI — unified entry point for all subcommands.
 *
 * Usage:
 *   bun run src/cli/index.ts <command> [options]
 *
 * Commands:
 *   status    Show plans grouped by status with task counts
 *   serve     Start the HTTP server
 *   vacuum    Reclaim disk space from .ndomo/state.db
 *   smoke     Run smoke tests
 *   install   Install agents, skills, and config into ~/.config/opencode/
 *   plan      Manage plans: create | list | show | update | approve | complete | delete | assign-task
 *   task      Manage tasks: create | list | show | update | reassign | complete | fail
 *   help      Show this help
 *
 * Each subcommand can also be run directly:
 *   bun run src/cli/status.ts --plans
 *   bun run src/cli/serve.ts --port 8080
 *   bun run src/cli/plan.ts create --slug foo --title Foo --overview "Foo plan"
 *   bun run src/cli/task.ts create --plan <planId> --agent craft --description "Do something"
 */

const COMMANDS: Record<
  string,
  { description: string; run: (args: string[]) => void | Promise<void> }
> = {
  status: {
    description: "Show plans grouped by status with task counts",
    run: async (args) => {
      const { runStatus } = await import("./status.ts");
      runStatus(args);
    },
  },
  serve: {
    description: "Start the HTTP server",
    run: async (args) => {
      const { runServe } = await import("./serve.ts");
      await runServe(args);
    },
  },
  vacuum: {
    description: "Reclaim disk space from .ndomo/state.db",
    run: async (args) => {
      const { vacuumProject } = await import("./vacuum.ts");
      const projectDir = args[0] ?? process.cwd();
      const result = vacuumProject(projectDir);
      const delta = result.sizeBefore - result.sizeAfter;
      console.log(`[vacuum] incremental_vacuum: reclaimed ${result.pagesReclaimed} pages`);
      console.log(`[vacuum] wal_checkpoint(TRUNCATE): ${JSON.stringify(result.checkpoint)}`);
      console.log(
        `[vacuum] file size: ${result.sizeBefore} → ${result.sizeAfter} bytes (${delta >= 0 ? "-" : "+"}${Math.abs(delta)} bytes)`,
      );
    },
  },
  smoke: {
    description: "Run smoke tests",
    run: async () => {
      // smoke.ts runs on import — just import it
      await import("./smoke.ts");
    },
  },
  install: {
    description: "Install agents, skills, and config into ~/.config/opencode/",
    run: async (args) => {
      const { runInstall } = await import("./install.ts");
      await runInstall(args);
    },
  },
  plan: {
    description: "Manage plans: create | list | show | update | approve | complete | delete | assign-task",
    run: async (args) => {
      const { runPlan } = await import("./plan.ts");
      runPlan(args);
    },
  },
  task: {
    description: "Manage tasks: create | list | show | update | reassign | complete | fail",
    run: async (args) => {
      const { runTask } = await import("./task.ts");
      runTask(args);
    },
  },
};

function printHelp(): void {
  console.log(`ndomo CLI — multi-agent plugin

Usage:
  bun run src/cli/index.ts <command> [options]

Commands:`);

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)}${cmd.description}`);
  }

  console.log(`
Each subcommand can also be run directly:
  bun run src/cli/status.ts --plans
  bun run src/cli/serve.ts --port 8080
  bun run src/cli/vacuum.ts`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (!commandName || commandName === "--help" || commandName === "-h" || commandName === "help") {
    printHelp();
    process.exit(commandName ? 0 : 1);
  }

  const command = COMMANDS[commandName];
  if (!command) {
    console.error(
      `error: unknown command "${commandName}". Run "ndomo help" for available commands.`,
    );
    process.exit(1);
  }

  try {
    await command.run(args.slice(1));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Direct execution
if (import.meta.main) {
  await main();
}
