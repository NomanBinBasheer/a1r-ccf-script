/**
 * Streaming Dropbox Download Module
 * 
 * Downloads large Dropbox folders by streaming to disk instead of memory.
 * This prevents OOM errors for large folders (>500MB).
 * 
 * Created: January 21, 2026
 * For: AllIn1Rentals Boats Migration
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { spawn, execSync } from 'child_process';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Boats known to need streaming (large files)
  LARGE_FILE_BOAT_IDS: ['6', '12', '21', '37', '57', '63'],
  
  // Boats with broken Dropbox links (skip these)
  // Note: 28 and 30 have been fixed by client - removed from list
  BROKEN_LINK_BOAT_IDS: [] as string[],
  
  // Size threshold for using streaming (in MB)
  STREAMING_THRESHOLD_MB: 500,
  
  // Download timeout (30 minutes for very large files)
  DOWNLOAD_TIMEOUT_MS: 30 * 60 * 1000,
  
  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 5000,
};

// ============================================================================
// TYPES
// ============================================================================

export interface DownloadResult {
  success: boolean;
  zipPath?: string;
  sizeMB?: number;
  error?: string;
  usedStreaming: boolean;
}

export interface ExtractionResult {
  success: boolean;
  files: ExtractedFileInfo[];
  error?: string;
}

export interface ExtractedFileInfo {
  name: string;
  path: string;
  size: number;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a boat should use streaming download
 */
export function shouldUseStreaming(boatId: string): { useStreaming: boolean; reason: string } {
  if (CONFIG.BROKEN_LINK_BOAT_IDS.includes(boatId)) {
    return { useStreaming: false, reason: 'BROKEN_LINK - Skip this boat' };
  }
  
  if (CONFIG.LARGE_FILE_BOAT_IDS.includes(boatId)) {
    return { useStreaming: true, reason: 'Known large file boat' };
  }
  
  return { useStreaming: false, reason: 'Standard size - use memory download' };
}

/**
 * Check if a boat has a broken Dropbox link
 */
export function hasBrokenLink(boatId: string): boolean {
  return CONFIG.BROKEN_LINK_BOAT_IDS.includes(boatId);
}

/**
 * Prepare Dropbox URL for download
 */
export function prepareDownloadUrl(shareUrl: string): string {
  let url = shareUrl.trim();
  
  // Remove trailing pipe character (found in some URLs)
  if (url.endsWith('|')) url = url.slice(0, -1);
  
  // Convert to direct download URL
  if (url.includes('dl=0')) {
    url = url.replace('dl=0', 'dl=1');
  } else if (!url.includes('dl=1')) {
    url += (url.includes('?') ? '&' : '?') + 'dl=1';
  }
  
  return url;
}

/**
 * Create temp directory for downloads
 * Uses project directory instead of /tmp to avoid tmpfs quota issues
 */
export function createTempDir(boatId: string): string {
  // Use project directory's temp folder instead of system /tmp (which may be tmpfs with limited space)
  const projectTempBase = join(process.cwd(), '.temp-downloads');
  const tempDir = join(projectTempBase, `boat-${boatId}-${Date.now()}`);
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

/**
 * Clean up temp directory
 */
export function cleanupTempDir(tempDir: string): void {
  try {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Warning: Could not clean up temp dir: ${tempDir}`);
  }
}

// ============================================================================
// STREAMING DOWNLOAD
// ============================================================================

/**
 * Download Dropbox folder as ZIP using streaming (writes to disk, not memory)
 * 
 * This function:
 * 1. Creates a temp directory
 * 2. Streams the ZIP file directly to disk
 * 3. Returns the path to the downloaded ZIP
 * 
 * This prevents OOM errors for large files (1GB+)
 */
export async function streamingDownloadZip(
  shareUrl: string,
  boatId: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<DownloadResult> {
  const downloadUrl = prepareDownloadUrl(shareUrl);
  const tempDir = createTempDir(boatId);
  const zipPath = join(tempDir, `boat_${boatId}.zip`);
  
  console.log(`   [Streaming] Downloading to: ${zipPath}`);
  
  let lastRetryError = '';
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.DOWNLOAD_TIMEOUT_MS);
      
      const response = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        // Dropbox returned HTML instead of ZIP - link is broken
        return {
          success: false,
          error: 'Dropbox returned HTML instead of ZIP - link may be broken or folder is empty',
          usedStreaming: true,
        };
      }
      
      const contentLength = parseInt(response.headers.get('content-length') || '0');
      const sizeMB = contentLength / (1024 * 1024);
      
      console.log(`   [Streaming] Total size: ${sizeMB.toFixed(2)} MB`);
      
      // Stream to file
      if (!response.body) {
        throw new Error('No response body');
      }
      
      const fileStream = createWriteStream(zipPath);
      
      // Convert web ReadableStream to Node.js Readable
      const reader = response.body.getReader();
      let downloadedBytes = 0;
      
      const nodeStream = new Readable({
        async read() {
          try {
            const { done, value } = await reader.read();
            if (done) {
              this.push(null);
            } else {
              downloadedBytes += value.length;
              if (onProgress && contentLength > 0) {
                onProgress(downloadedBytes, contentLength);
              }
              this.push(Buffer.from(value));
            }
          } catch (err) {
            this.destroy(err as Error);
          }
        }
      });
      
      await pipeline(nodeStream, fileStream);
      
      // Verify file was written
      if (!existsSync(zipPath)) {
        throw new Error('ZIP file was not created');
      }
      
      const actualSize = statSync(zipPath).size;
      console.log(`   [Streaming] Downloaded: ${(actualSize / 1024 / 1024).toFixed(2)} MB`);
      
      return {
        success: true,
        zipPath,
        sizeMB: actualSize / (1024 * 1024),
        usedStreaming: true,
      };
      
    } catch (error: any) {
      lastRetryError = error.message;
      console.log(`   [Streaming] Attempt ${attempt}/${CONFIG.MAX_RETRIES} failed: ${error.message}`);
      
      if (attempt < CONFIG.MAX_RETRIES) {
        const delay = CONFIG.RETRY_DELAY_MS * attempt;
        console.log(`   [Streaming] Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // Clean up failed download
      try {
        if (existsSync(zipPath)) unlinkSync(zipPath);
      } catch {}
    }
  }
  
  return {
    success: false,
    error: `Download failed after ${CONFIG.MAX_RETRIES} attempts: ${lastRetryError}`,
    usedStreaming: true,
  };
}

// ============================================================================
// ZIP EXTRACTION (Using unzip command for large files)
// ============================================================================

/**
 * Extract ZIP file using system unzip command
 * This is more memory-efficient than AdmZip for large files
 */
export async function extractZipToDir(zipPath: string, outputDir: string): Promise<ExtractionResult> {
  if (!existsSync(zipPath)) {
    return { success: false, files: [], error: 'ZIP file does not exist' };
  }
  
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  return new Promise((resolve) => {
    // Try unzip first
    try {
      // Use system unzip command (more memory efficient)
      // UNZIP_DISABLE_ZIPBOMB_DETECTION=TRUE handles Dropbox's nested folder structure
      execSync(`UNZIP_DISABLE_ZIPBOMB_DETECTION=TRUE unzip -o -q "${zipPath}" -d "${outputDir}" 2>/dev/null || true`, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
        timeout: 15 * 60 * 1000, // 15 minute timeout for large files
      });
    } catch (e) {
      // Ignore errors - we'll check if files were extracted
    }
    
    // Check if files were extracted despite any errors
    const files = getMediaFiles(outputDir);
    
    if (files.length > 0) {
      console.log(`   [Extract] Found ${files.length} media files`);
      resolve({
        success: true,
        files,
      });
      return;
    }
    
    // If no files, try Python's zipfile as fallback
    try {
      console.log(`   [Extract] No files from unzip, trying Python zipfile...`);
      const pythonScript = `
import zipfile
import os
import sys

zip_path = sys.argv[1]
output_dir = sys.argv[2]

with zipfile.ZipFile(zip_path, 'r') as zf:
    for member in zf.namelist():
        try:
            zf.extract(member, output_dir)
        except Exception as e:
            print(f"Skipped: {member} - {e}", file=sys.stderr)
print("Extraction complete")
`;
      execSync(`python3 -c '${pythonScript}' "${zipPath}" "${outputDir}"`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20 * 60 * 1000,
      });
      
      const filesAfterPython = getMediaFiles(outputDir);
      console.log(`   [Extract] Found ${filesAfterPython.length} media files`);
      resolve({
        success: filesAfterPython.length > 0,
        files: filesAfterPython,
        error: filesAfterPython.length === 0 ? 'No media files extracted' : undefined,
      });
      
    } catch (fallbackError: any) {
      resolve({
        success: false,
        files: [],
        error: `Extraction failed: ${fallbackError.message}`,
      });
    }
  });
}

/**
 * Recursively get all media files from a directory
 */
function getMediaFiles(dir: string, baseDir?: string): ExtractedFileInfo[] {
  const files: ExtractedFileInfo[] = [];
  const base = baseDir || dir;
  
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif'];
  const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
  const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
  
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip macOS metadata folders
        if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
        
        // Recurse into subdirectories
        files.push(...getMediaFiles(fullPath, base));
        
      } else if (entry.isFile()) {
        // Skip hidden files and macOS metadata
        if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;
        
        const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
        if (MEDIA_EXTENSIONS.includes(ext)) {
          const stat = statSync(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            size: stat.size,
          });
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory: ${dir}`);
  }
  
  return files;
}

// ============================================================================
// MAIN STREAMING MIGRATION FUNCTION
// ============================================================================

/**
 * Download and extract Dropbox folder using streaming
 * Returns array of local file paths to media files
 */
export async function streamingDropboxMigration(
  shareUrl: string,
  boatId: string,
  boatName: string
): Promise<{ success: boolean; files: ExtractedFileInfo[]; tempDir: string; error?: string }> {
  
  // Check for broken links
  if (hasBrokenLink(boatId)) {
    return {
      success: false,
      files: [],
      tempDir: '',
      error: 'BROKEN_LINK: This boat has a broken Dropbox link that needs client follow-up',
    };
  }
  
  console.log(`   [Streaming Migration] Starting for boat ${boatId}: ${boatName}`);
  
  // Step 1: Download ZIP
  const downloadResult = await streamingDownloadZip(shareUrl, boatId, (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(1);
    process.stdout.write(`\r   [Streaming] Progress: ${percent}%    `);
  });
  
  process.stdout.write('\n');
  
  if (!downloadResult.success || !downloadResult.zipPath) {
    return {
      success: false,
      files: [],
      tempDir: '',
      error: downloadResult.error || 'Download failed',
    };
  }
  
  // Step 2: Extract ZIP
  const tempDir = join(downloadResult.zipPath, '..', 'extracted');
  const extractResult = await extractZipToDir(downloadResult.zipPath, tempDir);
  
  // Clean up ZIP file to save space
  try {
    if (downloadResult.zipPath && existsSync(downloadResult.zipPath)) {
      unlinkSync(downloadResult.zipPath);
    }
  } catch {}
  
  if (!extractResult.success) {
    return {
      success: false,
      files: [],
      tempDir: '',
      error: extractResult.error || 'Extraction failed',
    };
  }
  
  return {
    success: true,
    files: extractResult.files,
    tempDir,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  shouldUseStreaming,
  hasBrokenLink,
  prepareDownloadUrl,
  streamingDownloadZip,
  extractZipToDir,
  streamingDropboxMigration,
  cleanupTempDir,
  CONFIG,
};
