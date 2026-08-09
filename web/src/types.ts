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

export type ControlEvent = {
  id: string;
  project_id: string;
  project_name: string;
  task_id: string | null;
  session_id: string | null;
  run_id: string | null;
  permission_id: string | null;
  kind: string;
  severity: "info" | "warning" | "error" | "action";
  resource_title: string;
  detail: string | null;
  occurred_at: string;
  read_at: string | null;
};

export type EventFeed = {
  events: ControlEvent[];
  unread: number;
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
  control_task?: {
    id: string;
    title: string;
    status?: string;
    session_status?: string;
    session_error?: string;
  };
};

export type UsageTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
};

export type UsageRow = {
  id: string;
  name?: string;
  tokens: UsageTokens;
  tokens_total: number;
  cost: number;
  messages: number;
  sessions: number;
};

export type DashboardUsage = {
  scope: "project" | "global";
  period: "today" | "7d" | "30d" | "all";
  timezone: string;
  generated_at: string;
  partial: boolean;
  unavailable_projects: Array<{ id: string; name: string; error: string }>;
  totals: UsageRow & { active: number; mcp_connected: number; mcp_total: number };
  projects: UsageRow[];
  models: UsageRow[];
  providers: UsageRow[];
  agents: UsageRow[];
  daily: UsageRow[];
  recent_sessions: Array<Session & {
    project_id: string;
    project_name: string;
    status: string;
  }>;
};

export type SearchResult = {
  kind: "session" | "message";
  project_id: string;
  project_name: string;
  session_id: string;
  session_title: string;
  message_id: string | null;
  role: string | null;
  created_at: number | null;
  snippet: string;
};

export type SearchResponse = {
  query: string;
  scope: "project" | "global";
  partial: boolean;
  unavailable_projects: Array<{ id: string; name: string; error: string }>;
  indexed_sessions: number;
  offset: number;
  has_more: boolean;
  results: SearchResult[];
};

export type Artifact = {
  id: string;
  kind: "image" | "pdf" | "archive" | "data" | "text";
  name: string;
  mime: string;
  size: number;
  modified_at: number;
  created_at: number | null;
  project_id: string;
  project_name: string;
  session_id: string | null;
  session_title: string | null;
  message_id: string | null;
  media_url: string | null;
  download_url: string;
};

export type ArtifactsResponse = {
  scope: "project" | "global";
  partial: boolean;
  unavailable_projects: Array<{ id: string; name: string; error: string }>;
  indexed_sessions: number;
  has_more: boolean;
  artifacts: Artifact[];
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

export type SkillImportPreview = {
  preview_id: string;
  expires_at: string;
  source_url: string;
  final_url: string;
  redirects: number;
  content: string;
  markdown: string;
  sha256: string;
  bytes: number;
  file_count: number;
  commit?: string | null;
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
    executable: boolean;
    kind: string;
  }>;
  name: string;
  description: string;
  scope: "project" | "global";
  target_path: string;
  conflict: {
    target_exists: boolean;
    has_conflict: boolean;
    matches: Array<{
      id: string;
      name: string;
      scope?: string;
      source?: string;
      editable?: boolean;
    }>;
  };
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
