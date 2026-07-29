export type ServerState = {
  state: "running" | "stopped" | "external";
  managed: boolean;
  endpoint: string | null;
  pid?: number | null;
  version?: string | null;
  compatibility?: {
    state: "compatible" | "untested_newer" | "incompatible" | "unknown";
    version: string | null;
    message: string | null;
  } | null;
  last_error?: {
    phase: string;
    summary: string;
    timestamp: string;
    log_path: string;
    exit_code?: number | null;
    detail?: string | null;
  } | null;
};

export type Project = {
  id: string;
  name: string;
  root: string;
  endpoint: string | null;
  created_at: string;
  updated_at: string;
  server: ServerState;
};

export type Session = {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; updated?: number };
  control_task?: { id: string; title: string; status?: string };
};

export type Agent = {
  name: string;
  description?: string;
  mode?: string;
  model?: string | { providerID?: string; modelID?: string };
  native?: boolean;
  hidden?: boolean;
};

export type WorkspaceItem = {
  id: string;
  effective_name?: string;
  description?: string | null;
  mode?: string | null;
  model?: string | null;
  content: string;
  scope?: "project" | "global" | "runtime";
  source?: string;
  editable?: boolean;
  internal?: boolean;
};

export type CommandItem = {
  id: string;
  description?: string | null;
  agent?: string | null;
  model?: string | null;
  variant?: string | null;
  subtask?: boolean;
  content: string;
  scope?: "project" | "global" | "runtime";
  source?: string;
  editable?: boolean;
  runtime?: boolean;
  has_shell?: boolean;
  has_arguments?: boolean;
  kind?: "command" | "skill";
};

export type RuntimeConfig = {
  model?: string;
  small_model?: string;
  default_agent?: string;
  mcp?: Record<string, { type?: string; enabled?: boolean }>;
  configured_providers?: string[];
};

export type ProviderSummary = {
  id: string;
  name?: string;
  model_count: number;
  models: string[];
  model_variants?: Record<string, string[]>;
  default_model?: string | null;
};

export type Attachment = {
  filename: string;
  mime: string;
  data_url: string;
};

export type SecretInfo = {
  name: string;
  path: string;
  reference: string;
};

export type ProviderAuthPrompt = {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string; hint?: string }>;
};

export type ProviderAuthMethod = {
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderAuthPrompt[];
};

export type ProviderAuthEntry = {
  id: string;
  name: string;
  connected: boolean;
  configured?: boolean;
  methods: ProviderAuthMethod[];
};

export type Task = {
  id: string;
  project_id: string;
  title: string;
  prompt: string;
  agent: string | null;
  model: string | null;
  variant?: string | null;
  status: string;
  session_id: string | null;
  session_ids?: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
  cron?: string | null;
  timezone?: string | null;
  schedule_enabled?: number | boolean;
  cron_session_mode?: "new" | "reuse";
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_scheduled_run?: {
    id: string;
    scheduled_for: string;
    status: "pending" | "claimed" | "session_created" | "running" | "ambiguous" | "completed" | "failed" | "skipped" | "cancelled" | "aborted";
    attempt_count: number;
    session_id: string | null;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  } | null;
};

export type GitChange = {
  path: string;
  status: string;
  previous_path?: string;
  staged: boolean;
  unstaged: boolean;
};

export type GitCommit = {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: number;
  subject: string;
};

export type GitState = {
  available: boolean;
  branch: string | null;
  repository?: string;
  revision?: string;
  changes: GitChange[];
  commits: GitCommit[];
};

export type Snapshot = {
  state: "connected" | "degraded" | "stopped";
  errors: string[];
  health?: { healthy?: boolean; version?: string };
  sessions: Session[];
  statuses: Record<string, { type?: string; status?: string }>;
  agents: Agent[];
  mcp?: Record<string, { status?: string; error?: string }>;
  providers?: { connected: string[]; available: ProviderSummary[] };
  config?: RuntimeConfig;
  server: ServerState;
};
