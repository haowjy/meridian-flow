import type { CommandGroup } from "../../core/command";
import { packageFetchCommand } from "./fetch";

export const packageGroup: CommandGroup = {
  name: "package",
  summary: "Fetch a GitHub tree through the server's package port",
  commands: [packageFetchCommand],
};
