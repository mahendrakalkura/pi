#!/usr/bin/env node
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";
import { setupCli } from "../cli/setup.ts";
import { main } from "../main.ts";
import { bundledExtensions } from "./bundled-extensions.ts";

setupCli();
main(process.argv.slice(2), { extensionFactories: bundledExtensions });
