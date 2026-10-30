import type { ProviderId } from '@wom/shared';
import type { Generated, Selectable } from 'kysely';

/** All times are ISO 8601 text in UTC. JSON columns hold JSON text. */
export interface AccountsTable {
  id: Generated<number>;
  name: string;
  name_key: string;
  type: string;
  type_source: 'wom' | 'manual';
  notes: string | null;
  created_at: string;
}

export interface SourceStateTable {
  account_id: number;
  kind: string;
  data: string;
  hash: string;
  fetched_at: string;
  file_mtime: string | null;
  error: string | null;
  error_at: string | null;
}

export interface SnapshotsTable {
  id: Generated<number>;
  account_id: number;
  kind: string;
  taken_at: string;
  data: string;
}

export interface CacheTable {
  key: string;
  kind: string;
  fetched_at: string;
  revision: string | null;
  data: string;
}

export interface GoalsTable {
  id: Generated<number>;
  account_id: number;
  title: string;
  kind: string;
  target: string;
  status: 'active' | 'done' | 'dropped';
  position: number;
  created_at: string;
  completed_at: string | null;
  dropped_at: string | null;
}

export interface ChatSessionsTable {
  id: string;
  account_id: number;
  title: string;
  /** The provider whose session provider_session_id is (null when it holds none). */
  provider: ProviderId | null;
  provider_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessagesTable {
  id: Generated<number>;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  usage: string | null;
  created_at: string;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface DB {
  accounts: AccountsTable;
  source_state: SourceStateTable;
  snapshots: SnapshotsTable;
  cache: CacheTable;
  goals: GoalsTable;
  chat_sessions: ChatSessionsTable;
  chat_messages: ChatMessagesTable;
  settings: SettingsTable;
}

export type AccountRow = Selectable<AccountsTable>;
