/**
 * Worktree file copy and link utility
 *
 * Copies or symlinks git-ignored files from the canonical repo to a new worktree
 * based on configuration in .archon/config.yaml
 */

import { copyFile, cp, stat, mkdir, symlink, readlink, rm } from 'fs/promises';
import { join, dirname, relative, isAbsolute, normalize } from 'path';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-copy');
  return cachedLog;
}

export interface CopyFileEntry {
  source: string;
  destination: string;
}

/**
 * Parse a file entry string from config into a `CopyFileEntry`.
 * Source and destination are always the same trimmed path.
 *
 * @param entry - Config entry like ".env" or ".serena/cache"
 * @param label - Human-readable label used in the error message (e.g. "Copy" or "Link")
 * @returns Parsed source and destination (always identical)
 * @throws Error if entry is empty
 */
function parseFileEntry(entry: string, label: string): CopyFileEntry {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error(`${label} entry cannot be empty`);
  }
  return { source: trimmed, destination: trimmed };
}

/**
 * Parse a copy file entry from config.
 * Each entry is a path to a git-ignored file or directory to copy into worktrees.
 *
 * @param entry - Config entry like ".env" or "data/fixtures/"
 * @returns Parsed source and destination (always identical)
 * @throws Error if entry is empty
 */
export function parseCopyFileEntry(entry: string): CopyFileEntry {
  return parseFileEntry(entry, 'Copy');
}

/**
 * Check if a path escapes its root directory (path traversal attack)
 * Works on both Unix and Windows paths
 *
 * @param root - The root directory path
 * @param filePath - The relative file path to check
 * @returns true if path stays within root, false if it escapes
 */
export function isPathWithinRoot(root: string, filePath: string): boolean {
  const relativePath = relative(normalize(root), normalize(join(root, filePath)));
  // If relative path starts with '..' or is absolute, it escapes the root
  // On Windows, cross-drive paths will be absolute (e.g., "D:\other")
  return !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

/**
 * Validate that the entry's source and destination paths don't escape their roots.
 * Logs an error and returns false if either path escapes; returns true if both are safe.
 */
function validateEntryPaths(sourceRoot: string, destRoot: string, entry: CopyFileEntry): boolean {
  if (!isPathWithinRoot(sourceRoot, entry.source)) {
    getLog().error(
      { source: entry.source, sourceRoot, reason: 'Source path escapes repository root' },
      'path_traversal_blocked'
    );
    return false;
  }
  if (!isPathWithinRoot(destRoot, entry.destination)) {
    getLog().error(
      {
        destination: entry.destination,
        destRoot,
        reason: 'Destination path escapes worktree root',
      },
      'path_traversal_blocked'
    );
    return false;
  }
  return true;
}

/**
 * Copy a single file or directory from source repo to worktree
 *
 * @param sourceRoot - Canonical repo path
 * @param destRoot - Worktree path
 * @param entry - Parsed copy file entry
 * @returns true if copied successfully, false if:
 *   - Source doesn't exist (ENOENT) - expected, silently skipped
 *   - Path traversal detected - security violation, logged as error
 *   - Other errors (permissions, disk full, etc.) - logged as error
 */
export async function copyWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  if (!validateEntryPaths(sourceRoot, destRoot, entry)) {
    return false;
  }

  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  try {
    const stats = await stat(sourcePath);

    // Ensure destination directory exists
    await mkdir(dirname(destPath), { recursive: true });

    if (stats.isDirectory()) {
      // Copy directory recursively
      await cp(sourcePath, destPath, { recursive: true });
    } else {
      // Copy single file
      await copyFile(sourcePath, destPath);
    }

    getLog().debug({ source: entry.source, destination: entry.destination }, 'file_copied');
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ENOENT') {
      // Source doesn't exist - expected case, skip silently
      // This matches worktree-manager skill behavior
      getLog().debug({ source: entry.source }, 'file_skipped_not_found');
      return false;
    }

    // Unexpected error - log with full context for debugging
    getLog().error(
      {
        source: entry.source,
        destination: entry.destination,
        sourcePath,
        destPath,
        err,
        code: err.code ?? 'UNKNOWN',
      },
      'copy_failed'
    );
    return false;
  }
}

/**
 * Copy all configured files from canonical repo to worktree
 *
 * @param canonicalRepoPath - Path to the main repository
 * @param worktreePath - Path to the new worktree
 * @param copyFiles - Array of file paths from config
 * @returns Array of successfully copied entries
 */
export async function copyWorktreeFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  copyFiles: string[]
): Promise<CopyFileEntry[]> {
  const copied: CopyFileEntry[] = [];

  for (const fileConfig of copyFiles) {
    try {
      const entry = parseCopyFileEntry(fileConfig);
      const success = await copyWorktreeFile(canonicalRepoPath, worktreePath, entry);
      if (success) {
        copied.push(entry);
      }
    } catch (parseError) {
      // Invalid config entry - log and continue with other entries
      const err = parseError as Error;
      getLog().error({ entry: fileConfig, err }, 'invalid_config_entry');
    }
  }

  return copied;
}

/**
 * Parse a link file entry from config.
 * Each entry is a path to a git-ignored file or directory to symlink into worktrees.
 *
 * @param entry - Config entry like ".serena/cache" or ".entire/metadata"
 * @returns Parsed source and destination (always identical)
 * @throws Error if entry is empty
 */
export function parseLinkFileEntry(entry: string): CopyFileEntry {
  return parseFileEntry(entry, 'Link');
}

/**
 * Create a symlink in the worktree pointing to the source in the canonical repo.
 * Auto-creates the source directory if absent (so tools can write to it).
 * Idempotent: no-op if symlink already points to the correct target.
 * Stale symlinks and real files/directories at the destination are replaced.
 *
 * @param sourceRoot - Canonical repo path
 * @param destRoot - Worktree path
 * @param entry - Parsed link file entry
 * @returns true if linked (or already correctly linked), false on error
 */
export async function linkWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  if (!validateEntryPaths(sourceRoot, destRoot, entry)) {
    return false;
  }

  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  let phase = 'mkdir';
  try {
    // Auto-create source directory if absent (so tools can write to the shared location)
    await mkdir(sourcePath, { recursive: true });

    // Ensure parent directory for symlink exists in worktree
    await mkdir(dirname(destPath), { recursive: true });

    // Idempotency: if symlink already points to the correct target, skip
    phase = 'readlink';
    try {
      const existingTarget = await readlink(destPath);
      if (existingTarget === sourcePath) {
        getLog().debug(
          { source: entry.source, destination: entry.destination },
          'link_already_correct'
        );
        return true;
      }
      // Wrong target — remove stale symlink and re-link
      phase = 'rm-stale';
      await rm(destPath, { recursive: true, force: true });
    } catch (readlinkError) {
      const err = readlinkError as NodeJS.ErrnoException;
      // ENOENT = path doesn't exist yet (expected, proceed to create)
      // EINVAL = not a symlink — real file/dir exists at destPath (handle below)
      // Any other error is unexpected: re-throw
      if (err.code !== 'ENOENT' && err.code !== 'EINVAL') {
        throw readlinkError;
      }
      if (err.code === 'EINVAL') {
        // A real file or directory exists at destPath — remove it and replace with symlink
        getLog().warn({ destination: entry.destination, destPath }, 'link_replacing_existing_path');
        phase = 'rm-existing';
        await rm(destPath, { recursive: true, force: true });
      }
      // ENOENT: nothing there, proceed to create
    }

    phase = 'symlink';
    await symlink(sourcePath, destPath, 'junction');

    getLog().debug({ source: entry.source, destination: entry.destination }, 'file_linked');
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      {
        source: entry.source,
        destination: entry.destination,
        sourcePath,
        destPath,
        phase,
        err,
        code: err.code ?? 'UNKNOWN',
      },
      'link_failed'
    );
    return false;
  }
}

/**
 * Create symlinks for all configured link-files from canonical repo to worktree.
 * Invalid or empty entries are skipped (logged as errors) and do not abort the batch.
 *
 * @param canonicalRepoPath - Path to the main repository
 * @param worktreePath - Path to the new worktree
 * @param linkFiles - Array of file paths from config
 * @returns Array of successfully linked entries (may be shorter than input on errors)
 */
export async function linkWorktreeFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  linkFiles: string[]
): Promise<CopyFileEntry[]> {
  const linked: CopyFileEntry[] = [];

  for (const fileConfig of linkFiles) {
    try {
      const entry = parseLinkFileEntry(fileConfig);
      const success = await linkWorktreeFile(canonicalRepoPath, worktreePath, entry);
      if (success) {
        linked.push(entry);
      }
    } catch (parseError) {
      // Invalid config entry - log and continue with other entries
      const err = parseError as Error;
      getLog().error({ entry: fileConfig, err }, 'invalid_link_config_entry');
    }
  }

  return linked;
}
