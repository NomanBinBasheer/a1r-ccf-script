# Google Drive Boats Migration Plan

**Created:** January 20, 2026  
**Project:** AllIn1Rentals Media Migration  
**Objective:** Migrate 6 boats with Google Drive links to Cloudflare R2

---

## Summary

| Metric | Value |
|--------|-------|
| Current migrated boats | 82 |
| Boat 37 (in progress) | +1 |
| Google Drive boats | 6 |
| **Target after completion** | **89/92 (96.7%)** |
| Remaining problem boats | 3 (28, 30, 48) |

**Note:** Boat 39 does not exist in the source CSV (IDs skip from 38 to 40).

---

## Google Drive Boats to Migrate

| # | ID | Index | Boat Name | Google Drive Link |
|---|-----|-------|-----------|-------------------|
| 1 | 53 | 51 | 52' Beneteau Flybridge Venetian | [Link](https://drive.google.com/drive/folders/1zAScbzWszWbsJEJWq0iFi72azoQhdd3t) |
| 2 | 59 | 57 | 52FT "ARROW" FORMULA | [Link](https://drive.google.com/drive/mobile/folders/1InXVYI5q3y51BsGjH6hMEK9CGhCZMNcV) |
| 3 | 73 | 71 | 105FT AQUA with Jacuzzi | [Link](https://drive.google.com/drive/folders/1xEvHORD_PfJxUzQkr4oMu8KWlBztCFIs) |
| 4 | 74 | 72 | 65FT AZIMUT NEW | [Link](https://drive.google.com/drive/folders/1Qvmr_UW1u0lfBELkDlClBYor0BNUu4Kk) |
| 5 | 76 | 74 | 40ft Sea Ray Sedan Bridge (NEW) | [Link](https://drive.google.com/drive/folders/1GzrmmjCEYlrrtGUwLdnhcy6MtBEHhWi9) |
| 6 | 78 | 76 | 27FT FOUR WINNS | [Link](https://drive.google.com/drive/folders/1_n1YpNw3E2RtFqWJ5aLffKi1pSv1N_Fn) |

---

## Technical Implementation

### How Google Drive Download Works

The `lib/gdrive-download.ts` module handles Google Drive folders:

1. **Primary Method (gdown):** Uses Python `gdown` package to download entire folder
   - Status: NOT AVAILABLE (gdown not installed, requires sudo)

2. **Fallback Method (HTML Scraping):**
   - Fetches the embedded folder view HTML
   - Parses file IDs and names from JavaScript data
   - Downloads each file individually via direct download URLs
   - Handles virus scan warnings for large files

### Download Flow

```
Google Drive URL
       |
       v
Extract Folder ID (regex patterns)
       |
       v
Try gdown (if available) --> Success --> Get media files
       |
       v (fallback)
List files via embedded HTML view
       |
       v
Download each file individually
       |
       v
Process videos (ffmpeg compression)
       |
       v
Process images (ImageMagick compression)
       |
       v
Upload to R2 + CDN
```

### Key Code References

- **Main migration:** `migrate-boats.ts:307` - `migrateMediaFolder()` function
- **Google Drive check:** `migrate-boats.ts:300` - `isGoogleDriveLink()` function
- **GDrive module:** `lib/gdrive-download.ts` - full download implementation
- **Import:** `migrate-boats.ts:37-38` - imports gdriveDownloadFolder

---

## Execution Plan

### Phase 1: Test Single Boat (ID: 78 - smallest boat)
**Command:** `bun run migrate-boats.ts 76 77`

- Start with smallest boat (27FT FOUR WINNS) to verify Google Drive download works
- Expected: Quick test, likely fewer files
- Validates: HTML parsing, file download, upload pipeline

### Phase 2: Process Remaining 5 Boats (Sequential)
After Phase 1 succeeds, process remaining boats:

```bash
# Boat 53 (52' Beneteau)
bun run migrate-boats.ts 51 52

# Boat 59 (52FT ARROW FORMULA)
bun run migrate-boats.ts 57 58

# Boat 73 (105FT AQUA) - Likely largest, may have many files
bun run migrate-boats.ts 71 72

# Boat 74 (65FT AZIMUT)
bun run migrate-boats.ts 72 73

# Boat 76 (40ft Sea Ray)
bun run migrate-boats.ts 74 75
```

### Alternative: Batch Processing
If Phase 1 succeeds without issues:

```bash
# Process all remaining Google Drive boats
# Note: These indices are non-contiguous, so run separately or use loop

for idx in 51 57 71 72 74; do
  echo "Processing index $idx..."
  bun run migrate-boats.ts $idx $((idx+1))
done
```

---

## Potential Issues & Mitigations

### Issue 1: Folder Not Public
**Symptom:** "No media files found in Google Drive folder"  
**Mitigation:** Client needs to ensure folders are shared with "Anyone with the link"

### Issue 2: Large Files (Virus Scan Warning)
**Symptom:** Download fails with "Cannot bypass virus scan warning"  
**Mitigation:** Code already handles this with confirm parameter and cookies

### Issue 3: HTML Parsing Fails
**Symptom:** Zero files found even though folder has content  
**Mitigation:** Google may have changed their HTML structure. May need to update regex patterns in `listFolderFiles()`

### Issue 4: Rate Limiting
**Symptom:** Downloads fail after several files  
**Mitigation:** Built-in retry logic with exponential backoff (3 retries, 3-9 second delays)

---

## Verification Checklist

After each boat migration:

- [ ] Check `boats-new.json` count increased
- [ ] Verify boat ID is in output: `cat boats-new.json | jq '.[] | select(.id == "XX")'`
- [ ] Confirm galleryContent has entries
- [ ] Videos appear first in galleryContent array
- [ ] titleImage and titleVideo are set (or empty string if none)
- [ ] basePrice is a number, not string

---

## Post-Migration Status

### Expected Final Count
| Status | Count | IDs |
|--------|-------|-----|
| Migrated | 89 | All except below |
| Broken Links | 2 | 28, 30 |
| Invalid ZIP | 1 | 48 |
| **Total in CSV** | **92** | |

### Boats Requiring Client Action
1. **Boat 28:** Dropbox link is broken/expired
2. **Boat 30:** Dropbox link is broken/expired
3. **Boat 48 (55FT CRUISER):** ZIP file is invalid/corrupted

---

## Commands Reference

```bash
# Check current progress
cat boats-new.json | jq 'length'

# Check if boat 37 is still processing
ps aux | grep -E "bun.*migrate" | grep -v grep

# Verify specific boat migrated
cat boats-new.json | jq '.[] | select(.id == "53") | {id, name, galleryCount: (.galleryContent | length)}'

# Clean temp downloads
rm -rf .temp-downloads/gdrive-*

# View migration logs (if running in background)
tail -f /path/to/log

# Backup before running
cp boats-new.json boats-new.json.backup-$(date +%Y%m%d-%H%M%S)
```

---

## Timeline Estimate

| Phase | Duration | Notes |
|-------|----------|-------|
| Test boat 78 | 5-15 min | Depends on file count |
| Boats 53, 59 | 10-30 min each | Medium-sized boats |
| Boat 73 (105FT) | 30-60 min | Largest, likely most media |
| Boats 74, 76 | 10-30 min each | Standard size |
| **Total** | **1.5-3 hours** | Sequential processing |

---

## Execution Log

### Phase 1: Test Boat 78
- [x] Started at: Jan 20, 2026 2:56 PM PKT
- [x] Command: `bun run migrate-boats.ts 76 77`
- [x] Files found: 14 images
- [x] Completed at: Jan 20, 2026 2:57 PM PKT
- [x] Result: SUCCESS
- [x] Notes: Fixed HTML parsing to match Google Drive embed format

### Phase 2: Remaining Boats
| Boat ID | Started | Files | Completed | Result |
|---------|---------|-------|-----------|--------|
| 53 | 2:59 PM | 25 (1 video blocked) | 3:03 PM | SUCCESS |
| 59 | 3:04 PM | 14 HEIF files | 3:05 PM | SUCCESS |
| 73 | 3:06 PM | 24 images | 3:07 PM | SUCCESS |
| 74 | 4:48 PM | 32 (3 videos blocked) | 4:53 PM | SUCCESS |
| 76 | 4:53 PM | 19 files | 4:55 PM | SUCCESS |

---

## Final Results

**ALL 6 GOOGLE DRIVE BOATS SUCCESSFULLY MIGRATED!**

### Summary
| Metric | Value |
|--------|-------|
| Total boats in CSV | 92 |
| Successfully migrated | 89 |
| Success rate | **96.7%** |
| Total videos | 156 |
| Total images | 3,156 |

### Remaining Failed Boats (3)
| ID | Name | Issue | Action Required |
|----|------|-------|-----------------|
| 28 | (Unknown) | Broken Dropbox link | Client needs to provide new link |
| 30 | (Unknown) | Broken Dropbox link | Client needs to provide new link |
| 48 | 55FT CRUISER | Invalid/corrupted ZIP | Client needs to re-share folder |

**Note:** ID 39 does not exist in the source CSV (IDs skip from 38 to 40).

### Technical Fixes Made During Migration
1. **Fixed function call:** `migrateDropboxFolder` → `migrateMediaFolder`
2. **Updated HTML parsing:** Google Drive embed format changed, updated regex patterns
3. **Added HEIF support:** Handle emoji filenames with MIME type detection
4. **Virus scan bypass:** Some large videos (>100MB) couldn't bypass Google's virus scan warning
| 59 | | | | |
| 73 | | | | |
| 74 | | | | |
| 76 | | | | |

---

*Plan created by Claude. Execute with: Start Phase 1 test.*
