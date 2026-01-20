#!/usr/bin/env bun

import { config } from "dotenv";
config();

/**
 * AllIn1Rentals R2 Migration Script - BOATS (Batch Processing)
 * 
 * - Processes boats in batches of 10
 * - Saves after EACH product (never lose progress)
 * - basePrice is extracted as NUMBER
 * - Videos first in galleryContent
 * - NOW WITH STREAMING SUPPORT for large files (>500MB)
 * 
 * Updated: January 21, 2026
 */

import { S3Client, PutObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, rmSync, statSync, readdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join, basename } from "path";
import AdmZip from "adm-zip";

// Import streaming download module
import { 
  shouldUseStreaming, 
  hasBrokenLink, 
  streamingDropboxMigration, 
  cleanupTempDir,
  prepareDownloadUrl 
} from "./lib/streaming-download";

// Import Google Drive download module
import {
  gdriveDownloadFolder,
  cleanupTempDir as cleanupGDriveTempDir,
} from "./lib/gdrive-download";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  r2: {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME || "allin1rentals-media",
    publicUrl: (process.env.R2_PUBLIC_URL || "").replace(/\/$/, ""),
  },
  
  csvUrl: "https://docs.google.com/spreadsheets/d/1sVPsjAyRPgIw7syL0kjcRr9MfusSgHKFayFqjwO-f5M/export?format=csv&gid=0",
  category: "boats",
  outputFile: "boats-new.json",
  errorLogFile: "error_logs_boats.txt",
  
  media: {
    convertVideosToMp4: true,
    compressVideosOverMB: 100,
    videoTargetBitrateMbps: 6,
    compressImagesOverMB: 2,
    imageMaxDimension: 2000,
    imageQuality: 85,
  },
  
  tempDir: join(tmpdir(), "allin1rentals-boats"),
};

// Validate env vars
const requiredEnv = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"];
const missingEnv = requiredEnv.filter((v) => !process.env[v]);
if (missingEnv.length > 0) {
  console.error("Missing env vars:", missingEnv.join(", "));
  process.exit(1);
}

// ============================================================================
// R2 CLIENT
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
// HELPERS
// ============================================================================

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".heic", ".heif", ".tiff", ".tif", ".ico"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".mpeg", ".mpg", ".3gp", ".ogv"];

function getFileType(filename: string): "image" | "video" | "unknown" {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "unknown";
}

function getMimeType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska", ".webm": "video/webm",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, "_").replace(/[<>:"/\\|?*\(\)']/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

function logError(context: string, error: any, info: Record<string, any> = {}) {
  const entry = `\n[${new Date().toISOString()}] ${context}: ${error?.message || error}\n${JSON.stringify(info, null, 2)}\n`;
  appendFileSync(CONFIG.errorLogFile, entry);
  console.error(`   ERROR [${context}]: ${error?.message || error}`);
}

// Extract numeric price from string like "$150" or "150/hr" or "$1,500"
function extractPrice(priceStr: string): number {
  if (!priceStr) return 0;
  // Remove everything except digits and decimal point
  const cleaned = priceStr.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ============================================================================
// FFMPEG PROCESSING
// ============================================================================

function checkFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "pipe" }); return true; } catch { return false; }
}

function checkImageMagick(): boolean {
  try { execSync("convert -version", { stdio: "pipe" }); return true; } catch { return false; }
}

function needsVideoConversion(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  return [".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg", ".3gp", ".ogv", ".webm"].includes(ext);
}

async function convertVideoToMp4(inputBuffer: Buffer, originalFilename: string, compress: boolean = false): Promise<{ buffer: Buffer; filename: string }> {
  if (!existsSync(CONFIG.tempDir)) mkdirSync(CONFIG.tempDir, { recursive: true });
  
  const timestamp = Date.now() + Math.random().toString(36).slice(2);
  const inputPath = join(CONFIG.tempDir, `in_${timestamp}_${sanitizeName(originalFilename)}`);
  const baseName = originalFilename.substring(0, originalFilename.lastIndexOf("."));
  const outputFilename = `${baseName}.mp4`;
  const outputPath = join(CONFIG.tempDir, `out_${timestamp}_${sanitizeName(outputFilename)}`);
  
  try {
    writeFileSync(inputPath, inputBuffer);
    
    const ffmpegArgs = [
      "-i", inputPath, "-c:v", "libx264", "-preset", "fast",
      "-crf", compress ? "28" : "23", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-y",
    ];
    
    if (compress) {
      ffmpegArgs.push("-maxrate", `${CONFIG.media.videoTargetBitrateMbps}M`);
      ffmpegArgs.push("-bufsize", `${CONFIG.media.videoTargetBitrateMbps * 2}M`);
    }
    ffmpegArgs.push(outputPath);
    
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ffmpegArgs);
      ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      ffmpeg.on("error", reject);
    });
    
    return { buffer: readFileSync(outputPath), filename: outputFilename };
  } finally {
    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
  }
}

async function processVideo(buffer: Buffer, filename: string): Promise<{ buffer: Buffer; filename: string }> {
  const sizeMB = buffer.length / (1024 * 1024);
  const needsConversion = needsVideoConversion(filename);
  const needsCompression = sizeMB > CONFIG.media.compressVideosOverMB;
  
  if (needsConversion || needsCompression) {
    console.log(`      ${needsConversion ? "Converting" : "Compressing"} video...`);
    const result = await convertVideoToMp4(buffer, filename, needsCompression);
    console.log(`      ${sizeMB.toFixed(1)}MB -> ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB`);
    return result;
  }
  return { buffer, filename };
}

async function compressImage(inputBuffer: Buffer, filename: string): Promise<Buffer> {
  const sizeMB = inputBuffer.length / (1024 * 1024);
  if (sizeMB <= CONFIG.media.compressImagesOverMB || !checkImageMagick()) return inputBuffer;
  
  if (!existsSync(CONFIG.tempDir)) mkdirSync(CONFIG.tempDir, { recursive: true });
  
  const timestamp = Date.now() + Math.random().toString(36).slice(2);
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const inputPath = join(CONFIG.tempDir, `img_in_${timestamp}${ext}`);
  const outputPath = join(CONFIG.tempDir, `img_out_${timestamp}.jpg`);
  
  try {
    writeFileSync(inputPath, inputBuffer);
    execSync(`convert "${inputPath}" -resize ${CONFIG.media.imageMaxDimension}x${CONFIG.media.imageMaxDimension}\\> -quality ${CONFIG.media.imageQuality} "${outputPath}"`, { stdio: "pipe" });
    const result = readFileSync(outputPath);
    console.log(`      Image: ${sizeMB.toFixed(1)}MB -> ${(result.length / 1024 / 1024).toFixed(1)}MB`);
    return result;
  } catch { return inputBuffer; }
  finally {
    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
  }
}

// ============================================================================
// R2 UPLOAD
// ============================================================================

async function uploadToR2(buffer: Buffer, key: string, mimeType: string): Promise<string> {
  const sizeMB = buffer.length / (1024 * 1024);
  
  if (sizeMB >= 50) {
    const upload = new Upload({
      client: r2Client,
      params: { Bucket: CONFIG.r2.bucketName, Key: key, Body: buffer, ContentType: mimeType },
      partSize: 50 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  } else {
    await r2Client.send(new PutObjectCommand({
      Bucket: CONFIG.r2.bucketName, Key: key, Body: buffer, ContentType: mimeType,
    }));
  }
  
  return `${CONFIG.r2.publicUrl}/${key}`;
}

// ============================================================================
// DROPBOX DOWNLOAD
// ============================================================================

async function downloadFolderAsZip(shareUrl: string): Promise<Buffer> {
  let zipUrl = shareUrl;
  if (zipUrl.includes("dl=0")) zipUrl = zipUrl.replace("dl=0", "dl=1");
  else if (!zipUrl.includes("dl=1")) zipUrl += (zipUrl.includes("?") ? "&" : "?") + "dl=1";
  
  const response = await fetch(zipUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    redirect: "follow",
  });
  
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

interface ExtractedFile { name: string; path: string; data: Buffer; }

function extractZip(zipBuffer: Buffer): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const zip = new AdmZip(zipBuffer);
  
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const filename = entry.entryName.split("/").pop() || entry.entryName;
    if (getFileType(filename) === "unknown") continue;
    if (filename.startsWith("._") || entry.entryName.includes("__MACOSX")) continue;
    files.push({ name: filename, path: entry.entryName, data: entry.getData() });
  }
  
  return files;
}

// ============================================================================
// MIGRATION
// ============================================================================

interface MigrationResult {
  galleryContent: string[];
  titleImage: string;
  titleVideo: string;
}

/**
 * Check if URL is a Google Drive link
 */
function isGoogleDriveLink(url: string): boolean {
  return url.includes('drive.google.com') || url.includes('docs.google.com/file');
}

/**
 * Migrate media from either Dropbox or Google Drive folder
 */
async function migrateMediaFolder(folderUrl: string, productName: string, boatId: string): Promise<MigrationResult | null> {
  if (!folderUrl) return null;
  
  // =========================================================================
  // GOOGLE DRIVE HANDLING
  // =========================================================================
  if (isGoogleDriveLink(folderUrl)) {
    console.log(`   Using GOOGLE DRIVE download`);
    
    const gdriveResult = await gdriveDownloadFolder(folderUrl, boatId, productName);
    
    if (!gdriveResult.success) {
      logError("GDriveDownload", new Error(gdriveResult.error || "Unknown error"), { folderUrl, productName, boatId });
      return null;
    }
    
    if (gdriveResult.files.length === 0) {
      cleanupGDriveTempDir(gdriveResult.tempDir);
      return { galleryContent: [], titleImage: "", titleVideo: "" };
    }
    
    // Process files from disk (same as streaming mode)
    const folderName = sanitizeName(productName);
    const r2Prefix = `${CONFIG.category}/${folderName}`;
    
    const videos = gdriveResult.files.filter(f => getFileType(f.name) === "video").sort((a, b) => a.name.localeCompare(b.name));
    const images = gdriveResult.files.filter(f => getFileType(f.name) === "image").sort((a, b) => a.name.localeCompare(b.name));
    const orderedFiles = [...videos, ...images];
    
    const videoUrls: string[] = [];
    const imageUrls: string[] = [];
    let titleImage = "";
    let titleVideo = "";
    
    for (let i = 0; i < orderedFiles.length; i++) {
      const file = orderedFiles[i];
      const fileType = getFileType(file.name);
      const originalSize = (file.size / 1024 / 1024).toFixed(1);
      
      console.log(`   [${i + 1}/${orderedFiles.length}] ${file.name} (${originalSize}MB)`);
      
      try {
        let processedBuffer = readFileSync(file.path);
        let processedFilename = file.name;
        
        if (fileType === "video" && CONFIG.media.convertVideosToMp4) {
          try {
            const result = await processVideo(processedBuffer, file.name);
            processedBuffer = result.buffer;
            processedFilename = result.filename;
          } catch (e: any) {
            console.log(`      Video processing failed, using original`);
          }
        }
        
        if (fileType === "image") {
          try {
            processedBuffer = await compressImage(processedBuffer, file.name);
          } catch {}
        }
        
        const safeName = sanitizeName(processedFilename);
        const r2Key = `${r2Prefix}/${safeName}`;
        
        const finalSize = (processedBuffer.length / 1024 / 1024).toFixed(1);
        process.stdout.write(`      Uploading (${finalSize}MB)...`);
        const cdnUrl = await uploadToR2(processedBuffer, r2Key, getMimeType(processedFilename));
        console.log(` done`);
        
        if (fileType === "video") {
          videoUrls.push(cdnUrl);
          if (!titleVideo) titleVideo = cdnUrl;
        } else {
          imageUrls.push(cdnUrl);
          if (!titleImage) titleImage = cdnUrl;
        }
      } catch (error: any) {
        logError("Upload", error, { fileName: file.name, folder: folderName, boatId });
        console.log(`      FAILED`);
      }
    }
    
    cleanupGDriveTempDir(gdriveResult.tempDir);
    
    const galleryContent = [...videoUrls, ...imageUrls];
    console.log(`   Done: ${videoUrls.length} videos, ${imageUrls.length} images`);
    return { galleryContent, titleImage, titleVideo };
  }
  
  // =========================================================================
  // DROPBOX HANDLING (existing code)
  // =========================================================================
  
  // Check for broken Dropbox links first
  if (hasBrokenLink(boatId)) {
    console.log(`   SKIPPED - Broken Dropbox link (needs client follow-up)`);
    logError("BrokenLink", new Error("Dropbox returns HTML instead of ZIP"), { folderUrl, productName, boatId });
    return null;
  }
  
  // Determine if we should use streaming for this boat
  const streamingInfo = shouldUseStreaming(boatId);
  
  if (streamingInfo.useStreaming) {
    // =========================================================================
    // STREAMING MODE - For large files (>500MB)
    // =========================================================================
    console.log(`   Using STREAMING download (${streamingInfo.reason})`);
    
    const streamResult = await streamingDropboxMigration(folderUrl, boatId, productName);
    
    if (!streamResult.success) {
      logError("StreamingDownload", new Error(streamResult.error || "Unknown error"), { folderUrl, productName, boatId });
      return null;
    }
    
    if (streamResult.files.length === 0) {
      cleanupTempDir(streamResult.tempDir);
      return { galleryContent: [], titleImage: "", titleVideo: "" };
    }
    
    // Process files from disk
    const folderName = sanitizeName(productName);
    const r2Prefix = `${CONFIG.category}/${folderName}`;
    
    // Separate videos and images for ordering (videos first)
    const videos = streamResult.files.filter(f => getFileType(f.name) === "video").sort((a, b) => a.name.localeCompare(b.name));
    const images = streamResult.files.filter(f => getFileType(f.name) === "image").sort((a, b) => a.name.localeCompare(b.name));
    const orderedFiles = [...videos, ...images];
    
    const videoUrls: string[] = [];
    const imageUrls: string[] = [];
    let titleImage = "";
    let titleVideo = "";
    
    for (let i = 0; i < orderedFiles.length; i++) {
      const file = orderedFiles[i];
      const fileType = getFileType(file.name);
      const originalSize = (file.size / 1024 / 1024).toFixed(1);
      
      console.log(`   [${i + 1}/${orderedFiles.length}] ${file.name} (${originalSize}MB)`);
      
      try {
        // Read file from disk
        let processedBuffer = readFileSync(file.path);
        let processedFilename = file.name;
        
        if (fileType === "video" && CONFIG.media.convertVideosToMp4) {
          try {
            const result = await processVideo(processedBuffer, file.name);
            processedBuffer = result.buffer;
            processedFilename = result.filename;
          } catch (e: any) {
            console.log(`      Video processing failed, using original`);
          }
        }
        
        if (fileType === "image") {
          try {
            processedBuffer = await compressImage(processedBuffer, file.name);
          } catch {}
        }
        
        const safeName = sanitizeName(processedFilename);
        const r2Key = `${r2Prefix}/${safeName}`;
        
        const finalSize = (processedBuffer.length / 1024 / 1024).toFixed(1);
        process.stdout.write(`      Uploading (${finalSize}MB)...`);
        const cdnUrl = await uploadToR2(processedBuffer, r2Key, getMimeType(processedFilename));
        console.log(` done`);
        
        if (fileType === "video") {
          videoUrls.push(cdnUrl);
          if (!titleVideo) titleVideo = cdnUrl;
        } else {
          imageUrls.push(cdnUrl);
          if (!titleImage) titleImage = cdnUrl;
        }
      } catch (error: any) {
        logError("Upload", error, { fileName: file.name, folder: folderName, boatId });
        console.log(`      FAILED`);
      }
    }
    
    // Clean up temp directory
    cleanupTempDir(streamResult.tempDir);
    
    const galleryContent = [...videoUrls, ...imageUrls];
    console.log(`   Done: ${videoUrls.length} videos, ${imageUrls.length} images`);
    return { galleryContent, titleImage, titleVideo };
    
  } else {
    // =========================================================================
    // MEMORY MODE - Standard approach for smaller files
    // =========================================================================
    console.log(`   Downloading ZIP (memory mode)...`);
    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadFolderAsZip(dropboxUrl);
      console.log(`   Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    } catch (error: any) {
      logError("Download", error, { dropboxUrl, productName, boatId });
      return null;
    }
    
    console.log(`   Extracting...`);
    let files: ExtractedFile[];
    try {
      files = extractZip(zipBuffer);
      console.log(`   Found ${files.length} media files`);
    } catch (error: any) {
      logError("Extract", error, { dropboxUrl, productName, boatId });
      return null;
    }
    
    if (files.length === 0) return { galleryContent: [], titleImage: "", titleVideo: "" };
    
    // Get folder name
    let folderName = productName;
    if (files[0].path.includes("/")) {
      const firstPart = files[0].path.split("/")[0];
      if (firstPart) folderName = firstPart;
    }
    folderName = sanitizeName(folderName);
    const r2Prefix = `${CONFIG.category}/${folderName}`;
    
    // Separate videos and images for ordering (videos first)
    const videos = files.filter(f => getFileType(f.name) === "video").sort((a, b) => a.name.localeCompare(b.name));
    const images = files.filter(f => getFileType(f.name) === "image").sort((a, b) => a.name.localeCompare(b.name));
    const orderedFiles = [...videos, ...images];
    
    const videoUrls: string[] = [];
    const imageUrls: string[] = [];
    let titleImage = "";
    let titleVideo = "";
    
    for (let i = 0; i < orderedFiles.length; i++) {
      const file = orderedFiles[i];
      const fileType = getFileType(file.name);
      const originalSize = (file.data.length / 1024 / 1024).toFixed(1);
      
      console.log(`   [${i + 1}/${orderedFiles.length}] ${file.name} (${originalSize}MB)`);
      
      try {
        let processedBuffer = file.data;
        let processedFilename = file.name;
        
        if (fileType === "video" && CONFIG.media.convertVideosToMp4) {
          try {
            const result = await processVideo(file.data, file.name);
            processedBuffer = result.buffer;
            processedFilename = result.filename;
          } catch (e: any) {
            console.log(`      Video processing failed, using original`);
          }
        }
        
        if (fileType === "image") {
          try {
            processedBuffer = await compressImage(file.data, file.name);
          } catch {}
        }
        
        const safeName = sanitizeName(processedFilename);
        const r2Key = `${r2Prefix}/${safeName}`;
        
        const finalSize = (processedBuffer.length / 1024 / 1024).toFixed(1);
        process.stdout.write(`      Uploading (${finalSize}MB)...`);
        const cdnUrl = await uploadToR2(processedBuffer, r2Key, getMimeType(processedFilename));
        console.log(` done`);
        
        if (fileType === "video") {
          videoUrls.push(cdnUrl);
          if (!titleVideo) titleVideo = cdnUrl;
        } else {
          imageUrls.push(cdnUrl);
          if (!titleImage) titleImage = cdnUrl;
        }
      } catch (error: any) {
        logError("Upload", error, { fileName: file.name, folder: folderName, boatId });
        console.log(`      FAILED`);
      }
    }
    
    const galleryContent = [...videoUrls, ...imageUrls];
    
    console.log(`   Done: ${videoUrls.length} videos, ${imageUrls.length} images`);
    return { galleryContent, titleImage, titleVideo };
  }
}

// ============================================================================
// CSV PARSING
// ============================================================================

// Boats CSV columns:
// Sr. No,Product Name,Slugs,Tagline,Description,Size,Unit,Starting price ($),Trip Duration Hours,Location,Departure,Inclusions,Guests Max,Year,Cabins,Bathrooms,Title Video Link,Title Image Link,Dropbox Link
const COLUMN_MAP: Record<string, string> = {
  "Sr. No": "id",
  "Product Name": "name",
  "Slugs": "slug",
  "Tagline": "tagline",
  "Description": "description",
  "Size": "size",
  "Unit": "unit",
  "Starting price ($)": "basePrice",
  "Trip Duration Hours": "tripDuration",
  "Location": "location",
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

interface Product {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  size: string;
  unit: string;
  basePrice: string;
  tripDuration: string;
  location: string;
  departure: string;
  inclusions: string;
  maxGuests: string;
  year: string;
  cabins: string;
  bathrooms: string;
  titleImageExternal: string;
  titleVideoExternal: string;
  dropboxLink: string;
  [key: string]: string;
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') { currentField += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = "";
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0] !== "") rows.push(currentRow);
      currentRow = [];
      currentField = "";
      if (char === '\r') i++;
    } else if (char === '\r' && !inQuotes) {
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0] !== "") rows.push(currentRow);
      currentRow = [];
      currentField = "";
    } else {
      currentField += char;
    }
  }
  
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 1 || currentRow[0] !== "") rows.push(currentRow);
  }
  
  return rows;
}

async function fetchProducts(): Promise<Product[]> {
  console.log("Fetching CSV...");
  const response = await fetch(CONFIG.csvUrl);
  if (!response.ok) throw new Error(`CSV fetch failed: ${response.status}`);
  
  const text = await response.text();
  const rows = parseCSV(text);
  
  if (rows.length < 2) throw new Error("CSV empty");
  
  const headers = rows[0];
  console.log(`Headers: ${headers.slice(0, 5).join(", ")}...`);
  
  const products: Product[] = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const rawRow: Record<string, string> = {};
    headers.forEach((header, idx) => { rawRow[header.trim()] = (values[idx] || "").trim(); });
    
    if (!rawRow["Sr. No"] || !rawRow["Product Name"]) continue;
    
    const product: Record<string, string> = {};
    for (const [csvKey, ourKey] of Object.entries(COLUMN_MAP)) {
      product[ourKey] = rawRow[csvKey] || "";
    }
    products.push(product as Product);
  }
  
  console.log(`Found ${products.length} boats\n`);
  return products;
}

// ============================================================================
// MAIN - BATCH PROCESSING
// ============================================================================

async function main() {
  const hasFfmpeg = checkFfmpeg();
  const hasImageMagick = checkImageMagick();
  
  // Parse command line args: startIndex [endIndex]
  const startIndex = parseInt(process.argv[2] || "0", 10);
  const endIndexArg = process.argv[3];
  
  console.log("\n" + "=".repeat(70));
  console.log("ALLIN1RENTALS BOATS MIGRATION (BATCH MODE)");
  console.log("=".repeat(70));
  console.log(`Output: ${CONFIG.outputFile}`);
  console.log(`Starting from index: ${startIndex}`);
  console.log(`ffmpeg: ${hasFfmpeg ? "Yes" : "No"}`);
  console.log(`ImageMagick: ${hasImageMagick ? "Yes" : "No"}`);
  console.log("=".repeat(70) + "\n");
  
  // Verify R2
  console.log("Verifying R2...");
  try {
    await r2Client.send(new HeadBucketCommand({ Bucket: CONFIG.r2.bucketName }));
    console.log("R2 OK\n");
  } catch (e: any) {
    console.error(`R2 failed: ${e.message}`);
    process.exit(1);
  }
  
  // Fetch products
  const products = await fetchProducts();
  
  // Determine end index
  const endIndex = endIndexArg ? Math.min(parseInt(endIndexArg, 10), products.length) : products.length;
  
  // Load existing results if resuming
  let results: any[] = [];
  if (existsSync(CONFIG.outputFile)) {
    try {
      results = JSON.parse(readFileSync(CONFIG.outputFile, "utf-8"));
      console.log(`Loaded ${results.length} existing results\n`);
    } catch { results = []; }
  }
  
  // Track which IDs we already have
  const existingIds = new Set(results.map((r: any) => r.id));
  
  let success = results.length, fail = 0, skipped = 0;
  
  for (let i = startIndex; i < endIndex; i++) {
    const product = products[i];
    
    // Skip if already processed
    if (existingIds.has(product.id)) {
      console.log(`[${i + 1}/${products.length}] ${product.name} - ALREADY DONE, skipping`);
      skipped++;
      continue;
    }
    
    console.log("=".repeat(70));
    console.log(`[${i + 1}/${products.length}] ${product.name}`);
    console.log("=".repeat(70));
    console.log(`   Dropbox: ${product.dropboxLink ? "Yes" : "No"}`);
    
    if (!product.dropboxLink) {
      console.log("   SKIPPED - no Dropbox link\n");
      fail++;
      continue;
    }
    
    try {
      const migrationResult = await migrateMediaFolder(product.dropboxLink, product.name, product.id);
      
      if (migrationResult) {
        const isValidMediaUrl = (url: string): boolean => {
          if (!url) return false;
          if (url.includes("/fo/") || url.includes("/scl/fo/")) return false;
          return /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv)$/i.test(url) || url.includes("r2.dev");
        };
        
        // Clean slug
        let cleanSlug = product.slug || sanitizeName(product.name).toLowerCase();
        cleanSlug = cleanSlug.replace(/^\/+|\/+$/g, "");
        
        const finalProduct = {
          id: product.id,
          name: product.name,
          slug: cleanSlug,
          tagline: product.tagline,
          description: product.description,
          size: product.size,
          unit: product.unit,
          basePrice: extractPrice(product.basePrice), // NUMBER!
          tripDuration: product.tripDuration,
          location: product.location,
          departure: product.departure,
          inclusions: product.inclusions,
          maxGuests: product.maxGuests,
          year: product.year,
          cabins: product.cabins,
          bathrooms: product.bathrooms,
          titleImage: isValidMediaUrl(product.titleImageExternal) ? product.titleImageExternal : migrationResult.titleImage,
          titleVideo: isValidMediaUrl(product.titleVideoExternal) ? product.titleVideoExternal : migrationResult.titleVideo,
          galleryContent: migrationResult.galleryContent,
          category: CONFIG.category,
        };
        
        results.push(finalProduct);
        existingIds.add(product.id);
        success++;
        
        // SAVE AFTER EACH PRODUCT!
        writeFileSync(CONFIG.outputFile, JSON.stringify(results, null, 2));
        console.log(`   SUCCESS (saved ${results.length} products total)\n`);
      } else {
        fail++;
        console.log(`   FAILED\n`);
      }
    } catch (error: any) {
      fail++;
      logError("Migration", error, { product: product.name });
      console.log(`   ERROR: ${error.message}\n`);
    }
  }
  
  // Final summary
  console.log("\n" + "=".repeat(70));
  console.log("BATCH COMPLETE");
  console.log("=".repeat(70));
  console.log(`Processed: ${startIndex} to ${endIndex - 1}`);
  console.log(`Total saved: ${results.length}`);
  console.log(`New success: ${success - (results.length - (success - skipped))}`);
  console.log(`Skipped (already done): ${skipped}`);
  console.log(`Failed: ${fail}`);
  console.log(`Output: ${CONFIG.outputFile}`);
  console.log("=".repeat(70) + "\n");
  
  if (results.length > 0) {
    const totalVideos = results.reduce((sum, p) => sum + p.galleryContent.filter((u: string) => getFileType(u) === "video").length, 0);
    const totalImages = results.reduce((sum, p) => sum + p.galleryContent.filter((u: string) => getFileType(u) === "image").length, 0);
    console.log(`Total videos: ${totalVideos}, Total images: ${totalImages}`);
  }
  
  // Cleanup
  try { if (existsSync(CONFIG.tempDir)) rmSync(CONFIG.tempDir, { recursive: true, force: true }); } catch {}
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
