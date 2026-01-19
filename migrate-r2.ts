#!/usr/bin/env bun

/**
 * AllIn1Rentals R2 Migration Script
 * 
 * Migrates media from Dropbox public shared folders to Cloudflare R2
 * - Downloads from Dropbox public share links (no API token needed)
 * - Uploads to R2 (with multipart for large files)
 * - Generates JSON with combined galleryContent array
 * - Handles subfolders recursively
 * 
 * USAGE:
 *   bun run migrate-r2.ts <CSV_URL> <CATEGORY>
 * 
 * EXAMPLE:
 *   bun run migrate-r2.ts "https://docs.google.com/.../export?format=csv" boats
 */

import { S3Client, PutObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  r2: {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME!,
    publicUrl: process.env.R2_PUBLIC_URL!.replace(/\/$/, ""),
  },
  
  // Test mode: products 6, 7, 8 (0-indexed: 5, 6, 7)
  testProductIndices: [5, 6, 7],
  
  // Output file
  outputFile: "boats-test.json",
  errorLogFile: "error_logs_r2.txt",
  
  // Media processing settings
  media: {
    // Video conversion: convert non-MP4 videos to MP4
    convertVideosToMp4: true,
    // Video compression: compress videos larger than this (in MB)
    compressVideosOverMB: 100,
    // Video target bitrate for compression (in Mbps)
    videoTargetBitrateMbps: 6,
    // Image compression: compress images larger than this (in MB)
    compressImagesOverMB: 2,
    // Image max dimension (resize if larger)
    imageMaxDimension: 2000,
    // Image quality for JPEG compression (1-100)
    imageQuality: 85,
  },
  
  // Temp directory for ffmpeg processing
  tempDir: join(tmpdir(), "allin1rentals-migration"),
};

// Validate required env vars
const requiredEnv = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID", 
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
];

const missingEnv = requiredEnv.filter((v) => !process.env[v]);
if (missingEnv.length > 0) {
  console.error("Missing required environment variables:", missingEnv.join(", "));
  process.exit(1);
}

// ============================================================================
// INITIALIZE R2 CLIENT
// ============================================================================

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${CONFIG.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: CONFIG.r2.accessKeyId,
    secretAccessKey: CONFIG.r2.secretAccessKey,
  },
});

// ============================================================================
// FILE TYPE HELPERS
// ============================================================================

const IMAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", 
  ".svg", ".heic", ".heif", ".tiff", ".tif", ".ico"
];

const VIDEO_EXTENSIONS = [
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", 
  ".wmv", ".m4v", ".mpeg", ".mpg", ".3gp", ".ogv"
];

function getFileType(filename: string): "image" | "video" | "unknown" {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "unknown";
}

function getMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".heic": "image/heic",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[<>:"/\\|?*\(\)']/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ============================================================================
// FFMPEG VIDEO PROCESSING
// ============================================================================

/**
 * Check if ffmpeg is available
 */
function checkFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a video needs conversion (non-MP4 formats)
 */
function needsVideoConversion(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const nonMp4Formats = [".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg", ".3gp", ".ogv", ".webm"];
  return nonMp4Formats.includes(ext);
}

/**
 * Convert video to MP4 using ffmpeg
 * Returns the converted buffer and new filename
 */
async function convertVideoToMp4(
  inputBuffer: Buffer,
  originalFilename: string,
  compress: boolean = false
): Promise<{ buffer: Buffer; filename: string }> {
  // Ensure temp directory exists
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }
  
  const timestamp = Date.now();
  const inputPath = join(CONFIG.tempDir, `input_${timestamp}_${originalFilename}`);
  const baseName = originalFilename.substring(0, originalFilename.lastIndexOf("."));
  const outputFilename = `${baseName}.mp4`;
  const outputPath = join(CONFIG.tempDir, `output_${timestamp}_${outputFilename}`);
  
  try {
    // Write input buffer to temp file
    writeFileSync(inputPath, inputBuffer);
    
    // Build ffmpeg command
    const ffmpegArgs = [
      "-i", inputPath,
      "-c:v", "libx264",      // H.264 video codec
      "-preset", "medium",     // Balance between speed and compression
      "-crf", compress ? "26" : "23",  // Quality: 23 is default, 26 for compression
      "-c:a", "aac",          // AAC audio codec
      "-b:a", "128k",         // Audio bitrate
      "-movflags", "+faststart", // Enable streaming
      "-y",                   // Overwrite output
    ];
    
    // Add bitrate limit for compression
    if (compress) {
      ffmpegArgs.push("-maxrate", `${CONFIG.media.videoTargetBitrateMbps}M`);
      ffmpegArgs.push("-bufsize", `${CONFIG.media.videoTargetBitrateMbps * 2}M`);
    }
    
    ffmpegArgs.push(outputPath);
    
    // Run ffmpeg
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ffmpegArgs);
      let stderr = "";
      
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });
      
      ffmpeg.on("error", (err) => {
        reject(new Error(`ffmpeg spawn error: ${err.message}`));
      });
    });
    
    // Read output file
    const outputBuffer = readFileSync(outputPath);
    
    return { buffer: outputBuffer, filename: outputFilename };
  } finally {
    // Cleanup temp files
    try {
      if (existsSync(inputPath)) unlinkSync(inputPath);
      if (existsSync(outputPath)) unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Compress video using ffmpeg (for already-MP4 files that are too large)
 */
async function compressVideo(
  inputBuffer: Buffer,
  filename: string
): Promise<Buffer> {
  const result = await convertVideoToMp4(inputBuffer, filename, true);
  return result.buffer;
}

/**
 * Process video: convert to MP4 if needed, compress if too large
 */
async function processVideo(
  buffer: Buffer,
  filename: string
): Promise<{ buffer: Buffer; filename: string }> {
  const fileSizeMB = buffer.length / (1024 * 1024);
  const needsConversion = needsVideoConversion(filename);
  const needsCompression = fileSizeMB > CONFIG.media.compressVideosOverMB;
  
  if (needsConversion) {
    console.log(`      Converting ${filename} to MP4...`);
    const result = await convertVideoToMp4(buffer, filename, needsCompression);
    const newSizeMB = result.buffer.length / (1024 * 1024);
    console.log(`      Converted: ${fileSizeMB.toFixed(1)}MB -> ${newSizeMB.toFixed(1)}MB`);
    return result;
  } else if (needsCompression) {
    console.log(`      Compressing large video (${fileSizeMB.toFixed(1)}MB)...`);
    const compressedBuffer = await compressVideo(buffer, filename);
    const newSizeMB = compressedBuffer.length / (1024 * 1024);
    console.log(`      Compressed: ${fileSizeMB.toFixed(1)}MB -> ${newSizeMB.toFixed(1)}MB`);
    return { buffer: compressedBuffer, filename };
  }
  
  return { buffer, filename };
}

// ============================================================================
// IMAGE PROCESSING (using sharp if available, fallback to ImageMagick)
// ============================================================================

/**
 * Check if ImageMagick is available
 */
function checkImageMagick(): boolean {
  try {
    execSync("convert -version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compress image using ImageMagick
 */
async function compressImage(
  inputBuffer: Buffer,
  filename: string
): Promise<Buffer> {
  const fileSizeMB = inputBuffer.length / (1024 * 1024);
  
  // Skip if under threshold
  if (fileSizeMB <= CONFIG.media.compressImagesOverMB) {
    return inputBuffer;
  }
  
  // Check if ImageMagick is available
  if (!checkImageMagick()) {
    console.log(`      ImageMagick not available, skipping compression`);
    return inputBuffer;
  }
  
  // Ensure temp directory exists
  if (!existsSync(CONFIG.tempDir)) {
    mkdirSync(CONFIG.tempDir, { recursive: true });
  }
  
  const timestamp = Date.now();
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const inputPath = join(CONFIG.tempDir, `img_input_${timestamp}${ext}`);
  const outputPath = join(CONFIG.tempDir, `img_output_${timestamp}.jpg`);
  
  try {
    writeFileSync(inputPath, inputBuffer);
    
    // Use ImageMagick to resize and compress
    // -resize limits max dimension while preserving aspect ratio
    // -quality sets JPEG quality
    execSync(
      `convert "${inputPath}" -resize ${CONFIG.media.imageMaxDimension}x${CONFIG.media.imageMaxDimension}\\> -quality ${CONFIG.media.imageQuality} "${outputPath}"`,
      { stdio: "pipe" }
    );
    
    const outputBuffer = readFileSync(outputPath);
    const newSizeMB = outputBuffer.length / (1024 * 1024);
    
    console.log(`      Image compressed: ${fileSizeMB.toFixed(1)}MB -> ${newSizeMB.toFixed(1)}MB`);
    
    return outputBuffer;
  } catch (err: any) {
    console.log(`      Image compression failed: ${err.message}`);
    return inputBuffer;
  } finally {
    try {
      if (existsSync(inputPath)) unlinkSync(inputPath);
      if (existsSync(outputPath)) unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// ERROR LOGGING
// ============================================================================

function logError(context: string, error: any, additionalInfo: Record<string, any> = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `
================================================================================
[${timestamp}] ERROR in ${context}
--------------------------------------------------------------------------------
Message: ${error?.message || String(error)}
Additional Info: ${JSON.stringify(additionalInfo, null, 2)}
================================================================================
`;
  appendFileSync(CONFIG.errorLogFile, logEntry);
  console.error(`   ERROR [${context}]: ${error?.message || error}`);
}

// Initialize error log
if (!existsSync(CONFIG.errorLogFile)) {
  writeFileSync(CONFIG.errorLogFile, `Error Log - Created: ${new Date().toISOString()}\n`);
} else {
  appendFileSync(CONFIG.errorLogFile, `\n\nNew Session: ${new Date().toISOString()}\n`);
}

// ============================================================================
// R2 UPLOAD FUNCTIONS
// ============================================================================

/**
 * Upload a file to R2
 * Uses multipart upload for files >= 50MB
 */
async function uploadToR2(
  buffer: Buffer,
  key: string,
  mimeType: string
): Promise<string> {
  const fileSizeMB = buffer.length / (1024 * 1024);

  if (fileSizeMB >= 50) {
    // Large file: use multipart upload
    console.log(`      Using multipart upload (${fileSizeMB.toFixed(2)} MB)...`);
    
    const upload = new Upload({
      client: r2Client,
      params: {
        Bucket: CONFIG.r2.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      },
      partSize: 50 * 1024 * 1024, // 50MB parts
      leavePartsOnError: false,
    });

    // Progress tracking
    upload.on("httpUploadProgress", (progress) => {
      if (progress.total) {
        const percent = Math.round(((progress.loaded || 0) / progress.total) * 100);
        process.stdout.write(`\r      Upload progress: ${percent}%   `);
      }
    });

    await upload.done();
    console.log(); // New line after progress
  } else {
    // Small file: direct upload
    const command = new PutObjectCommand({
      Bucket: CONFIG.r2.bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });
    await r2Client.send(command);
  }

  return `${CONFIG.r2.publicUrl}/${key}`;
}

// ============================================================================
// DROPBOX DIRECT DOWNLOAD (No API Token needed for public links)
// ============================================================================

interface DropboxFile {
  name: string;
  path: string;
  downloadUrl: string;
  isFolder: boolean;
}

/**
 * Convert Dropbox share URL to direct download URL
 * Works for public shared links
 */
function getDropboxDirectUrl(shareUrl: string): string {
  // Convert dropbox.com to dl.dropboxusercontent.com for direct download
  // Also change dl=0 to dl=1 if present
  let url = shareUrl.replace("www.dropbox.com", "dl.dropboxusercontent.com");
  url = url.replace("dl=0", "dl=1");
  if (!url.includes("dl=1") && !url.includes("raw=1")) {
    url += url.includes("?") ? "&raw=1" : "?raw=1";
  }
  return url;
}

/**
 * Fetch folder listing from Dropbox shared folder
 * Uses web scraping approach for public folders since we don't have API access
 */
async function listDropboxFolder(shareUrl: string): Promise<{ folderName: string; files: DropboxFile[] }> {
  // For folders, we need to get the HTML and parse it, or use the API preview
  // Let's try to fetch the page and look for file links
  
  const response = await fetch(shareUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch Dropbox folder: ${response.status}`);
  }
  
  const html = await response.text();
  
  // Extract folder name from the page title or meta
  let folderName = "Unknown";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    folderName = titleMatch[1].replace(" - Dropbox", "").trim();
  }
  
  // Look for the JSON data embedded in the page (Dropbox embeds file list as JSON)
  const files: DropboxFile[] = [];
  
  // Pattern 1: Look for files in shared_link_infos or similar JSON
  const jsonMatches = html.matchAll(/"filename"\s*:\s*"([^"]+)"/g);
  const seenFiles = new Set<string>();
  
  for (const match of jsonMatches) {
    const filename = match[1];
    if (!seenFiles.has(filename) && getFileType(filename) !== "unknown") {
      seenFiles.add(filename);
      files.push({
        name: filename,
        path: "/" + filename,
        downloadUrl: "", // Will be constructed per-file
        isFolder: false,
      });
    }
  }
  
  // Pattern 2: Look for preview URLs that indicate files
  const previewMatches = html.matchAll(/\/scl\/fi\/[a-z0-9]+\/([^"?\s]+)/gi);
  for (const match of previewMatches) {
    let filename = decodeURIComponent(match[1]);
    // Clean up URL encoding artifacts
    filename = filename.split("?")[0];
    if (!seenFiles.has(filename) && getFileType(filename) !== "unknown") {
      seenFiles.add(filename);
      files.push({
        name: filename,
        path: "/" + filename,
        downloadUrl: "",
        isFolder: false,
      });
    }
  }
  
  // Pattern 3: Look for sl_preview_infos which contains actual file data
  const previewInfoMatch = html.match(/sl_preview_infos\s*=\s*(\[[\s\S]*?\]);/);
  if (previewInfoMatch) {
    try {
      const previewData = JSON.parse(previewInfoMatch[1]);
      for (const item of previewData) {
        if (item.filename && !seenFiles.has(item.filename)) {
          const filename = item.filename;
          if (getFileType(filename) !== "unknown") {
            seenFiles.add(filename);
            files.push({
              name: filename,
              path: "/" + filename,
              downloadUrl: item.preview_url || "",
              isFolder: false,
            });
          }
        }
      }
    } catch (e) {
      // JSON parse failed, continue
    }
  }
  
  console.log(`   Found ${files.length} media files via HTML parsing`);
  
  return { folderName, files };
}

/**
 * Download a file from Dropbox using the direct download approach
 */
async function downloadFromDropbox(shareUrl: string, filename: string): Promise<Buffer> {
  // For folder share links, we need to construct the file URL
  // The pattern is: add the filename path to the share URL
  
  // Method 1: Try direct download URL transformation
  let downloadUrl = shareUrl;
  
  // If it's a folder link (contains /fo/), we need to construct file URL
  if (shareUrl.includes("/fo/")) {
    // Try to construct a download URL for the specific file
    // Dropbox folder links: https://www.dropbox.com/scl/fo/{folder_id}/{folder_name}?rlkey=...
    // We need: https://dl.dropboxusercontent.com/scl/fo/{folder_id}/{folder_name}/{filename}?rlkey=...&dl=1
    
    const urlObj = new URL(shareUrl);
    const basePath = urlObj.pathname;
    const params = urlObj.search;
    
    downloadUrl = `https://dl.dropboxusercontent.com${basePath}/${encodeURIComponent(filename)}${params}`;
    downloadUrl = downloadUrl.replace("dl=0", "dl=1");
    if (!downloadUrl.includes("dl=1")) {
      downloadUrl += "&dl=1";
    }
  } else {
    downloadUrl = getDropboxDirectUrl(shareUrl);
  }
  
  console.log(`      Download URL: ${downloadUrl.substring(0, 80)}...`);
  
  const response = await fetch(downloadUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
  });
  
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Alternative: Download all files from folder using zip download
 * Dropbox allows downloading entire folders as zip
 */
async function downloadFolderAsZip(shareUrl: string): Promise<Buffer> {
  // Add dl=1 to force download
  let zipUrl = shareUrl;
  if (zipUrl.includes("dl=0")) {
    zipUrl = zipUrl.replace("dl=0", "dl=1");
  } else if (!zipUrl.includes("dl=1")) {
    zipUrl += (zipUrl.includes("?") ? "&" : "?") + "dl=1";
  }
  
  console.log(`   Downloading folder as ZIP...`);
  
  const response = await fetch(zipUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
  });
  
  if (!response.ok) {
    throw new Error(`ZIP download failed: ${response.status}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// ZIP EXTRACTION (for folder downloads)
// ============================================================================

import AdmZip from "adm-zip";

interface ExtractedFile {
  name: string;
  path: string;
  data: Buffer;
}

function extractZip(zipBuffer: Buffer): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  
  try {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    
    for (const entry of entries) {
      // Skip directories
      if (entry.isDirectory) continue;
      
      const filename = entry.entryName.split("/").pop() || entry.entryName;
      
      // Skip non-media files
      if (getFileType(filename) === "unknown") continue;
      
      // Skip macOS metadata files
      if (filename.startsWith("._") || entry.entryName.includes("__MACOSX")) continue;
      
      const data = entry.getData();
      
      files.push({
        name: filename,
        path: entry.entryName,
        data: data,
      });
    }
  } catch (error: any) {
    throw new Error(`Failed to extract ZIP: ${error.message}`);
  }
  
  return files;
}

// ============================================================================
// MAIN MIGRATION FUNCTION
// ============================================================================

interface MigrationResult {
  galleryContent: string[];
  titleImage: string;
  titleVideo: string;
}

async function migrateDropboxFolder(
  dropboxUrl: string,
  category: string,
  productName: string
): Promise<MigrationResult | null> {
  const galleryContent: string[] = [];
  let titleImage = "";
  let titleVideo = "";

  if (!dropboxUrl) {
    console.log("   No Dropbox link provided, skipping...");
    return null;
  }

  console.log(`   Downloading folder as ZIP from Dropbox...`);
  
  let zipBuffer: Buffer;
  try {
    zipBuffer = await downloadFolderAsZip(dropboxUrl);
    console.log(`   Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (error: any) {
    logError("Download Folder", error, { dropboxUrl, productName });
    return null;
  }

  // Extract ZIP
  console.log(`   Extracting ZIP...`);
  let files: ExtractedFile[];
  try {
    files = extractZip(zipBuffer);
    console.log(`   Found ${files.length} media files`);
  } catch (error: any) {
    logError("Extract ZIP", error, { dropboxUrl, productName });
    return null;
  }

  if (files.length === 0) {
    console.log("   No media files found in folder");
    return { galleryContent: [], titleImage: "", titleVideo: "" };
  }

  // Get folder name from first file path or use sanitized product name
  let folderName = productName;
  if (files[0].path.includes("/")) {
    const firstPathPart = files[0].path.split("/")[0];
    if (firstPathPart) {
      folderName = firstPathPart;
    }
  }
  folderName = sanitizeName(folderName);

  // R2 path prefix
  const r2Prefix = `${category}/${folderName}`;
  console.log(`   R2 path: ${r2Prefix}/`);

  // Sort files: images first, then videos, alphabetically within each group
  files.sort((a, b) => {
    const typeA = getFileType(a.name);
    const typeB = getFileType(b.name);
    if (typeA !== typeB) {
      return typeA === "image" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  // Process each file
  let uploadedCount = 0;
  let failedCount = 0;

  for (const file of files) {
    let processedBuffer = file.data;
    let processedFilename = file.name;
    const fileType = getFileType(file.name);
    const originalSizeMB = (file.data.length / 1024 / 1024).toFixed(2);

    console.log(`   [${uploadedCount + 1}/${files.length}] ${file.name} (${originalSizeMB} MB)`);

    try {
      // Process video: convert to MP4 if needed, compress if large
      if (fileType === "video" && CONFIG.media.convertVideosToMp4) {
        try {
          const processed = await processVideo(file.data, file.name);
          processedBuffer = processed.buffer;
          processedFilename = processed.filename;
        } catch (videoErr: any) {
          console.log(`      Video processing failed, uploading original: ${videoErr.message}`);
        }
      }
      
      // Compress large images
      if (fileType === "image") {
        try {
          processedBuffer = await compressImage(file.data, file.name);
        } catch (imgErr: any) {
          console.log(`      Image compression failed, uploading original: ${imgErr.message}`);
        }
      }
      
      // Build R2 key with potentially updated filename
      const safeName = sanitizeName(processedFilename);
      const pathParts = file.path.split("/");
      // Remove the root folder name (it's usually duplicated)
      let relativePath: string;
      if (pathParts.length > 1) {
        // Replace the original filename with processed filename in the path
        const pathWithoutFilename = pathParts.slice(1, -1).map(p => sanitizeName(p));
        relativePath = [...pathWithoutFilename, safeName].join("/");
      } else {
        relativePath = safeName;
      }
      const r2Key = `${r2Prefix}/${relativePath}`;

      // Upload to R2
      const finalSizeMB = (processedBuffer.length / 1024 / 1024).toFixed(2);
      process.stdout.write(`      Uploading to R2 (${finalSizeMB} MB)...`);
      const mimeType = getMimeType(processedFilename);
      const cdnUrl = await uploadToR2(processedBuffer, r2Key, mimeType);
      console.log(` done`);
      console.log(`      URL: ${cdnUrl}`);

      // Add to galleryContent
      galleryContent.push(cdnUrl);

      // Set title image/video (first of each type)
      if (fileType === "image" && !titleImage) {
        titleImage = cdnUrl;
      } else if (fileType === "video" && !titleVideo) {
        titleVideo = cdnUrl;
      }

      uploadedCount++;
    } catch (error: any) {
      failedCount++;
      logError("File Upload", error, {
        fileName: file.name,
        size: originalSizeMB + " MB",
        folder: folderName,
      });
      console.log(`      FAILED: ${error.message}`);
    }
  }

  console.log(`   Summary: ${uploadedCount} uploaded, ${failedCount} failed`);

  return { galleryContent, titleImage, titleVideo };
}

// ============================================================================
// CSV PARSING
// ============================================================================

interface Product {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  location: string;
  basePrice: string;
  rating: string;
  reviewCount: string;
  reviews: string;
  instantBooking: string;
  size: string;
  unit: string;
  tripDuration: string;
  departure: string;
  inclusions: string;
  maxGuests: string;
  year: string;
  cabins: string;
  bathrooms: string;
  titleVideoExternal: string;
  titleImageExternal: string;
  dropboxLink: string;
  [key: string]: string;
}

// Column mapping for boats CSV
const COLUMN_MAP: Record<string, string> = {
  "Sr. No": "id",
  "Product Name": "name",
  "Slugs": "slug",
  "Tagline": "tagline",
  "Description": "description",
  "Location": "location",
  "Starting price ($)": "basePrice",
  "Rating": "rating",
  "ReviewCount": "reviewCount",
  "Reviews": "reviews",
  "Instant Booking": "instantBooking",
  "Size": "size",
  "Unit": "unit",
  "Trip Duration Hours": "tripDuration",
  "Departure": "departure",
  "Inclusions": "inclusions",
  "Guests Max": "maxGuests",
  "Year": "year",
  "Cabins": "cabins",
  "Bathrooms": "bathrooms",
  "Title Video Link": "titleVideoExternal",
  "Title Image Link": "titleImageExternal",
  "Dropbox Link": "dropboxLink",
};

async function fetchAndParseCSV(url: string): Promise<Product[]> {
  console.log("Fetching CSV data...");
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CSV: ${response.status}`);
  }
  
  const text = await response.text();
  
  // Parse the entire CSV properly handling multiline quoted fields
  const rows = parseCSVWithMultilineSupport(text);
  
  if (rows.length < 2) {
    throw new Error("CSV file is empty or has no data rows");
  }

  const headers = rows[0];
  console.log(`CSV headers found: ${headers.length}`);
  console.log(`Headers: ${headers.join(", ")}`);

  // Parse data rows
  const products: Product[] = [];
  
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const rawRow: Record<string, string> = {};
    
    headers.forEach((header, idx) => {
      rawRow[header.trim()] = (values[idx] || "").trim();
    });

    // Skip rows without Sr. No (indicates bad data)
    if (!rawRow["Sr. No"]) continue;

    // Map columns to our schema
    const product: Record<string, string> = {};
    for (const [csvKey, ourKey] of Object.entries(COLUMN_MAP)) {
      product[ourKey] = rawRow[csvKey] || "";
    }

    products.push(product as Product);
  }

  console.log(`Parsed ${products.length} products from CSV\n`);
  return products;
}

/**
 * Parse CSV with proper support for multiline quoted fields
 */
function parseCSVWithMultilineSupport(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote ("") -> single quote
        currentField += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      currentRow.push(currentField);
      currentField = "";
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      // End of row (handle both \n and \r\n)
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0] !== "") {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = "";
      if (char === '\r') i++; // Skip \n in \r\n
    } else if (char === '\r' && !inQuotes) {
      // Handle standalone \r (old Mac format)
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0] !== "") {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = "";
    } else {
      currentField += char;
    }
  }
  
  // Don't forget the last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 1 || currentRow[0] !== "") {
      rows.push(currentRow);
    }
  }
  
  return rows;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const csvUrl = process.argv[2];
  const category = process.argv[3] || "boats";

  if (!csvUrl) {
    console.error("Usage: bun run migrate-r2.ts <CSV_URL> [CATEGORY]");
    console.error('Example: bun run migrate-r2.ts "https://docs.google.com/.../export?format=csv" boats');
    process.exit(1);
  }

  // Check for ffmpeg and ImageMagick
  const hasFfmpeg = checkFfmpeg();
  const hasImageMagick = checkImageMagick();

  const productNumbers = CONFIG.testProductIndices.map(i => i + 1).join(", ");

  console.log("\n" + "=".repeat(70));
  console.log("ALLIN1RENTALS R2 MIGRATION");
  console.log("=".repeat(70));
  console.log(`CSV URL: ${csvUrl.substring(0, 60)}...`);
  console.log(`Category: ${category}`);
  console.log(`R2 Bucket: ${CONFIG.r2.bucketName}`);
  console.log(`CDN URL: ${CONFIG.r2.publicUrl}`);
  console.log(`Test Mode: Products ${productNumbers}`);
  console.log(`Output: ${CONFIG.outputFile}`);
  console.log(`ffmpeg available: ${hasFfmpeg ? "Yes" : "No"}`);
  console.log(`ImageMagick available: ${hasImageMagick ? "Yes" : "No"}`);
  console.log("=".repeat(70) + "\n");

  if (!hasFfmpeg) {
    console.log("WARNING: ffmpeg not found. Video conversion will be skipped.");
  }
  if (!hasImageMagick) {
    console.log("WARNING: ImageMagick not found. Image compression will be skipped.");
  }

  // Verify R2 connection
  console.log("Verifying R2 connection...");
  try {
    await r2Client.send(new HeadBucketCommand({ Bucket: CONFIG.r2.bucketName }));
    console.log("R2 bucket accessible!\n");
  } catch (error: any) {
    console.error(`Failed to access R2 bucket: ${error.message}`);
    console.error("Please check your R2 credentials and bucket name.");
    process.exit(1);
  }

  // Load existing data if appending
  let existingData: any[] = [];
  if (existsSync(CONFIG.outputFile)) {
    try {
      const existingContent = readFileSync(CONFIG.outputFile, "utf-8");
      existingData = JSON.parse(existingContent);
      console.log(`Loaded ${existingData.length} existing products from ${CONFIG.outputFile}`);
    } catch (e) {
      console.log(`Could not read existing file, starting fresh`);
    }
  }

  // Fetch and parse CSV
  const allProducts = await fetchAndParseCSV(csvUrl);

  // Filter to test products only
  const testProducts = CONFIG.testProductIndices
    .map((idx) => allProducts[idx])
    .filter(Boolean);

  console.log(`Processing ${testProducts.length} test products...\n`);

  const results: any[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < testProducts.length; i++) {
    const product = testProducts[i];
    const productNum = CONFIG.testProductIndices[i] + 1; // 1-indexed for display

    console.log("=".repeat(70));
    console.log(`PRODUCT ${productNum}: ${product.name || "Unnamed"}`);
    console.log("=".repeat(70));
    console.log(`   Slug: ${product.slug || "N/A"}`);
    console.log(`   Dropbox Link: ${product.dropboxLink || "NONE"}`);
    console.log(`   Title Image External: ${product.titleImageExternal || "N/A"}`);
    console.log(`   Title Video External: ${product.titleVideoExternal || "N/A"}`);

    if (!product.dropboxLink) {
      console.log("   Skipping - no Dropbox link\n");
      failCount++;
      continue;
    }

    try {
      const migrationResult = await migrateDropboxFolder(
        product.dropboxLink,
        category,
        product.name
      );

      if (migrationResult) {
        // Build final product object
        const finalProduct: any = {
          id: product.id,
          name: product.name,
          slug: product.slug || sanitizeName(product.name).toLowerCase(),
          tagline: product.tagline,
          description: product.description,
          location: product.location,
          basePrice: product.basePrice,
          rating: product.rating,
          reviewCount: product.reviewCount,
          size: product.size,
          unit: product.unit,
          tripDuration: product.tripDuration,
          departure: product.departure,
          inclusions: product.inclusions
            ? product.inclusions.split(",").map((s) => s.trim())
            : [],
          maxGuests: product.maxGuests,
          year: product.year,
          cabins: product.cabins,
          bathrooms: product.bathrooms,
          // Use external title image/video if provided, otherwise use first from gallery
          titleImage: product.titleImageExternal || migrationResult.titleImage,
          titleVideo: product.titleVideoExternal || migrationResult.titleVideo,
          galleryContent: migrationResult.galleryContent,
          instantBooking: true,
          category: category,
        };

        results.push(finalProduct);
        successCount++;
        console.log(`   SUCCESS\n`);
      } else {
        failCount++;
        console.log(`   FAILED\n`);
      }
    } catch (error: any) {
      failCount++;
      logError("Product Migration", error, {
        productId: product.id,
        productName: product.name,
      });
      console.log(`   ERROR: ${error.message}\n`);
    }
  }

  // Merge with existing data (append new products)
  const finalData = [...existingData, ...results];
  
  // Save results
  writeFileSync(CONFIG.outputFile, JSON.stringify(finalData, null, 2));

  // Final summary
  console.log("\n" + "=".repeat(70));
  console.log("MIGRATION COMPLETE");
  console.log("=".repeat(70));
  console.log(`Total Products Processed: ${testProducts.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Previously existing: ${existingData.length}`);
  console.log(`Total in output file: ${finalData.length}`);
  console.log(`Output File: ${CONFIG.outputFile}`);
  console.log(`Error Log: ${CONFIG.errorLogFile}`);
  console.log("=".repeat(70) + "\n");

  // Quick stats on output
  if (finalData.length > 0) {
    const totalImages = finalData.reduce(
      (sum, p) => sum + p.galleryContent.filter((u: string) => getFileType(u) === "image").length,
      0
    );
    const totalVideos = finalData.reduce(
      (sum, p) => sum + p.galleryContent.filter((u: string) => getFileType(u) === "video").length,
      0
    );
    console.log("OUTPUT STATS:");
    console.log(`   Products with content: ${finalData.length}`);
    console.log(`   Total images: ${totalImages}`);
    console.log(`   Total videos: ${totalVideos}`);
    console.log(`   Average gallery size: ${((totalImages + totalVideos) / finalData.length).toFixed(1)} files`);
  }
  
  // Cleanup temp directory
  try {
    if (existsSync(CONFIG.tempDir)) {
      rmSync(CONFIG.tempDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
