# Migration Plan v2: Dropbox → Cloudflare R2 + CDN (rclone-powered)

## Analysis: Your Script vs My Original Plan

| Aspect | Your Script | My Original Plan | Winner |
|--------|-------------|------------------|--------|
| **File Transfer** | rclone (delegated) | Direct API upload | Your script - rclone is battle-tested |
| **Large Files (600MB)** | rclone handles automatically | Manual multipart upload | Your script - rclone excels here |
| **Subfolder Handling** | rclone sync recursive | Dropbox API recursive | Tie - both work |
| **Share Link Support** | ❌ Broken - can't convert share URLs to rclone paths | ✅ Works via Dropbox API | My plan |
| **Code Complexity** | Lower | Higher | Your script |
| **Reliability** | High (rclone) | Medium (manual retries needed) | Your script |

### Critical Issue with Your Script

Your script has a fundamental problem: **Dropbox share URLs cannot be directly converted to rclone-accessible paths**.

```typescript
// Your script tries this:
function dropboxUrlToRclonePath(url: string): string | null {
  const folderId = extractDropboxFolderId(url);
  return `shared/${folderId}`;  // ❌ This won't work
}
```

**Why it fails:**
- Share URL: `https://www.dropbox.com/scl/fo/abc123xyz/MyFolder?rlkey=...`
- rclone needs: `dropbox:/Boats/MyBoatFolder/` (actual file path)
- There's no API to convert share link folder IDs to file paths

---

## Recommended Hybrid Approach

Combine the best of both:

```
┌─────────────────────────────────────────────────────────────────┐
│                      HYBRID WORKFLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Dropbox Share Link                                            │
│         │                                                        │
│         ▼                                                        │
│   [Dropbox API] ──download──► Local Temp Folder                 │
│         │                     (handles share links)             │
│         │                            │                           │
│         │                            ▼                           │
│         │                     [rclone sync]                      │
│         │                     (handles large files)             │
│         │                            │                           │
│         │                            ▼                           │
│         │                     Cloudflare R2                      │
│         │                            │                           │
│         │                            ▼                           │
│         └─────────────────► Generate JSON                        │
│                              with CDN URLs                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Implementation Plan

### Phase 1: Prerequisites Setup

#### Step 1.1: Create Cloudflare R2 Bucket

1. Cloudflare Dashboard → R2 Object Storage
2. Create bucket: `allin1rentals-media`
3. Enable public access (custom domain or r2.dev subdomain)
4. Note your public URL: `https://media.allin1rentals.com` or `https://pub-xxx.r2.dev`

#### Step 1.2: Generate R2 API Credentials

1. R2 → Manage R2 API Tokens → Create token
2. Permissions: Object Read & Write
3. Save credentials:
   - Access Key ID
   - Secret Access Key
   - Account ID

#### Step 1.3: Configure rclone

```bash
# Install rclone if needed
curl https://rclone.org/install.sh | sudo bash

# Configure R2 remote
rclone config

# Choose: n (new remote)
# Name: r2
# Storage: 5 (Amazon S3 Compliant)
# Provider: Cloudflare
# Access Key ID: [your R2 key]
# Secret Access Key: [your R2 secret]
# Endpoint: https://[account-id].r2.cloudflarestorage.com
# ACL: private
```

**No need to configure Dropbox in rclone** - we'll use the Dropbox SDK for share link access.

#### Step 1.4: Environment Variables

Create/update `.env`:

```env
# Cloudflare R2
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=allin1rentals-media
R2_PUBLIC_DOMAIN=https://media.allin1rentals.com

# Dropbox (for API access to share links)
DROPBOX_ACCESS_TOKEN=your_dropbox_token

# Local temp directory for downloads
TEMP_DIR=./temp-downloads
```

---

### Phase 2: Install Dependencies

```bash
# Using Bun (as per your script preference)
bun add dropbox @aws-sdk/client-s3 csv-parse

# Or using npm
npm install dropbox @aws-sdk/client-s3 csv-parse
```

---

### Phase 3: Create Migration Script

Create `migrate-r2-hybrid.ts`:

```typescript
#!/usr/bin/env bun

/**
 * AllIn1Rentals Migration - Hybrid Approach
 * 
 * 1. Downloads from Dropbox share links via API (handles share URLs correctly)
 * 2. Uploads to R2 via rclone (handles large files efficiently)
 * 3. Generates JSON with combined galleryContent
 * 
 * USAGE:
 *   bun run migrate-r2-hybrid.ts <CSV_URL> <CATEGORY>
 *   
 * EXAMPLE:
 *   bun run migrate-r2-hybrid.ts "https://docs.google.com/.../export?format=csv" boats
 */

import { Dropbox } from "dropbox";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // R2 Configuration
  r2: {
    accountId: process.env.R2_ACCOUNT_ID!,
    bucketName: process.env.R2_BUCKET_NAME!,
    publicDomain: process.env.R2_PUBLIC_DOMAIN!.replace(/\/$/, ""),
  },

  // Dropbox
  dropboxToken: process.env.DROPBOX_ACCESS_TOKEN!,

  // Local temp directory
  tempDir: process.env.TEMP_DIR || "./temp-downloads",

  // rclone remote name for R2
  rcloneRemote: "r2",

  // Test mode: only process products 3, 4, 5 (indices 2, 3, 4)
  testProducts: [2, 3, 4],
  testMode: true,
};

// Validate environment
const requiredEnv = ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_PUBLIC_DOMAIN", "DROPBOX_ACCESS_TOKEN"];
const missing = requiredEnv.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error("❌ Missing environment variables:", missing.join(", "));
  process.exit(1);
}

// ============================================================================
// CLIENTS
// ============================================================================

const dropbox = new Dropbox({
  accessToken: CONFIG.dropboxToken,
  fetch: fetch,
});

// ============================================================================
// TYPES
// ============================================================================

interface Product {
  id: string;
  name: string;
  dropboxLink?: string;
  [key: string]: any;
}

interface MediaFile {
  localPath: string;
  r2Key: string;
  cdnUrl: string;
  type: "image" | "video";
}

// ============================================================================
// FILE TYPE HELPERS
// ============================================================================

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".svg"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv", ".wmv"];

function getFileType(filename: string): "image" | "video" | "unknown" {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "unknown";
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[<>:"/\\|?*\(\)']/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ============================================================================
// DROPBOX FUNCTIONS
// ============================================================================

/**
 * List all files in a Dropbox shared folder (recursively)
 */
async function listDropboxSharedFolder(
  shareUrl: string,
  subPath: string = ""
): Promise<Array<{ name: string; path: string; size: number; isFolder: boolean }>> {
  const allFiles: Array<{ name: string; path: string; size: number; isFolder: boolean }> = [];

  try {
    let response = await dropbox.filesListFolder({
      path: subPath,
      shared_link: { url: shareUrl },
      recursive: false,
    });

    const processEntries = async (entries: any[]) => {
      for (const entry of entries) {
        if (entry[".tag"] === "file") {
          allFiles.push({
            name: entry.name,
            path: entry.path_lower || `/${entry.name}`,
            size: entry.size,
            isFolder: false,
          });
        } else if (entry[".tag"] === "folder") {
          console.log(`      📁 Found subfolder: ${entry.name}`);
          // Recursively get files from subfolder
          const subFiles = await listDropboxSharedFolder(shareUrl, entry.path_lower);
          allFiles.push(...subFiles);
        }
      }
    };

    await processEntries(response.result.entries);

    // Handle pagination
    while (response.result.has_more) {
      response = await dropbox.filesListFolderContinue({
        cursor: response.result.cursor,
      });
      await processEntries(response.result.entries);
    }
  } catch (error: any) {
    console.error(`      ❌ Error listing folder: ${error.message}`);
    throw error;
  }

  return allFiles;
}

/**
 * Download a file from Dropbox shared link
 */
async function downloadDropboxFile(
  shareUrl: string,
  filePath: string,
  localPath: string
): Promise<void> {
  const download = await dropbox.sharingGetSharedLinkFile({
    url: shareUrl,
    path: filePath,
  });

  const buffer = Buffer.from((download.result as any).fileBinary, "binary");
  
  // Ensure directory exists
  mkdirSync(path.dirname(localPath), { recursive: true });
  writeFileSync(localPath, buffer);
}

// ============================================================================
// RCLONE FUNCTIONS
// ============================================================================

/**
 * Upload local directory to R2 using rclone
 */
function rcloneSyncToR2(localDir: string, r2Path: string): void {
  const cmd = `rclone sync "${localDir}" ${CONFIG.rcloneRemote}:${CONFIG.r2.bucketName}/${r2Path} --progress --transfers=8 -v`;
  
  console.log(`      📤 rclone sync → ${r2Path}`);
  
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (error: any) {
    console.error(`      ❌ rclone error: ${error.message}`);
    throw error;
  }
}

/**
 * Get all files in a local directory recursively
 */
function getLocalFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  
  if (!existsSync(dir)) return files;
  
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getLocalFiles(fullPath, baseDir));
    } else {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  
  return files;
}

// ============================================================================
// MAIN MIGRATION FUNCTION
// ============================================================================

async function migrateProduct(
  product: Product,
  category: string
): Promise<{ galleryContent: string[]; titleImage?: string; titleVideo?: string } | null> {
  const dropboxUrl = product.dropboxLink;
  
  if (!dropboxUrl) {
    console.log("   ⚠️ No Dropbox link, skipping");
    return null;
  }

  // Get folder name from Dropbox
  let folderName: string;
  try {
    const meta = await dropbox.sharingGetSharedLinkMetadata({ url: dropboxUrl });
    folderName = sanitizeName(meta.result.name);
    console.log(`   📁 Dropbox folder: ${meta.result.name}`);
  } catch (error: any) {
    console.error(`   ❌ Cannot access Dropbox link: ${error.message}`);
    return null;
  }

  // Create local temp directory for this product
  const localDir = path.join(CONFIG.tempDir, category, folderName);
  if (existsSync(localDir)) {
    rmSync(localDir, { recursive: true });
  }
  mkdirSync(localDir, { recursive: true });

  // List all files in Dropbox (including subfolders)
  console.log(`   📋 Scanning Dropbox folder...`);
  let dropboxFiles;
  try {
    dropboxFiles = await listDropboxSharedFolder(dropboxUrl);
    console.log(`   📊 Found ${dropboxFiles.length} files`);
  } catch (error) {
    return null;
  }

  // Filter to only media files
  const mediaFiles = dropboxFiles.filter(f => getFileType(f.name) !== "unknown");
  console.log(`   🖼️ ${mediaFiles.length} media files to download`);

  // Download all media files
  console.log(`   📥 Downloading from Dropbox...`);
  for (const file of mediaFiles) {
    const localPath = path.join(localDir, sanitizeName(file.path.replace(/^\//, "")));
    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    
    try {
      process.stdout.write(`      ↓ ${file.name} (${sizeMB}MB)...`);
      await downloadDropboxFile(dropboxUrl, file.path, localPath);
      console.log(" ✅");
    } catch (error: any) {
      console.log(` ❌ ${error.message}`);
    }
  }

  // Upload to R2 using rclone
  const r2Path = `${category}/${folderName}`;
  console.log(`   📤 Uploading to R2 via rclone...`);
  
  try {
    rcloneSyncToR2(localDir, r2Path);
    console.log(`   ✅ Upload complete`);
  } catch (error) {
    console.error(`   ❌ Upload failed`);
    return null;
  }

  // Generate CDN URLs from local file structure
  const localFiles = getLocalFiles(localDir);
  const galleryContent: string[] = [];
  let titleImage: string | undefined;
  let titleVideo: string | undefined;

  for (const relPath of localFiles) {
    const cdnUrl = `${CONFIG.r2.publicDomain}/${r2Path}/${relPath}`;
    const fileType = getFileType(relPath);

    if (fileType === "image") {
      if (!titleImage) titleImage = cdnUrl;
      galleryContent.push(cdnUrl);
    } else if (fileType === "video") {
      if (!titleVideo) titleVideo = cdnUrl;
      galleryContent.push(cdnUrl);
    }
  }

  // Cleanup temp files
  rmSync(localDir, { recursive: true });

  console.log(`   📊 Result: ${galleryContent.length} files (${galleryContent.filter(u => getFileType(u) === "image").length} images, ${galleryContent.filter(u => getFileType(u) === "video").length} videos)`);

  return { galleryContent, titleImage, titleVideo };
}

// ============================================================================
// CSV PARSING
// ============================================================================

async function fetchAndParseCSV(url: string, category: string): Promise<Product[]> {
  const response = await fetch(url);
  const text = await response.text();
  
  // Simple CSV parsing (or use csv-parse for robustness)
  const lines = text.split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  
  const products: Product[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    // Handle CSV properly (quoted fields with commas)
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    
    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    
    // Map to Product structure (adjust based on your CSV columns)
    products.push({
      id: row["Sr. No"] || row["id"] || String(i),
      name: row["Product Name"] || row["name"] || "",
      dropboxLink: row["Dropbox Link"] || row["Dropbox LINK"] || row["dropboxLink"] || "",
      ...row,
    });
  }
  
  return products;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const csvUrl = process.argv[2];
  const category = process.argv[3] || "boats";

  if (!csvUrl) {
    console.error("Usage: bun run migrate-r2-hybrid.ts <CSV_URL> <CATEGORY>");
    console.error("Example: bun run migrate-r2-hybrid.ts 'https://docs.google.com/.../export?format=csv' boats");
    process.exit(1);
  }

  console.log("\n" + "═".repeat(70));
  console.log("🚀 ALLIN1RENTALS R2 MIGRATION - Hybrid Mode");
  console.log("═".repeat(70));
  console.log(`📄 CSV URL: ${csvUrl.substring(0, 60)}...`);
  console.log(`📁 Category: ${category}`);
  console.log(`🌐 CDN Domain: ${CONFIG.r2.publicDomain}`);
  console.log(`🧪 Test Mode: Products 3, 4, 5 only`);
  console.log("═".repeat(70) + "\n");

  // Fetch products from CSV
  console.log("📥 Fetching product data from CSV...");
  const allProducts = await fetchAndParseCSV(csvUrl, category);
  console.log(`   Found ${allProducts.length} total products\n`);

  // Filter to test products (3, 4, 5 = indices 2, 3, 4)
  const testProducts = CONFIG.testMode
    ? CONFIG.testProducts.map(i => allProducts[i]).filter(Boolean)
    : allProducts;

  console.log(`📋 Processing ${testProducts.length} products...\n`);

  const results: Product[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < testProducts.length; i++) {
    const product = testProducts[i];
    const productNum = CONFIG.testMode ? CONFIG.testProducts[i] + 1 : i + 1;

    console.log("─".repeat(70));
    console.log(`📦 PRODUCT ${productNum}: ${product.name || "Unnamed"}`);
    console.log("─".repeat(70));

    try {
      const mediaResult = await migrateProduct(product, category);

      if (mediaResult) {
        // Update product with new URLs
        const updatedProduct: Product = {
          ...product,
          titleImage: mediaResult.titleImage || "",
          titleVideo: mediaResult.titleVideo || "",
          galleryContent: mediaResult.galleryContent,
          instantBooking: true,
          category: category,
        };

        // Remove dropboxLink from output
        delete updatedProduct.dropboxLink;
        delete updatedProduct["Dropbox Link"];
        delete updatedProduct["Dropbox LINK"];

        results.push(updatedProduct);
        successCount++;
        console.log(`   ✅ SUCCESS\n`);
      } else {
        failCount++;
        console.log(`   ❌ FAILED\n`);
      }
    } catch (error: any) {
      failCount++;
      console.error(`   ❌ ERROR: ${error.message}\n`);
    }
  }

  // Save results
  const outputFile = `output-${category}-r2.json`;
  writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Summary
  console.log("\n" + "═".repeat(70));
  console.log("📊 MIGRATION COMPLETE");
  console.log("═".repeat(70));
  console.log(`   Total Processed: ${testProducts.length}`);
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Failed: ${failCount}`);
  console.log(`   📄 Output: ${outputFile}`);
  console.log("═".repeat(70) + "\n");
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
```

---

### Phase 4: Execution

#### Step 4.1: Setup Verification

```bash
# Verify rclone R2 remote works
rclone lsd r2:

# If not configured, run:
rclone config
# Follow prompts for Cloudflare R2

# Verify environment
cat .env | grep -E "^(R2_|DROPBOX_)"
```

#### Step 4.2: Run Test Migration

```bash
# Run for boats (products 3, 4, 5)
bun run migrate-r2-hybrid.ts "YOUR_CSV_URL" boats

# Example:
bun run migrate-r2-hybrid.ts "https://docs.google.com/spreadsheets/d/xxx/export?format=csv&gid=0" boats
```

#### Step 4.3: Verify Results

```bash
# Check output JSON
cat output-boats-r2.json | head -50

# Check R2 bucket
rclone ls r2:allin1rentals-media/boats/

# Test CDN URLs (copy from output JSON)
curl -I "https://media.allin1rentals.com/boats/ProductFolder/image.jpg"
```

---

### Phase 5: Output Format

```json
[
  {
    "id": "3",
    "name": "Product Name",
    "tagline": "...",
    "description": "...",
    "location": "...",
    "basePrice": "$XXX",
    "titleImage": "https://media.allin1rentals.com/boats/ProductFolder/image1.jpg",
    "titleVideo": "https://media.allin1rentals.com/boats/ProductFolder/video1.mp4",
    "galleryContent": [
      "https://media.allin1rentals.com/boats/ProductFolder/image1.jpg",
      "https://media.allin1rentals.com/boats/ProductFolder/image2.png",
      "https://media.allin1rentals.com/boats/ProductFolder/subfolder/image3.jpg",
      "https://media.allin1rentals.com/boats/ProductFolder/video1.mp4",
      "https://media.allin1rentals.com/boats/ProductFolder/subfolder/video2.mov"
    ],
    "instantBooking": true,
    "category": "boats"
  }
]
```

---

## Key Differences from Your Original Script

| Aspect | Your Script | This Plan |
|--------|-------------|-----------|
| **Share Link Handling** | ❌ Broken (can't convert URLs to rclone paths) | ✅ Uses Dropbox API |
| **File Transfer** | rclone only (requires manual path mapping) | Dropbox API download → rclone upload |
| **Subfolders** | Would miss files in subfolders | ✅ Recursive scanning via API |
| **Test Mode** | ❌ None | ✅ Products 3, 4, 5 only |
| **Output Format** | `galleryUrls` | `galleryContent` (matching your requirement) |

---

## Why This Hybrid Approach?

1. **Dropbox API for Share Links** - Only way to access content from share URLs
2. **rclone for Upload** - Handles large files (600MB) efficiently with:
   - Automatic chunking
   - Retry on failure
   - Parallel transfers
   - Progress reporting
3. **Local Temp Buffer** - Decouples download from upload, allows each to be optimized
4. **Combined galleryContent** - All images + videos in one array as requested

---

## Checklist

- [ ] R2 bucket created with public access
- [ ] R2 API credentials generated
- [ ] rclone configured for R2 (`rclone config`)
- [ ] `.env` file configured
- [ ] Dependencies installed (`bun add dropbox`)
- [ ] Script created (`migrate-r2-hybrid.ts`)
- [ ] Test run with products 3, 4, 5
- [ ] Output JSON verified
- [ ] CDN URLs accessible

---

## Disk Space Note

The hybrid approach requires temporary local storage for downloads. For 3 test products with ~50 files each (average 20MB):
- Estimated temp space needed: ~3GB
- Files are cleaned up after each product

For full migration, consider:
- Running in batches
- Using a larger temp directory
- Processing overnight
