// Shared types for the sync layer. Drive-facing records and what we store in IndexedDB.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Subset of the Drive v3 File resource that we request (see `FILE_FIELDS` in drive.ts). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  trashed?: boolean;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

/** One entry of the Life OS tree. Only things inside Life OS ever become a TreeNode. */
export interface TreeNode {
  id: string;
  name: string;
  mimeType: string;
  /** Parent folder id; null only for the Life OS root itself. */
  parent: string | null;
  isFolder: boolean;
  isMd: boolean;
  modifiedTime: string;
  md5Checksum: string;
  size: number;
  /** Path relative to Life OS, e.g. "02 Areas/Werk/MEMORY.md". Empty string for the root. */
  path: string;
}

export interface ContentRecord {
  id: string;
  text: string;
  md5Checksum: string;
  modifiedTime: string;
  fetchedAt: number;
}

/** The version of a file from before its latest change, kept for "Wat is er veranderd". */
export interface PreviousRecord {
  id: string;
  text: string;
  md5Checksum: string;
  modifiedTime: string;
  /** When we replaced it with a newer version. */
  replacedAt: number;
}

export interface SyncStats {
  mode: 'full' | 'incremental';
  startedAt: number;
  durationMs: number;
  md: number;
  folders: number;
  otherFiles: number;
  downloaded: number;
  skippedUnchanged: number;
  removed: number;
  added: number;
  modified: number;
  apiCalls: number;
  failedDownloads: number;
}

export type Progress = (msg: string) => void;
