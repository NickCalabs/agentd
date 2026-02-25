import { Command } from "commander";
import { start, stop, status } from "./daemon.ts";

const program = new Command();

program
  .name("agentd")
  .description("Universal agent runtime daemon")
  .version("0.1.0");

program
  .command("start")
  .description("Start the agentd daemon")
  .action(start);

program
  .command("stop")
  .description("Stop the agentd daemon")
  .action(stop);

program
  .command("status")
  .description("Show daemon status")
  .action(status);

program.parse();
