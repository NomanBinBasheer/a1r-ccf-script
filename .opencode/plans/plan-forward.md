# AllIn1Rentals Boats Migration - Execution Plan (Updated)

**Date Created:** January 21, 2026  
**Last Updated:** January 21, 2026 (After ID 29 correction)  
**Project:** Media Migration from Dropbox to Cloudflare R2  
**Status:** 68/92 boats migrated (73.9% complete)  
**Remaining:** 24 boats (18 Dropbox + 6 Google Drive)

---

## Executive Summary

### Current Status
- **Total Boats in CSV:** 92 (IDs 1-93, all present now)
- **Successfully Migrated:** 68 boats
- **Remaining:** 24 boats
  - **18 boats** with Dropbox links (Focus for this phase)
  - **6 boats** with Google Drive links (Deferred to later phase)
- **Success Rate:** 73.9%

### Scope of This Plan
This plan focuses **ONLY on the 18 boats with Dropbox links**. Google Drive boats (IDs: 53, 59, 73, 74, 76, 78) will be handled separately after this phase completes.

---

## Missing Boats - Dropbox Only (18 boats)

| ID | Product Name | Size | Price | Location | Issue | Has Video | Has Image |
|----|-------------|------|-------|----------|-------|-----------|-----------|
| 6 | 36FT REGAL | 36FT | $415 | Miami Florida | OOM Error | ✅ | ✅ |
| 12 | 45FT AZIMUT | 45FT | $1,050 | Miami Florida | Large (1.4GB) | ✅ | ✅ |
| 17 | 50FT MANHATTAN | 50FT | $843 | Miami Florida | Not processed | ✅ | ✅ |
| 21 | 68FT AZIMUT | 68FT | $1,850 | Miami Florida | Large (2.9GB) | ✅ | ✅ |
| 24 | 50FT FAIRLINE FORT LAUDERDALE | 50FT | $1,100 | Fort Lauderdale | Not processed | ✅ | ✅ |
| 28 | 80FT AZIMUT | 80FT | $4,524 | Cancún, Mexico | Invalid ZIP | ❌ | ✅ |
| 29 | 36FT JOHNNY ENGLISH | 36FT | $1,250 | Nassau, Bahamas | Not processed | ❌ | ✅ |
| 30 | 51ft Leopard | 51FT | $2,609 | Cancún, Mexico | Invalid ZIP | ❌ | ✅ |
| 31 | 55 VAN DUTCH | 55FT | $1,850 | Miami, Florida | Not processed | ❌ | ✅ |
| 36 | 45FT MARQUIS | 45FT | $1,350 | Miami Florida | Not processed | ❌ | ✅ |
| 37 | Saxdor 270 | 28FT | $650 | Miami Florida | Timeout | ❌ | ✅ |
| 46 | 57Ft Fairline | 57FT | $1,625 | Miami Florida | Not processed | ❌ | ✅ |
| 48 | 55FT CRUISER | 55FT | $815 | Miami Florida | Not processed | ❌ | ✅ |
| 57 | 80FT PRINCESS | 80FT | $3,500 | Miami Florida | Not processed | ❌ | ❌ |
| 63 | 64FT AZIMUT FLYBRIDGE | 64FT | $2,600 | Miami Florida | Large (1.8GB) | ❌ | ❌ |
| 64 | 24FT NAUTIC STAR | 24FT | $550 | Miami Florida | Not processed | ❌ | ❌ |
| 71 | 42FT CRANCHI | 42FT | $1,200 | Miami Florida | Not processed | ❌ | ❌ |
| 93 | 45' Sea Ray | 45FT | $1,000 | Miami Florida | Not processed | ❌ | ✅ |

---

## Issue Categorization

### Category A: Large Files Requiring Streaming (4 boats)
**IDs:** 6, 12, 21, 63

**Issue:** Files exceed memory limits, causing OOM errors. Need streaming download approach.

**Strategy:**
- Implement streaming download using Dropbox SDK
- Process files one-by-one without loading entire ZIP into memory
- Apply aggressive video compression for files >500MB

### Category B: Invalid ZIP Files (2 boats)
**IDs:** 28, 30

**Issue:** Dropbox ZIP download returns invalid/corrupted archive.

**Strategy:**
- Use Dropbox API to list folder contents directly
- Download files individually instead of ZIP
- May need client to reshare links if broken

### Category C: Download Timeout (1 boat)
**ID:** 37

**Issue:** Network timeout during download.

**Strategy:**
- Increase timeout from 5 minutes to 15 minutes
- Add retry logic with exponential backoff

### Category D: Not Yet Processed (11 boats)
**IDs:** 17, 24, 29, 31, 36, 46, 48, 57, 64, 71, 93

**Issue:** Never attempted or skipped in previous runs.

**Strategy:**
- Run standard migration script
- These should work with existing approach

### Category E: Missing Title Media (5 boats)
**IDs:** 57, 63, 64, 71 (+ 4 Google Drive boats deferred)

**Decision:** Leave `titleImage` and `titleVideo` as empty strings if not provided in CSV.

---

## Technical Implementation

### Phase 1: Create Streaming Download Function

Create new file `lib/streaming-download.ts`:

```typescript
import { Dropbox } from 'dropbox';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

interface DropboxFile {
  name: string;
  path_lower: string;
  size: number;
}

/**
 * Download Dropbox folder files using streaming approach
 * Avoids loading entire ZIP into memory
 */
export async function streamingDropboxDownload(
  dropboxLink: string,
  outputDir: string
): Promise<string[]> {
  console.log(`📥 Starting streaming download from Dropbox...`);
  
  // Extract shared link ID
  const sharedLinkId = extractSharedLinkId(dropboxLink);
  
  // Initialize Dropbox client (no auth needed for public links)
  const dbx = new Dropbox({ 
    accessToken: process.env.DROPBOX_ACCESS_TOKEN,
    fetch: fetch 
  });
  
  try {
    // List all files in shared folder
    console.log(`📂 Listing files in folder...`);
    const response = await dbx.filesListFolder({
      path: sharedLinkId,
      recursive: true
    });
    
    const files: DropboxFile[] = response.result.entries
      .filter((entry: any) => entry['.tag'] === 'file')
      .map((entry: any) => ({
        name: entry.name,
        path_lower: entry.path_lower,
        size: entry.size
      }));
    
    console.log(`✅ Found ${files.length} files`);
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Download files one by one
    const downloadedFiles: string[] = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const progress = `[${i + 1}/${files.length}]`;
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      
      console.log(`${progress} Downloading: ${file.name} (${sizeMB}MB)`);
      
      try {
        // Download file
        const downloadResponse = await dbx.filesDownload({ path: file.path_lower });
        const fileBuffer = (downloadResponse.result as any).fileBinary;
        
        // Save to disk
        const outputPath = path.join(outputDir, file.name);
        fs.writeFileSync(outputPath, fileBuffer);
        
        downloadedFiles.push(outputPath);
        console.log(`   ✅ Saved: ${outputPath}`);
        
        // Clear memory
        if (global.gc) {
          global.gc();
        }
        
      } catch (downloadError) {
        console.error(`   ❌ Failed to download ${file.name}:`, downloadError);
        // Continue with next file
      }
    }
    
    console.log(`\n✅ Downloaded ${downloadedFiles.length}/${files.length} files successfully`);
    return downloadedFiles;
    
  } catch (error) {
    console.error('❌ Streaming download failed:', error);
    throw error;
  }
}

/**
 * Extract shared link ID from Dropbox URL
 */
function extractSharedLinkId(dropboxLink: string): string {
  // Parse Dropbox shared link to extract folder ID
  // Example: https://www.dropbox.com/scl/fo/{ID}/...?rlkey=...&dl=0
  const match = dropboxLink.match(/\/fo\/([^\/]+)/);
  if (!match) {
    throw new Error('Invalid Dropbox link format');
  }
  return match[1];
}
```

### Phase 2: Update Migration Script

Modify `migrate-boats.ts` to add streaming download option:

```typescript
// Add at top
import { streamingDropboxDownload } from './lib/streaming-download';

// In processBoat function, detect large files
async function processBoat(boat: BoatData, index: number) {
  const dropboxLink = boat.dropboxLink;
  
  // Check if we should use streaming (for large files)
  const useStreaming = shouldUseStreaming(boat.id);
  
  let mediaFiles: string[];
  
  if (useStreaming) {
    console.log(`🚀 Using streaming download for boat ID ${boat.id}`);
    const tempDir = path.join(process.cwd(), 'temp', `boat_${boat.id}`);
    mediaFiles = await streamingDropboxDownload(dropboxLink, tempDir);
  } else {
    // Existing ZIP download approach
    console.log(`📦 Using ZIP download for boat ID ${boat.id}`);
    mediaFiles = await downloadAndExtractZip(dropboxLink);
  }
  
  // Continue with existing processing...
  const processedFiles = await processMediaFiles(mediaFiles);
  const uploadedUrls = await uploadToR2(processedFiles, boat.id);
  
  // Rest of existing code...
}

function shouldUseStreaming(boatId: string): boolean {
  // IDs that need streaming: 6, 12, 21, 63
  const largeFileBoats = ['6', '12', '21', '63'];
  return largeFileBoats.includes(boatId);
}
```

### Phase 3: Handle Missing Title Media

Update the boat object creation to handle empty title media:

```typescript
const boatObject = {
  id: boat.id,
  name: boat.name,
  slug: boat.slug,
  // ... other fields ...
  titleImage: titleImageUrl || "", // Empty string if not found
  titleVideo: titleVideoUrl || "", // Empty string if not found
  galleryContent: [
    ...videoUrls,  // Videos first
    ...imageUrls   // Then images
  ],
  category: "boats"
};
```

### Phase 4: Enhanced Error Handling

```typescript
async function processBoatWithRetry(boat: BoatData, index: number) {
  const maxRetries = 3;
  const baseTimeout = 5 * 60 * 1000; // 5 minutes
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Increase timeout for each retry
      const timeout = baseTimeout * attempt;
      
      console.log(`\n🔄 Attempt ${attempt}/${maxRetries} for boat ID ${boat.id}`);
      
      await processBoat(boat, index, { timeout });
      
      console.log(`✅ Boat ID ${boat.id} processed successfully`);
      return; // Success!
      
    } catch (error: any) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        // Log final failure
        logMigrationError({
          boatId: boat.id,
          boatName: boat.name,
          errorType: categorizeError(error),
          message: error.message,
          attempts: maxRetries
        });
        throw error;
      }
      
      // Wait before retry (exponential backoff)
      const waitTime = 2000 * Math.pow(2, attempt - 1);
      console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
      await sleep(waitTime);
    }
  }
}

function categorizeError(error: any): string {
  const message = error.message?.toLowerCase() || '';
  
  if (message.includes('out of memory') || message.includes('oom')) {
    return 'OUT_OF_MEMORY';
  }
  if (message.includes('timeout')) {
    return 'DOWNLOAD_TIMEOUT';
  }
  if (message.includes('invalid') && message.includes('zip')) {
    return 'INVALID_ZIP';
  }
  if (message.includes('network')) {
    return 'NETWORK_ERROR';
  }
  return 'PROCESSING_ERROR';
}
```

---

## Execution Strategy

### Step 1: Process Easy Boats First (11 boats)
**IDs:** 17, 24, 29, 31, 36, 46, 48, 57, 64, 71, 93

Run standard migration:
```bash
bun run migrate-boats.ts 17 17
bun run migrate-boats.ts 24 24
bun run migrate-boats.ts 29 29
bun run migrate-boats.ts 31 31
bun run migrate-boats.ts 36 36
bun run migrate-boats.ts 46 46
bun run migrate-boats.ts 48 48
bun run migrate-boats.ts 57 57
bun run migrate-boats.ts 64 64
bun run migrate-boats.ts 71 71
bun run migrate-boats.ts 93 93
```

**OR** run in batch:
```bash
for id in 17 24 29 31 36 46 48 57 64 71 93; do
  echo "Processing boat ID $id..."
  bun run migrate-boats.ts $id $id
  sleep 5
done
```

**Expected Outcome:** 11 boats successfully migrated  
**Estimated Time:** 2-3 hours (15-20 min per boat)

### Step 2: Fix Invalid ZIP Boats (2 boats)
**IDs:** 28, 30

1. Test Dropbox links manually in browser
2. If broken, contact client for new links
3. If working, implement direct file download (not ZIP)
4. Run migration with streaming approach

```bash
# After implementing fix
bun run migrate-boats.ts 28 28
bun run migrate-boats.ts 30 30
```

**Expected Outcome:** 2 boats migrated (or marked for client follow-up)  
**Estimated Time:** 30 min - 1 hour

### Step 3: Fix Download Timeout Boat (1 boat)
**ID:** 37

1. Implement increased timeout (15 min)
2. Add retry logic
3. Run migration

```bash
bun run migrate-boats.ts 37 37
```

**Expected Outcome:** 1 boat successfully migrated  
**Estimated Time:** 20-30 minutes

### Step 4: Process Large Files with Streaming (4 boats)
**IDs:** 6, 12, 21, 63

1. Implement streaming download function
2. Test with ID 12 first (smallest of the large ones - 1.4GB)
3. If successful, process remaining 3

```bash
# Test with smallest large file
bun run migrate-boats.ts 12 12

# If successful, continue
bun run migrate-boats.ts 6 6
bun run migrate-boats.ts 21 21
bun run migrate-boats.ts 63 63
```

**Expected Outcome:** 4 boats successfully migrated  
**Estimated Time:** 3-4 hours (can be slow due to file sizes)

---

## Manual Migration Command Reference

To run migrations yourself from terminal:

### Single Boat Migration
```bash
bun run migrate-boats.ts <START_ID> <END_ID>
```

**Examples:**
```bash
# Migrate boat ID 17
bun run migrate-boats.ts 17 17

# Migrate boats 17 through 20
bun run migrate-boats.ts 17 20
```

### Batch Migration (Multiple Boats)
```bash
# Process all remaining easy boats
for id in 17 24 29 31 36 46 48 57 64 71 93; do
  echo "=== Processing Boat ID $id ==="
  bun run migrate-boats.ts $id $id
  
  # Wait 5 seconds between boats
  sleep 5
done
```

### Check Results
```bash
# Count migrated boats
cat boats-new.json | jq 'length'

# List all migrated IDs
cat boats-new.json | jq -r '.[].id' | sort -n

# Find specific boat by ID
cat boats-new.json | jq '.[] | select(.id == "17")'

# Count images and videos for a boat
cat boats-new.json | jq '.[] | select(.id == "17") | {
  id: .id,
  name: .name,
  images: (.galleryContent | map(select(test("\\.(jpg|jpeg|png|gif)$";"i"))) | length),
  videos: (.galleryContent | map(select(test("\\.(mp4|mov)$";"i"))) | length),
  total: (.galleryContent | length)
}'
```

### Backup Before Running
```bash
# Always backup before migration!
cp boats-new.json backups/boats-new-$(date +%Y%m%d-%H%M%S).json

# Create backups directory if doesn't exist
mkdir -p backups
```

### Check for Errors
```bash
# Watch logs in real-time
bun run migrate-boats.ts 17 17 2>&1 | tee logs/migration-boat-17.log

# Search for errors in logs
grep -i "error\|failed\|exception" logs/*.log
```

### Verify Migration Success
```bash
# Compare CSV count vs JSON count
echo "CSV boats: $(tail -n +2 boats.csv | wc -l)"
echo "Migrated boats: $(cat boats-new.json | jq 'length')"
echo "Missing: $(( $(tail -n +2 boats.csv | wc -l) - $(cat boats-new.json | jq 'length') ))"
```

---

## Pre-Execution Checklist

Before starting migration, verify:

- [ ] `backups/` directory exists
- [ ] Current `boats-new.json` is backed up
- [ ] `.env` file contains valid R2 credentials
- [ ] R2 bucket is accessible
- [ ] Sufficient disk space (at least 10GB free)
- [ ] Node.js memory limit increased if needed: `export NODE_OPTIONS="--max-old-space-size=4096"`
- [ ] `bun` runtime is installed and working
- [ ] `migrate-boats.ts` script exists and runs

**Verification Commands:**
```bash
# Create backup directory
mkdir -p backups logs

# Backup current state
cp boats-new.json backups/boats-new-pre-migration-$(date +%Y%m%d-%H%M%S).json

# Check R2 credentials
bun run -e "console.log(process.env.R2_ACCOUNT_ID ? '✅ R2 credentials loaded' : '❌ Missing .env')"

# Check disk space
df -h . | tail -1 | awk '{print "Free space: " $4}'

# Test script runs
bun run migrate-boats.ts --help 2>/dev/null || echo "⚠️  Script check needed"
```

---

## Success Criteria

Phase 1 (Dropbox boats) is considered **COMPLETE** when:

1. ✅ All 18 Dropbox boats are processed
2. ✅ `boats-new.json` contains 86 boats (68 + 18)
3. ✅ For each new boat:
   - All images uploaded to R2
   - All videos converted to MP4 and uploaded
   - `galleryContent` array has videos first, then images
   - `basePrice` is a NUMBER
   - `titleImage` set if available (empty string if not)
   - `titleVideo` set if available (empty string if not)
4. ✅ No data loss from Dropbox folders
5. ✅ All R2 URLs are accessible

---

## Post-Migration Steps

After completing Dropbox boats:

1. **Verify Results**
   ```bash
   # Run verification script (to be created)
   bun run verify-migration.ts
   ```

2. **Generate Report**
   - Total boats migrated: 86/92
   - Total images uploaded
   - Total videos converted
   - List any failures

3. **Phase 2 Planning**
   - Address 6 Google Drive boats separately
   - Design Google Drive migration approach
   - OR provide manual download instructions

---

## Risk Mitigation

### Data Loss Prevention
- ✅ Backup `boats-new.json` before each migration
- ✅ Save progress after EACH boat (not batch)
- ✅ Keep last 10 backups
- ✅ Validate boat data before adding to JSON

### Memory Management
- ✅ Use streaming for large files
- ✅ Clear memory between boats with `global.gc()`
- ✅ Process files in small batches
- ✅ Delete temp files after upload

### Network Resilience
- ✅ Retry failed downloads (3 attempts)
- ✅ Exponential backoff between retries
- ✅ Increased timeout for large files
- ✅ Resume capability if script crashes

---

## Troubleshooting Guide

### Issue: Out of Memory Error
```bash
# Increase Node.js memory
export NODE_OPTIONS="--max-old-space-size=8192"
bun run migrate-boats.ts <ID> <ID>
```

### Issue: Dropbox Link Invalid
1. Test link in browser
2. Check if link requires authentication
3. Contact client for new link
4. Log boat ID for manual follow-up

### Issue: Video Conversion Fails
```bash
# Check ffmpeg is installed
which ffmpeg

# Check ffmpeg version
ffmpeg -version

# Install if missing
sudo apt-get install ffmpeg
```

### Issue: R2 Upload Fails
```bash
# Verify R2 credentials
cat .env | grep R2_

# Test R2 connection
curl https://${R2_PUBLIC_URL}/test.txt
```

### Issue: Script Crashes Mid-Migration
```bash
# boats-new.json auto-saves after each boat
# Simply re-run from next ID
# Example: if crashed at ID 24, start from 24
bun run migrate-boats.ts 24 24
```

---

## Timeline Estimate

| Phase | Boats | Estimated Time |
|-------|-------|----------------|
| Step 1: Easy boats | 11 | 2-3 hours |
| Step 2: Invalid ZIP | 2 | 30 min - 1 hour |
| Step 3: Timeout fix | 1 | 20-30 minutes |
| Step 4: Large files | 4 | 3-4 hours |
| **TOTAL** | **18** | **6-9 hours** |

**Note:** Times include processing, uploading, and troubleshooting. Can be run in multiple sessions.

---

## Next Actions (Priority Order)

1. ✅ Create backups directory and backup current state
2. ✅ Verify environment setup (R2 credentials, disk space)
3. ✅ Start with Step 1: Process 11 easy boats
4. ✅ Monitor first few boats closely
5. ✅ Address any failures immediately
6. ✅ Continue with remaining steps sequentially

---

**End of Plan - Ready for Execution**

Last Updated: January 21, 2026  
Plan Status: ✅ READY TO EXECUTE  
Focus: 18 Dropbox boats (IDs: 6, 12, 17, 21, 24, 28, 29, 30, 31, 36, 37, 46, 48, 57, 63, 64, 71, 93)
