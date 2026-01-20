# Dropbox Streaming Download - Implementation Plan

**Date:** January 21, 2026  
**Project:** AllIn1Rentals Boats Migration  
**Goal:** Implement streaming download for Dropbox shared folders to handle large files and invalid ZIPs

---

## Executive Summary

Based on comprehensive research of Dropbox API capabilities and real-world implementations, this plan outlines a **Mixed Approach** that combines:
1. Standard ZIP download (existing approach) for small folders
2. HTML scraping + individual file streaming for failures and large folders

**Key Insight:** Dropbox's public shared link API has limited capabilities without authentication, but we can work around this by parsing the shared folder preview page.

---

## Research Findings

### Dropbox API Endpoints Available (No Auth Required)

1. **`POST /2/sharing/get_shared_link_metadata`**
   - Get folder/file metadata from shared link
   - Returns: name, size, type, permissions
   - **Limitation:** Does NOT list files inside folder

2. **`POST /2/sharing/get_shared_link_file`**
   - Download individual file from shared link
   - Requires knowing the file path within folder
   - Works with: `{url: "shared_link", path: "/subfolder/file.jpg"}`

### Critical Limitation

**`filesListFolder` requires authentication token** - We cannot list folder contents from public shared links without auth.

**Workaround:** Parse Dropbox's HTML preview page to extract file list.

---

## Architecture: Smart Detection with Fallback

```
                                      ┌─────────────────────┐
                                      │  Migration Script   │
                                      │  (migrate-boats.ts) │
                                      └──────────┬──────────┘
                                                 │
                                                 │
                                      ┌──────────▼──────────┐
                                      │  Should use         │
                                      │  streaming?         │
                                      └──────────┬──────────┘
                                                 │
                         ┌───────────────────────┴───────────────────────┐
                         │                                               │
                         │ IF:                                           │ IF:
                         │ - Boat ID in LARGE_FILE_BOATS                │ - Normal boat
                         │ - OR Previous ZIP failure                     │ - No history of issues
                         │                                               │
                ┌────────▼──────────┐                           ┌───────▼────────┐
                │   Use Streaming   │                           │   Use ZIP      │
                │                   │                           │   Download     │
                └────────┬──────────┘                           └───────┬────────┘
                         │                                               │
                         │                                               │
          ┌──────────────▼──────────────┐                               │
          │  lib/streaming-download.ts  │                               │
          │                              │                        ┌──────▼───────┐
          │  1. Parse HTML to get files │                        │ Success? ✓   │
          │  2. Download one-by-one     │                        └──────┬───────┘
          │  3. Return local paths      │                               │
          └──────────────┬───────────────┘                              │
                         │                                        ┌──────▼───────┐
                         │                                        │   Failure?   │
                         │                                        │   Fallback   │
                         │                                        │ to Streaming │
                         └────────────────────┬───────────────────┴──────────────┘
                                              │
                                              │
                                   ┌──────────▼──────────┐
                                   │  Process Files      │
                                   │  - Convert videos   │
                                   │  - Compress images  │
                                   │  - Upload to R2     │
                                   └─────────────────────┘
```

---

## Implementation Components

### 1. `lib/dropbox-scraper.ts` - HTML Parser (NEW)

**Purpose:** Extract file list from Dropbox shared folder preview page

**Functions:**

```typescript
interface DropboxFile {
  name: string;
  path: string; // Relative path within folder
  size: number;
  isImage: boolean;
  isVideo: boolean;
}

interface FolderInfo {
  files: DropboxFile[];
  totalSize: number;
  folderName: string;
}

/**
 * Parse Dropbox shared folder HTML to extract file list
 */
export async function parseSharedFolderPage(shareUrl: string): Promise<FolderInfo>

/**
 * Construct individual file download URL
 */
export function getFileDownloadUrl(shareUrl: string, filePath: string): string
```

**Implementation Details:**
- Fetch folder preview page with browser-like headers
- Parse HTML to find embedded JSON with file list
- Dropbox embeds file data in `<script>` tags or data attributes
- Extract: `window.__REDUX_STATE__` or similar JavaScript variable
- Filter out non-media files (system files, ._* files)

---

### 2. `lib/streaming-download.ts` - Streaming Downloader (NEW)

**Purpose:** Download files individually with memory management

**Functions:**

```typescript
interface StreamingOptions {
  outputDir: string;
  onProgress?: (file: string, current: number, total: number) => void;
  maxRetries?: number;
  chunkSizeMB?: number;
}

/**
 * Download all files from Dropbox shared folder using streaming approach
 */
export async function streamingDropboxDownload(
  shareUrl: string,
  options: StreamingOptions
): Promise<string[]>

/**
 * Download single file with retry logic
 */
async function downloadSingleFile(
  shareUrl: string,
  filePath: string,
  outputPath: string,
  retries: number
): Promise<void>
```

**Implementation Steps:**
1. Call `parseSharedFolderPage` to get file list
2. Create output directory
3. For each file:
   - Construct download URL using `get_shared_link_file` endpoint
   - Stream download in chunks (avoid loading entire file into memory)
   - Save to disk immediately
   - Clear memory
   - Add progress logging
4. Handle retries with exponential backoff
5. Return array of local file paths

---

### 3. Update `migrate-boats.ts` - Smart Detection (MODIFY)

**Changes:**

#### Add Configuration
```typescript
const LARGE_FILE_BOATS = ['6', '12', '21', '63']; // Known large file boats
const INVALID_ZIP_BOATS = ['28', '30'];          // Known invalid ZIP boats
const USE_STREAMING_OVER_MB = 500;               // Threshold for streaming

interface BoatMigrationContext {
  useStreaming: boolean;
  reason: string; // For logging
}
```

#### Add Detection Function
```typescript
function shouldUseStreaming(boatId: string, previousAttemptFailed: boolean): BoatMigrationContext {
  // Hardcoded large file boats
  if (LARGE_FILE_BOATS.includes(boatId)) {
    return { useStreaming: true, reason: 'Known large file boat' };
  }
  
  // Known invalid ZIP boats
  if (INVALID_ZIP_BOATS.includes(boatId)) {
    return { useStreaming: true, reason: 'Known invalid ZIP' };
  }
  
  // Previous ZIP attempt failed
  if (previousAttemptFailed) {
    return { useStreaming: true, reason: 'ZIP download failed, fallback to streaming' };
  }
  
  // Default: use ZIP
  return { useStreaming: false, reason: 'Standard ZIP download' };
}
```

#### Modify Migration Flow
```typescript
async function migrateDropboxFolder(
  dropboxUrl: string,
  productName: string,
  boatId: string
): Promise<MigrationResult | null> {
  
  let files: ExtractedFile[];
  let zipFailed = false;
  
  // Determine approach
  const context = shouldUseStreaming(boatId, false);
  
  if (!context.useStreaming) {
    // Try ZIP first
    try {
      console.log(`   Using ZIP download (${context.reason})`);
      const zipBuffer = await downloadFolderAsZip(dropboxUrl);
      files = extractZip(zipBuffer);
    } catch (error: any) {
      console.log(`   ZIP download failed: ${error.message}`);
      console.log(`   Falling back to streaming download...`);
      zipFailed = true;
    }
  }
  
  // Use streaming if ZIP failed or explicitly requested
  if (context.useStreaming || zipFailed) {
    try {
      console.log(`   Using streaming download (${context.useStreaming ? context.reason : 'ZIP fallback'})`);
      
      const tempDir = join(CONFIG.tempDir, `boat_${boatId}_stream`);
      const filePaths = await streamingDropboxDownload(dropboxUrl, {
        outputDir: tempDir,
        onProgress: (file, current, total) => {
          console.log(`     [${current}/${total}] ${file}`);
        }
      });
      
      // Convert to ExtractedFile format
      files = filePaths.map(filePath => ({
        name: basename(filePath),
        path: filePath,
        data: readFileSync(filePath)
      }));
      
    } catch (error: any) {
      logError("Streaming Download", error, { dropboxUrl, productName });
      return null;
    }
  }
  
  // Continue with existing processing...
  return processFiles(files, productName, boatId);
}
```

---

## File Structure

```
upload-dropbox-imagekit/
├── lib/
│   ├── dropbox-scraper.ts      (NEW) - HTML parsing & file discovery
│   └── streaming-download.ts    (NEW) - Individual file download with streaming
├── migrate-boats.ts             (MODIFY) - Add smart detection logic
├── boats-new.json               (EXISTS) - Output file
└── .opencode/
    └── plans/
        ├── plan-forward.md
        └── streaming-implementation-plan.md (THIS FILE)
```

---

## Implementation Steps

### Phase 1: Core Streaming Infrastructure (2-3 hours)

**Step 1.1: Create `lib/dropbox-scraper.ts`**
- Research Dropbox HTML structure (inspect real shared folder page)
- Implement `parseSharedFolderPage()`
- Implement `getFileDownloadUrl()`
- Add unit tests with example URLs

**Step 1.2: Create `lib/streaming-download.ts`**
- Implement `streamingDropboxDownload()`
- Implement `downloadSingleFile()` with retry logic
- Add chunked streaming to avoid OOM
- Add progress tracking

**Step 1.3: Integration Testing**
- Test with ID 28 (Invalid ZIP boat)
- Verify file list extraction
- Verify individual file downloads
- Verify memory stays reasonable

---

### Phase 2: Smart Detection Integration (1 hour)

**Step 2.1: Update `migrate-boats.ts`**
- Add boat categorization constants
- Implement `shouldUseStreaming()` function
- Modify `migrateDropboxFolder()` with fallback logic
- Add enhanced error logging

**Step 2.2: Test Fallback Mechanism**
- Simulate ZIP failure
- Verify automatic fallback to streaming
- Test with ID 37 (Timeout boat)

---

### Phase 3: Large File Testing (2-3 hours)

**Step 3.1: Test with ID 12 (1.4GB)**
- Run full migration
- Monitor memory usage
- Verify no OOM errors
- Verify all files processed

**Step 3.2: Test with ID 21 or 63 (2.9GB / 1.8GB)**
- Same process as 3.1
- Confirm solution scales to very large folders

---

### Phase 4: Batch Execution (4-6 hours)

**Step 4.1: Process Easy Boats (11 boats)**
```bash
for id in 17 24 29 31 36 46 48 57 64 71 93; do
  bun run migrate-boats.ts $id $id
done
```

**Step 4.2: Process Technical Issue Boats (7 boats)**
```bash
for id in 28 30 37 6 12 21 63; do
  bun run migrate-boats.ts $id $id
done
```

**Step 4.3: Verification**
- Count boats in `boats-new.json` (should be 86)
- Spot-check R2 URLs are accessible
- Verify video/image ordering in galleryContent

---

## Technical Details

### Dropbox HTML Parsing Strategy

**Key Discovery:** Dropbox embeds file data in JavaScript within the HTML

**Likely locations:**
1. `window.__REDUX_STATE__` - Redux store with file list
2. `<script id="__NEXT_DATA__">` - Next.js data
3. Data attributes on DOM elements

**Example Structure:**
```javascript
window.__INITIAL_STATE__ = {
  "fileData": {
    "shared_link": {
      "entries": [
        {
          "filename": "image1.jpg",
          "bytes": 2048576,
          "path": "/image1.jpg",
          "is_dir": false
        }
      ]
    }
  }
}
```

**Parsing Approach:**
```typescript
// Fetch HTML
const response = await fetch(shareUrl, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});
const html = await response.text();

// Find embedded JSON
const scriptMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
if (scriptMatch) {
  const data = JSON.parse(scriptMatch[1]);
  const files = data.fileData.shared_link.entries;
  return files;
}
```

---

### Downloading Individual Files

**Endpoint:** `POST https://content.dropboxapi.com/2/sharing/get_shared_link_file`

**Headers:**
```
Dropbox-API-Arg: {"url": "SHARED_LINK_URL", "path": "/file.jpg"}
```

**Implementation:**
```typescript
async function downloadFile(shareUrl: string, filePath: string): Promise<Buffer> {
  const apiArg = JSON.stringify({
    url: shareUrl,
    path: filePath
  });
  
  const response = await fetch(
    'https://content.dropboxapi.com/2/sharing/get_shared_link_file',
    {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': apiArg,
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}
```

---

### Memory Management Strategy

**Problem:** Large files can cause OOM errors

**Solutions:**

1. **Stream to Disk Immediately**
```typescript
const fileStream = fs.createWriteStream(outputPath);
const response = await fetch(url);
await pipeline(response.body, fileStream);
```

2. **Process One File at a Time**
```typescript
for (const file of files) {
  await downloadAndProcess(file); // Sequential, not parallel
  if (global.gc) global.gc();     // Force garbage collection
}
```

3. **Delete Temp Files After Upload**
```typescript
await uploadToR2(buffer, key, mimeType);
fs.unlinkSync(tempFilePath); // Delete immediately
```

4. **Increase Node Memory (if needed)**
```bash
export NODE_OPTIONS="--max-old-space-size=8192"
```

---

## Error Handling

### Retry Strategy
```typescript
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

async function downloadWithRetry(url: string, retries: number = 0): Promise<Buffer> {
  try {
    return await downloadFile(url);
  } catch (error) {
    if (retries >= MAX_RETRIES) throw error;
    
    const delay = BASE_DELAY_MS * Math.pow(2, retries);
    console.log(`  Retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms...`);
    
    await sleep(delay);
    return downloadWithRetry(url, retries + 1);
  }
}
```

### Categorized Error Logging
```typescript
function categorizeError(error: any): ErrorCategory {
  const msg = error.message?.toLowerCase() || '';
  
  if (msg.includes('out of memory')) return 'OOM';
  if (msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('invalid') && msg.includes('zip')) return 'INVALID_ZIP';
  if (msg.includes('403') || msg.includes('unauthorized')) return 'AUTH_ERROR';
  if (msg.includes('404')) return 'NOT_FOUND';
  
  return 'UNKNOWN';
}
```

---

## Testing Strategy

### Unit Tests
- Test HTML parsing with mock Dropbox pages
- Test file download URL construction
- Test retry logic with simulated failures

### Integration Tests
- **Test Case 1:** Invalid ZIP (ID 28)
  - Verify ZIP fails gracefully
  - Verify fallback to streaming
  - Verify files downloaded correctly
  
- **Test Case 2:** Large File (ID 12)
  - Monitor memory usage (should stay <4GB)
  - Verify no OOM errors
  - Verify all files processed
  
- **Test Case 3:** Normal Boat (ID 17)
  - Verify ZIP download still works
  - Verify no regression in standard flow

### Performance Benchmarks
- ZIP download time vs Streaming download time
- Memory usage: ZIP vs Streaming
- Success rate for each approach

---

## Rollback Plan

If streaming implementation fails:

1. **Immediate Rollback**
   - Restore `migrate-boats.ts` from git
   - Remove `lib/` directory
   - Continue with existing approach

2. **Alternative Approach**
   - Request Dropbox access token from client
   - Implement Solution B (Dropbox SDK)
   - Requires client to create Dropbox App

3. **Manual Processing**
   - Provide client with list of failed boats
   - Client can download folders manually
   - Upload to shared location for processing

---

## Success Criteria

### Phase 1 Success
- ✅ Can parse Dropbox shared folder HTML
- ✅ Can extract file list
- ✅ Can download individual files
- ✅ No OOM errors on test boat

### Phase 2 Success
- ✅ Smart detection works correctly
- ✅ Fallback mechanism triggers properly
- ✅ Both ZIP and streaming paths functional

### Phase 3 Success
- ✅ ID 12 (1.4GB) migrates successfully
- ✅ Memory stays below 4GB
- ✅ All files processed and uploaded

### Phase 4 Success
- ✅ All 18 Dropbox boats migrated
- ✅ `boats-new.json` has 86 boats
- ✅ All R2 URLs accessible
- ✅ No data loss

---

## Timeline

| Phase | Task | Estimated Time |
|-------|------|----------------|
| 1.1 | Implement dropbox-scraper.ts | 1-1.5 hours |
| 1.2 | Implement streaming-download.ts | 1-1.5 hours |
| 1.3 | Integration testing | 30 minutes |
| 2.1 | Update migrate-boats.ts | 30 minutes |
| 2.2 | Test fallback | 30 minutes |
| 3.1 | Test with ID 12 | 1 hour |
| 3.2 | Test with ID 21/63 | 1-2 hours |
| 4.1 | Process easy boats (11) | 2-3 hours |
| 4.2 | Process technical boats (7) | 2-3 hours |
| 4.3 | Verification | 30 minutes |
| **TOTAL** | | **11-15 hours** |

---

## Next Steps

1. **Review this plan with user** - Get approval before implementation
2. **Set up development environment** - Create `lib/` directory, backups
3. **Start Phase 1.1** - Implement Dropbox HTML scraper
4. **Iterative testing** - Test each component before moving to next

---

## Questions for User

Before proceeding with implementation:

1. **Timeline:** Is 11-15 hours of total work time acceptable?
2. **Risk tolerance:** Should we test with one boat before implementing full solution?
3. **Backup strategy:** Should we backup `boats-new.json` before each major phase?
4. **Manual fallback:** If all fails, is client available to manually download folders?

---

**Status:** ✅ READY FOR IMPLEMENTATION (Pending User Approval)

**Last Updated:** January 21, 2026  
**Author:** OpenCode AI Agent  
**Review Status:** Awaiting User Feedback
