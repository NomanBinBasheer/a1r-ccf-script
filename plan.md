# Migration Plan: Dropbox to Cloudflare R2 + CDN

## Overview

Replace ImageKit (images) and Cloudinary (videos) with Cloudflare R2 + CDN for all media storage. This handles large video files (up to 600MB+) efficiently and consolidates all media into a single `galleryContent` array per product.

**Test Scope:** Products 3, 4, and 5 from the Google Sheet only.

---

## Current Architecture

```
Dropbox Folder → ImageKit (images) + Cloudinary (videos)
                           ↓
               Output: titleImage, titleVideo, galleryImages, galleryVideos
```

## New Architecture

```
Dropbox Folder → Cloudflare R2 (all media) → Cloudflare CDN
                           ↓
               Output: galleryContent (combined images + videos)
```

---

## Step-by-Step Implementation Plan

### Phase 1: Cloudflare R2 Setup

#### Step 1.1: Create Cloudflare R2 Bucket

1. Log into Cloudflare Dashboard
2. Navigate to **R2 Object Storage**
3. Create a new bucket:
   - **Name:** `media-assets` (or your preferred name)
   - **Location:** Auto (or choose closest region)
4. Note down the bucket name

#### Step 1.2: Generate R2 API Credentials

1. In Cloudflare Dashboard → R2 → **Manage R2 API Tokens**
2. Create a new API token:
   - **Token name:** `dropbox-migration`
   - **Permissions:** Object Read & Write
   - **Specify bucket:** Select your bucket
3. Save these credentials (you'll only see them once):
   - `Access Key ID`
   - `Secret Access Key`
   - `Account ID` (from the URL or dashboard)
   - `Endpoint URL` (format: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)

#### Step 1.3: Enable Public Access via Custom Domain (CDN)

1. Go to your R2 bucket settings
2. Click **Settings** → **Public Access**
3. Choose one of these options:

   **Option A: R2.dev subdomain (Quick setup for testing)**
   - Enable "Allow Access" via r2.dev subdomain
   - You'll get a URL like: `https://pub-<hash>.r2.dev`
   
   **Option B: Custom Domain (Recommended for production)**
   - Click "Connect Domain"
   - Enter your domain (e.g., `cdn.yourdomain.com`)
   - Cloudflare will automatically configure DNS and enable caching

4. Note your public CDN URL for later use

---

### Phase 2: Environment Configuration

#### Step 2.1: Update `.env` File

Add these new variables to your `.env`:

```env
# Cloudflare R2 Configuration
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET_NAME=media-assets
R2_PUBLIC_URL=https://cdn.yourdomain.com
# OR for r2.dev: R2_PUBLIC_URL=https://pub-<hash>.r2.dev

# Keep existing Dropbox token
DROPBOX_ACCESS_TOKEN=your_dropbox_access_token
```

#### Step 2.2: Update `.env.example`

```env
# Cloudflare R2 Configuration
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET_NAME=your_bucket_name
R2_PUBLIC_URL=https://your-cdn-url.com

# Dropbox Configuration
DROPBOX_ACCESS_TOKEN=your_dropbox_access_token
```

---

### Phase 3: Install Dependencies

#### Step 3.1: Install AWS SDK for R2

Cloudflare R2 is S3-compatible, so we use the AWS SDK:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

The `@aws-sdk/lib-storage` package is needed for multipart uploads (large files).

#### Step 3.2: Updated `package.json`

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.x.x",
    "@aws-sdk/lib-storage": "^3.x.x",
    "csv-parser": "^3.2.0",
    "dotenv": "^17.2.3",
    "dropbox": "^10.34.0",
    "node-fetch": "^3.3.2"
  }
}
```

Note: Remove `imagekit` and `cloudinary` dependencies (no longer needed).

---

### Phase 4: Create New Migration Script

#### Step 4.1: Create `migrate-r2.js`

Create a new file `migrate-r2.js` with the following structure:

```javascript
import "dotenv/config";
import { Dropbox } from "dropbox";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fetch from "node-fetch";
import fs from "fs";
import { getDataFromCSVUrl } from "./sheet.js";

// ============================================
// Configuration & Validation
// ============================================

const requiredEnvVars = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY", 
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "DROPBOX_ACCESS_TOKEN",
];

const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error("Missing required environment variables:", missingEnvVars);
  process.exit(1);
}

// ============================================
// Initialize Clients
// ============================================

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const dropbox = new Dropbox({
  accessToken: process.env.DROPBOX_ACCESS_TOKEN,
  fetch,
});

const BUCKET = process.env.R2_BUCKET_NAME;
const CDN_URL = process.env.R2_PUBLIC_URL.replace(/\/$/, ""); // Remove trailing slash

// ============================================
// File Type Detection
// ============================================

const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".heic", ".heif", ".tiff", ".tif"];
const videoExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".mpeg", ".mpg", ".3gp"];

function getFileType(filename) {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  if (imageExtensions.includes(ext)) return "image";
  if (videoExtensions.includes(ext)) return "video";
  return "unknown";
}

function getMimeType(filename) {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska", ".webm": "video/webm",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

// ============================================
// Utility Functions
// ============================================

function sanitizeFileName(name) {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[<>:"/\\|?*\(\)']/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Error logging
const ERROR_LOG_FILE = "error_logs_r2.txt";

function logError(context, error, additionalInfo = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `
================================================================================
[${timestamp}] ERROR in ${context}
--------------------------------------------------------------------------------
Message: ${error?.message || String(error)}
Additional Info: ${JSON.stringify(additionalInfo, null, 2)}
================================================================================
`;
  fs.appendFileSync(ERROR_LOG_FILE, logEntry);
  console.error(`ERROR in ${context}:`, error?.message || error);
}

// ============================================
// R2 Upload Functions
// ============================================

/**
 * Upload small files (< 100MB) using simple PutObject
 */
async function uploadSmallFile(buffer, key, mimeType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  });
  
  await r2Client.send(command);
  return `${CDN_URL}/${key}`;
}

/**
 * Upload large files (>= 100MB) using multipart upload
 * This handles files up to 5TB and is required for large videos
 */
async function uploadLargeFile(buffer, key, mimeType) {
  const upload = new Upload({
    client: r2Client,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    },
    // 100MB part size for efficient large file uploads
    partSize: 100 * 1024 * 1024,
    // Leave enough room to handle very large files
    leavePartsOnError: false,
  });

  // Optional: Track upload progress
  upload.on("httpUploadProgress", (progress) => {
    const percent = Math.round((progress.loaded / progress.total) * 100);
    process.stdout.write(`\r    Upload progress: ${percent}%`);
  });

  await upload.done();
  console.log(); // New line after progress
  return `${CDN_URL}/${key}`;
}

/**
 * Main upload function - chooses strategy based on file size
 */
async function uploadToR2(buffer, key, mimeType) {
  const fileSizeMB = buffer.length / (1024 * 1024);
  
  if (fileSizeMB >= 100) {
    console.log(`    Using multipart upload for large file (${fileSizeMB.toFixed(2)} MB)...`);
    return await uploadLargeFile(buffer, key, mimeType);
  } else {
    return await uploadSmallFile(buffer, key, mimeType);
  }
}

// ============================================
// Dropbox Functions
// ============================================

/**
 * Recursively list all files in a Dropbox folder (including subfolders)
 */
async function listDropboxFilesRecursive(url, path = "") {
  const allFiles = [];
  
  try {
    let response = await dropbox.filesListFolder({
      path: path,
      shared_link: { url },
      recursive: false,
    });
    
    let entries = response.result.entries;
    
    // Process entries
    for (const entry of entries) {
      if (entry[".tag"] === "file") {
        allFiles.push(entry);
      } else if (entry[".tag"] === "folder") {
        // Recursively get files from subfolder
        console.log(`    Found subfolder: ${entry.name}`);
        const subfolderFiles = await listDropboxFilesRecursive(url, entry.path_lower);
        allFiles.push(...subfolderFiles);
      }
    }
    
    // Handle pagination
    while (response.result.has_more) {
      response = await dropbox.filesListFolderContinue({
        cursor: response.result.cursor,
      });
      
      for (const entry of response.result.entries) {
        if (entry[".tag"] === "file") {
          allFiles.push(entry);
        } else if (entry[".tag"] === "folder") {
          const subfolderFiles = await listDropboxFilesRecursive(url, entry.path_lower);
          allFiles.push(...subfolderFiles);
        }
      }
    }
  } catch (error) {
    logError("listDropboxFilesRecursive", error, { url, path });
    throw error;
  }
  
  return allFiles;
}

/**
 * Download a file from Dropbox shared link
 */
async function downloadFromDropbox(url, filePath) {
  const download = await dropbox.sharingGetSharedLinkFile({
    url: url,
    path: filePath,
  });
  return Buffer.from(download.result.fileBinary, "binary");
}

// ============================================
// Main Migration Function
// ============================================

async function migrateFolder(url, baseFolder) {
  const galleryContent = [];
  const skippedFiles = [];
  
  if (!url) {
    console.warn("No Dropbox link provided, skipping...");
    return null;
  }

  // Get folder metadata
  let folderName;
  try {
    const meta = await dropbox.sharingGetSharedLinkMetadata({ url });
    folderName = meta.result.name;
    console.log(`\nFolder name: ${folderName}`);
  } catch (err) {
    logError("Get Folder Metadata", err, { url });
    return null;
  }

  const sanitizedFolderName = sanitizeFileName(folderName);
  const r2FolderPath = `${baseFolder}/${sanitizedFolderName}`;
  console.log(`R2 folder path: ${r2FolderPath}`);

  // Get all files (including subfolders)
  let allFiles;
  try {
    console.log("Scanning folder (including subfolders)...");
    allFiles = await listDropboxFilesRecursive(url);
    console.log(`Found ${allFiles.length} files total\n`);
  } catch (err) {
    logError("List Files", err, { url, folderName });
    return null;
  }

  // Process each file
  for (const file of allFiles) {
    const fileName = file.name;
    const safeName = sanitizeFileName(fileName);
    const fileType = getFileType(fileName);
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
    const filePath = file.path_lower || "/" + fileName;
    
    // Determine subfolder path for R2 key
    // e.g., /subfolder/image.jpg -> subfolder/image.jpg
    const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const r2Key = `${r2FolderPath}/${sanitizeFileName(relativePath)}`;

    if (fileType === "unknown") {
      console.log(`  Skipping unknown file type: ${fileName}`);
      continue;
    }

    console.log(`Processing: ${fileName} (${fileType}, ${fileSizeMB} MB)`);

    try {
      // Download from Dropbox
      console.log(`    Downloading from Dropbox...`);
      const buffer = await downloadFromDropbox(url, filePath);

      // Upload to R2
      console.log(`    Uploading to R2...`);
      const mimeType = getMimeType(fileName);
      const cdnUrl = await uploadToR2(buffer, r2Key, mimeType);

      galleryContent.push({
        url: cdnUrl,
        type: fileType,
      });

      console.log(`    SUCCESS: ${cdnUrl}\n`);
    } catch (error) {
      logError("File Upload", error, { fileName, filePath, size: fileSizeMB });
      console.log(`    FAILED: ${error.message}\n`);
      skippedFiles.push({ name: fileName, reason: error.message });
    }
  }

  // Summary
  console.log("=".repeat(60));
  console.log(`FOLDER SUMMARY: ${folderName}`);
  console.log(`  Uploaded: ${galleryContent.length} files`);
  console.log(`  Skipped: ${skippedFiles.length} files`);
  console.log("=".repeat(60));

  // Return combined galleryContent (all images + videos together)
  return {
    galleryContent: galleryContent.map(item => item.url),
  };
}

// ============================================
// Main Execution
// ============================================

const CSV_URL = process.argv[2];
const BASE_FOLDER = process.argv[3] || "boats";

// TEST MODE: Only process products 3, 4, 5 (indices 2, 3, 4)
const TEST_PRODUCTS = [2, 3, 4]; // 0-indexed positions for products 3, 4, 5

if (!CSV_URL) {
  console.error("Usage: node migrate-r2.js <CSV_URL> [BASE_FOLDER]");
  process.exit(1);
}

console.log("\n" + "=".repeat(60));
console.log("STARTING R2 MIGRATION");
console.log("=".repeat(60));
console.log(`CSV URL: ${CSV_URL}`);
console.log(`Base Folder: ${BASE_FOLDER}`);
console.log(`CDN URL: ${CDN_URL}`);
console.log(`Test Mode: Products 3, 4, 5 only`);
console.log("=".repeat(60) + "\n");

// Load products from CSV
const allProducts = await getDataFromCSVUrl(CSV_URL, BASE_FOLDER.toLowerCase());
console.log(`Total products in sheet: ${allProducts.length}`);

// Filter to test products only
const products = TEST_PRODUCTS.map(i => allProducts[i]).filter(Boolean);
console.log(`Processing ${products.length} test products (3, 4, 5)\n`);

let processedCount = 0;
let successCount = 0;
let failedCount = 0;

for (const product of products) {
  processedCount++;
  const originalIndex = TEST_PRODUCTS[processedCount - 1] + 1; // 1-indexed for display
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PRODUCT ${originalIndex} (${processedCount}/${products.length})`);
  console.log(`Name: ${product.name || "N/A"}`);
  console.log("=".repeat(60));

  const dropboxLink = product.dropboxLink;
  
  if (!dropboxLink) {
    console.log("No Dropbox link found, skipping...");
    failedCount++;
    continue;
  }

  console.log(`Dropbox Link: ${dropboxLink}`);

  try {
    const uploadedData = await migrateFolder(dropboxLink, BASE_FOLDER);

    if (!uploadedData) {
      failedCount++;
      console.log("Failed to migrate this product's folder\n");
      continue;
    }

    // Update product object with combined galleryContent
    product.galleryContent = uploadedData.galleryContent;
    
    // Set first image as titleImage, first video as titleVideo
    const images = uploadedData.galleryContent.filter(url => 
      imageExtensions.some(ext => url.toLowerCase().endsWith(ext))
    );
    const videos = uploadedData.galleryContent.filter(url => 
      videoExtensions.some(ext => url.toLowerCase().endsWith(ext))
    );
    
    product.titleImage = images[0] || "";
    product.titleVideo = videos[0] || "";
    product.instantBooking = true;

    // Process inclusions for boats
    if (BASE_FOLDER === "boats" && product.inclusions && typeof product.inclusions === "string") {
      product.inclusions = product.inclusions.split(",").map(inc => inc.trim());
    }
    product.category = BASE_FOLDER;

    // Remove dropboxLink from final output
    delete product.dropboxLink;

    successCount++;
    console.log("Product migration completed successfully!\n");
  } catch (error) {
    failedCount++;
    logError("Product Migration", error, { dropboxLink, product: product.name });
    console.log("Failed to migrate product\n");
  }
}

// Save results
const outputFile = `test-${BASE_FOLDER}-r2.json`;
fs.writeFileSync(outputFile, JSON.stringify(products, null, 2));

console.log("\n" + "=".repeat(60));
console.log("MIGRATION COMPLETED");
console.log("=".repeat(60));
console.log(`Total test products: ${products.length}`);
console.log(`Successfully migrated: ${successCount}`);
console.log(`Failed: ${failedCount}`);
console.log(`Output file: ${outputFile}`);
console.log(`Error log: ${ERROR_LOG_FILE}`);
console.log("=".repeat(60) + "\n");
```

---

### Phase 5: Test Execution

#### Step 5.1: Verify Environment

```bash
# Check .env is configured
cat .env | grep R2_

# Expected output:
# R2_ACCESS_KEY_ID=...
# R2_SECRET_ACCESS_KEY=...
# R2_ACCOUNT_ID=...
# R2_BUCKET_NAME=...
# R2_PUBLIC_URL=...
```

#### Step 5.2: Run Test Migration

```bash
# For boats (products 3, 4, 5)
node migrate-r2.js "YOUR_CSV_URL" boats

# Example with actual CSV URL:
node migrate-r2.js "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/export?format=csv&gid=0" boats
```

#### Step 5.3: Verify Results

1. **Check output JSON:**
   ```bash
   cat test-boats-r2.json | head -100
   ```

2. **Verify R2 bucket contents:**
   - Go to Cloudflare Dashboard → R2 → Your Bucket
   - Confirm files are uploaded to `boats/[product-folder]/`

3. **Test CDN URLs:**
   - Copy any URL from the output JSON
   - Open in browser to confirm accessibility

4. **Check error logs:**
   ```bash
   cat error_logs_r2.txt
   ```

---

### Phase 6: Output Format

The new output JSON will have this structure:

```json
[
  {
    "id": "3",
    "name": "Product Name",
    "tagline": "...",
    "description": "...",
    "location": "...",
    "basePrice": "$XXX",
    "titleImage": "https://cdn.yourdomain.com/boats/ProductFolder/image1.jpg",
    "titleVideo": "https://cdn.yourdomain.com/boats/ProductFolder/video1.mp4",
    "galleryContent": [
      "https://cdn.yourdomain.com/boats/ProductFolder/image1.jpg",
      "https://cdn.yourdomain.com/boats/ProductFolder/image2.jpg",
      "https://cdn.yourdomain.com/boats/ProductFolder/subfolder/image3.jpg",
      "https://cdn.yourdomain.com/boats/ProductFolder/video1.mp4",
      "https://cdn.yourdomain.com/boats/ProductFolder/subfolder/video2.mp4"
    ],
    "instantBooking": true,
    "category": "boats"
  }
]
```

**Key changes from current output:**
- `galleryContent` now contains ALL media (images + videos combined)
- Files from subfolders are included
- All URLs point to R2/CDN instead of ImageKit/Cloudinary
- `titleImage` and `titleVideo` are auto-selected from the first image/video

---

### Phase 7: rclone Setup (Optional Alternative)

If the Node.js approach has issues with very large files, rclone can be used as a fallback:

#### Step 7.1: Install rclone

```bash
# Linux
curl https://rclone.org/install.sh | sudo bash

# macOS
brew install rclone
```

#### Step 7.2: Configure rclone for R2

```bash
rclone config

# Choose: n) New remote
# Name: r2
# Storage: 5 (Amazon S3 Compliant)
# Provider: Cloudflare
# Access Key ID: [your R2 access key]
# Secret Access Key: [your R2 secret key]
# Endpoint: https://[account-id].r2.cloudflarestorage.com
# Leave other options as default
```

#### Step 7.3: Usage Example

```bash
# Upload a single file
rclone copy /path/to/file r2:bucket-name/folder/

# Upload a directory
rclone copy /path/to/folder r2:bucket-name/folder/ --progress

# Sync (mirror) a directory
rclone sync /path/to/folder r2:bucket-name/folder/ --progress
```

---

## Checklist

- [ ] **Phase 1:** Cloudflare R2 bucket created
- [ ] **Phase 1:** R2 API credentials generated
- [ ] **Phase 1:** Public access/CDN configured
- [ ] **Phase 2:** `.env` updated with R2 credentials
- [ ] **Phase 3:** AWS SDK packages installed
- [ ] **Phase 4:** `migrate-r2.js` script created
- [ ] **Phase 5:** Test run completed with products 3, 4, 5
- [ ] **Phase 5:** CDN URLs verified accessible
- [ ] **Phase 5:** Subfolder files verified in output
- [ ] **Phase 6:** Output JSON format validated

---

## Troubleshooting

### Common Issues

1. **"Access Denied" errors**
   - Verify R2 API token has read/write permissions
   - Check bucket name is correct

2. **"Signature mismatch" errors**
   - Ensure endpoint URL format is correct
   - Verify access key and secret key are correct

3. **Large file upload timeouts**
   - The multipart upload should handle this
   - If issues persist, consider using rclone

4. **CDN URLs not accessible**
   - Verify public access is enabled on the bucket
   - Check custom domain DNS is propagated

5. **Dropbox rate limiting**
   - Add delays between file downloads if needed
   - Consider batching requests

---

## Cost Considerations

**Cloudflare R2 Pricing (as of 2024):**
- Storage: $0.015/GB/month
- Class A operations (writes): $4.50/million
- Class B operations (reads): $0.36/million
- Egress: FREE (this is the major advantage over S3/GCS)

For a typical migration of ~100 products with ~50 files each (~5GB total):
- Storage: ~$0.075/month
- Write operations: ~$0.02 (one-time)
- Reads: Effectively free due to CDN caching

---

## Next Steps After Testing

1. **Full migration:** Remove the `TEST_PRODUCTS` filter to process all products
2. **Cleanup:** Remove old ImageKit/Cloudinary dependencies from package.json
3. **Update application:** Update any code that references the old CDN URLs
4. **Delete old files:** Remove files from ImageKit/Cloudinary after verification
