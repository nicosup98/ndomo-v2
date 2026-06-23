#!/usr/bin/env bun
import { runAnalyses } from "../src/cli/analyses.ts";

runAnalyses(process.argv.slice(2));
