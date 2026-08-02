import { translate } from "./i18n";
import type { CommandItem } from "./types";

export function commandDisplayDescription(item: CommandItem) { if (item.id === "init") return translate("commands.initDescription"); if (item.id === "customize-opencode") return translate("commands.customizeOpenCodeDescription"); if (item.id === "context7-mcp") return translate("commands.context7McpDescription"); return item.description || translate("commands.descriptionFallback"); }
