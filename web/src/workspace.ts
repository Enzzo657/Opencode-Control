import { translate } from "./i18n";
import type { Snapshot, WorkspaceItem } from "./types";

export function agentModel(agent?: Snapshot["agents"][number]) {
  return typeof agent?.model === "string" ? agent.model : agent?.model?.modelID ? `${agent.model.providerID ? `${agent.model.providerID}/` : ""}${agent.model.modelID}` : undefined;
}

export function localizedAgentDescription(name: string, fallback?: string) {
  const descriptions: Record<string, string> = {
    build: translate("agents.buildDescription"), plan: translate("agents.planDescription"), general: translate("agents.generalDescription"), explore: translate("agents.exploreDescription"), scout: translate("agents.scoutDescription"),
  };
  return descriptions[name] ?? fallback ?? translate("agents.serviceDescription");
}

export function modeLabel(mode?: string | null) {
  if (mode === "primary") return translate("agents.primaryMode");
  if (mode === "subagent") return translate("agents.subagentMode");
  if (mode === "all") return translate("agents.allMode");
  return translate("agents.modeUnspecified");
}

export function scopeLabel(scope?: WorkspaceItem["scope"]) {
  if (scope === "project") return translate("workspace.projectScopeLabel");
  if (scope === "global") return translate("workspace.globalScopeLabel");
  if (scope === "runtime") return "Runtime";
  return translate("workspace.builtInScope");
}
