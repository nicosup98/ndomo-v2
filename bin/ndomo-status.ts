#!/usr/bin/env bun
import { runStatus } from "../src/cli/status.ts";

runStatus(process.argv.slice(2));
