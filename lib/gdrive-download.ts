/**
 * Google Drive Download Module
 * 
 * Downloads Google Drive folders by fetching files individually.
 * Google Drive doesn't support direct ZIP download like Dropbox,
 * so we need to list files and download each one.
 * 
 * Created: January 20, 2026
 * For: AllIn1Rentals Boats Migration
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { join } from 'path';
import { execSync } from 'child_process';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Download timeout per file (10 minutes)
  DOWNLOAD_TIMEOUT_MS: 10 * 60 * 1000,
  
  // Retry settings
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 3000,
};

// ============================================================================
// TYPES
// ============================================================================

export interface GDriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface GDriveDownloadResult {
  success: boolean;
  files: ExtractedFileInfo[];
  tempDir: string;
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

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tiff', '.tif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.MP4', '.MOV', '.AVI'];
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

function isMediaFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return MEDIA_EXTENSIONS.includes(ext);
}

/**
 * Extract folder ID from Google Drive URL
 */
export function extractFolderId(url: string): string | null {
  // Handle various Google Drive URL formats:
  // https://drive.google.com/drive/folders/FOLDER_ID
  // https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
  // https://drive.google.com/drive/mobile/folders/FOLDER_ID
  
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Create temp directory for downloads
 */
export function createTempDir(boatId: string): string {
  const projectTempBase = join(process.cwd(), '.temp-downloads');
  const tempDir = join(projectTempBase, `gdrive-boat-${boatId}-${Date.now()}`);
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
// GOOGLE DRIVE API (Using public folder access)
// ============================================================================

/**
 * List files in a public Google Drive folder
 * Uses the Google Drive embed/viewer page to scrape file list
 */
async function listFolderFiles(folderId: string): Promise<GDriveFileInfo[]> {
  console.log(`   [GDrive] Listing files in folder: ${folderId}`);
  
  // Try using Google Drive's public API endpoint for folder listing
  // This works for publicly shared folders
  const apiUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  
  try {
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to list folder: ${response.status}`);
    }
    
    const html = await response.text();
    
    // Parse file entries from the HTML
    // Google Drive embed page uses this format:
    // <div class="flip-entry" id="entry-FILE_ID">
    //   ...
    //   <img src="...type/image/jpeg" />  (MIME type in icon URL)
    //   <div class="flip-entry-title">FILENAME</div>
    // </div>
    const files: GDriveFileInfo[] = [];
    
    // Helper to detect media MIME type from icon URL
    const mediaIconPatterns = [
      'type/image/jpeg', 'type/image/png', 'type/image/gif', 'type/image/webp',
      'type/image/heif', 'type/image/heic', 'type/image/bmp', 'type/image/tiff',
      'type/video/mp4', 'type/video/quicktime', 'type/video/x-msvideo',
      'type/video/webm', 'type/video/x-matroska'
    ];
    
    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/heif': '.heif', 'image/heic': '.heic',
      'image/bmp': '.bmp', 'image/tiff': '.tiff',
      'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
      'video/webm': '.webm', 'video/x-matroska': '.mkv'
    };
    
    // Pattern 1: Match entry IDs and titles from the HTML structure
    // Entry format: id="entry-FILE_ID" ... class="flip-entry-title">FILENAME</div>
    const entryPattern = /id="entry-([a-zA-Z0-9_-]+)"[^>]*>[\s\S]*?class="flip-entry-title">([^<]+)</g;
    let match;
    
    while ((match = entryPattern.exec(html)) !== null) {
      const [, id, name] = match;
      // Skip if it looks like a folder ID or system file
      if (name && !name.startsWith('.') && isMediaFile(name)) {
        files.push({
          id,
          name: name.trim(),
          mimeType: getMimeType(name),
        });
      }
    }
    
    // Pattern 2: Also check entries by MIME type when filenames lack extensions
    // This handles cases like emoji filenames (♐️) that don't have extensions
    if (files.length === 0) {
      // Match full entry blocks to extract ID, mime type from icon, and title
      const entryBlockPattern = /id="entry-([a-zA-Z0-9_-]+)"[\s\S]*?type\/([a-z]+\/[a-z-]+)[\s\S]*?class="flip-entry-title">([^<]+)</g;
      
      while ((match = entryBlockPattern.exec(html)) !== null) {
        const [, id, mimeType, name] = match;
        const fullMime = mimeType; // e.g., "image/heif"
        
        // Check if this is a media MIME type
        if (fullMime.startsWith('image/') || fullMime.startsWith('video/')) {
          const ext = mimeToExt[fullMime] || (fullMime.startsWith('image/') ? '.jpg' : '.mp4');
          const safeName = name.trim().replace(/[^\w\s-]/g, '') || `file_${id.substring(0, 8)}`;
          const finalName = safeName.includes('.') ? safeName : `${safeName}${ext}`;
          
          files.push({
            id,
            name: finalName,
            mimeType: fullMime,
          });
        }
      }
    }
    
    // Fallback Pattern 3: Look for file links directly
    // Pattern: href="https://drive.google.com/file/d/FILE_ID/view..." ... >FILENAME<
    if (files.length === 0) {
      const linkPattern = /href="https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/[^"]*"[^>]*>[\s\S]*?class="flip-entry-title">([^<]+)</g;
      while ((match = linkPattern.exec(html)) !== null) {
        const [, id, name] = match;
        if (name && !name.startsWith('.') && isMediaFile(name)) {
          files.push({
            id,
            name: name.trim(),
            mimeType: getMimeType(name),
          });
        }
      }
    }
    
    // Deduplicate by ID
    const uniqueFiles = Array.from(new Map(files.map(f => [f.id, f])).values());
    
    console.log(`   [GDrive] Found ${uniqueFiles.length} media files`);
    return uniqueFiles;
    
  } catch (error: any) {
    console.error(`   [GDrive] Error listing folder: ${error.message}`);
    return [];
  }
}

/**
 * Alternative: Use gdown or similar to download folder
 * This is more reliable for large folders
 */
async function downloadWithGdown(folderId: string, outputDir: string): Promise<boolean> {
  try {
    // Check if gdown is available
    execSync('which gdown', { stdio: 'pipe' });
    
    console.log(`   [GDrive] Using gdown to download folder...`);
    execSync(`gdown --folder "https://drive.google.com/drive/folders/${folderId}" -O "${outputDir}" --remaining-ok`, {
      timeout: 30 * 60 * 1000, // 30 minutes
      maxBuffer: 50 * 1024 * 1024,
    });
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Download a single file from Google Drive
 */
async function downloadFile(fileId: string, fileName: string, outputPath: string): Promise<boolean> {
  // Google Drive direct download URL
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.DOWNLOAD_TIMEOUT_MS);
      
      const response = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      // Check for virus scan warning page (large files)
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        // Try with confirm parameter
        const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
        const confirmResponse = await fetch(confirmUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'download_warning_token=t',
          },
          redirect: 'follow',
        });
        
        if (!confirmResponse.ok || (confirmResponse.headers.get('content-type') || '').includes('text/html')) {
          throw new Error('Cannot bypass virus scan warning');
        }
        
        // Use confirmed response
        if (confirmResponse.body) {
          const fileStream = createWriteStream(outputPath);
          const reader = confirmResponse.body.getReader();
          
          const nodeStream = new Readable({
            async read() {
              const { done, value } = await reader.read();
              if (done) this.push(null);
              else this.push(Buffer.from(value));
            }
          });
          
          await pipeline(nodeStream, fileStream);
          return true;
        }
      }
      
      // Stream to file
      if (!response.body) {
        throw new Error('No response body');
      }
      
      const fileStream = createWriteStream(outputPath);
      const reader = response.body.getReader();
      
      const nodeStream = new Readable({
        async read() {
          try {
            const { done, value } = await reader.read();
            if (done) this.push(null);
            else this.push(Buffer.from(value));
          } catch (err) {
            this.destroy(err as Error);
          }
        }
      });
      
      await pipeline(nodeStream, fileStream);
      return true;
      
    } catch (error: any) {
      console.log(`   [GDrive] Attempt ${attempt}/${CONFIG.MAX_RETRIES} failed for ${fileName}: ${error.message}`);
      
      if (attempt < CONFIG.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS * attempt));
      }
      
      // Clean up failed download
      try {
        if (existsSync(outputPath)) unlinkSync(outputPath);
      } catch {}
    }
  }
  
  return false;
}

function getMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Recursively get all media files from a directory
 */
function getMediaFiles(dir: string): ExtractedFileInfo[] {
  const files: ExtractedFileInfo[] = [];
  
  if (!existsSync(dir)) return files;
  
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue;
        files.push(...getMediaFiles(fullPath));
      } else if (entry.isFile()) {
        if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;
        
        if (isMediaFile(entry.name)) {
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
// MAIN GOOGLE DRIVE MIGRATION FUNCTION
// ============================================================================

/**
 * Download Google Drive folder and return list of media files
 */
export async function gdriveDownloadFolder(
  folderUrl: string,
  boatId: string,
  boatName: string
): Promise<GDriveDownloadResult> {
  
  const folderId = extractFolderId(folderUrl);
  if (!folderId) {
    return {
      success: false,
      files: [],
      tempDir: '',
      error: 'Could not extract folder ID from Google Drive URL',
    };
  }
  
  console.log(`   [GDrive Migration] Starting for boat ${boatId}: ${boatName}`);
  console.log(`   [GDrive] Folder ID: ${folderId}`);
  
  const tempDir = createTempDir(boatId);
  const downloadDir = join(tempDir, 'files');
  mkdirSync(downloadDir, { recursive: true });
  
  // Try gdown first (most reliable for public folders)
  const gdownSuccess = await downloadWithGdown(folderId, downloadDir);
  
  if (gdownSuccess) {
    const files = getMediaFiles(downloadDir);
    if (files.length > 0) {
      console.log(`   [GDrive] Downloaded ${files.length} media files via gdown`);
      return {
        success: true,
        files,
        tempDir,
      };
    }
  }
  
  // Fallback: List files and download individually
  console.log(`   [GDrive] Trying individual file download method...`);
  
  const fileList = await listFolderFiles(folderId);
  
  if (fileList.length === 0) {
    return {
      success: false,
      files: [],
      tempDir,
      error: 'No media files found in Google Drive folder (folder may not be public or is empty)',
    };
  }
  
  console.log(`   [GDrive] Downloading ${fileList.length} files...`);
  
  let downloadedCount = 0;
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const outputPath = join(downloadDir, file.name);
    
    process.stdout.write(`   [${i + 1}/${fileList.length}] ${file.name}...`);
    
    const success = await downloadFile(file.id, file.name, outputPath);
    
    if (success && existsSync(outputPath)) {
      const size = statSync(outputPath).size;
      console.log(` ${(size / 1024 / 1024).toFixed(1)}MB`);
      downloadedCount++;
    } else {
      console.log(' FAILED');
    }
  }
  
  const files = getMediaFiles(downloadDir);
  
  console.log(`   [GDrive] Downloaded ${files.length}/${fileList.length} files successfully`);
  
  return {
    success: files.length > 0,
    files,
    tempDir,
    error: files.length === 0 ? 'Failed to download any files' : undefined,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  extractFolderId,
  gdriveDownloadFolder,
  cleanupTempDir,
  CONFIG,
};
