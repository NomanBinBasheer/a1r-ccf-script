import "dotenv/config";
import ImageKit from "imagekit";
import { Dropbox } from "dropbox";
import { v2 as cloudinary } from "cloudinary";
import fetch from "node-fetch";
import fs from "fs";
import { getDataFromCSVUrl } from "./sheet.js";

// Validate required environment variables
const requiredEnvVars = [
  "IMAGEKIT_PUBLIC_KEY",
  "IMAGEKIT_PRIVATE_KEY",
  "IMAGEKIT_URL_ENDPOINT",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "DROPBOX_ACCESS_TOKEN",
];

const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error("❌ Missing required environment variables:");
  missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
  console.error("\n💡 Please check your .env file and ensure all variables are set.");
  process.exit(1);
}

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// Configure Cloudinary for video uploads
const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
};

cloudinary.config(cloudinaryConfig);

// Verify configuration
console.log("✅ Cloudinary configured:", {
  cloud_name: cloudinary.config().cloud_name,
  api_key: cloudinary.config().api_key ? "***" + cloudinary.config().api_key.slice(-4) : "MISSING",
  api_secret: cloudinary.config().api_secret ? "SET" : "MISSING",
});

const dropbox = new Dropbox({
  accessToken: process.env.DROPBOX_ACCESS_TOKEN,
  fetch,
});

function sanitizeFileName(name) {
  return (
    name
      .trim() // Remove leading/trailing spaces
      .replace(/\s+/g, "_") // Replace spaces with underscores
      .replace(/[<>:"/\\|?*\(\)']/g, "_") // Replace invalid characters
      // .replace(/_{2,}/g, "_")                     // Replace multiple underscores with single
      .replace(/^_+|_+$/g, "")
  ); // Remove leading/trailing underscores
}

// Error logging utility
const ERROR_LOG_FILE = "error_logs.txt";

function logError(context, error, additionalInfo = {}) {
  const timestamp = new Date().toISOString();
  const errorMessage = error?.message || error?.error_summary || String(error);
  const errorStack = error?.stack || "No stack trace available";
  
  const logEntry = `
================================================================================
[${timestamp}] ERROR in ${context}
--------------------------------------------------------------------------------
Message: ${errorMessage}
Additional Info: ${JSON.stringify(additionalInfo, null, 2)}
Stack: ${errorStack}
================================================================================
`;
  
  // Append to error log file
  fs.appendFileSync(ERROR_LOG_FILE, logEntry);
  
  // Also log to console
  console.error(`\n❌ ERROR in ${context}:`, errorMessage);
  if (Object.keys(additionalInfo).length > 0) {
    console.error("Additional info:", additionalInfo);
  }
}

// Initialize error log file
if (fs.existsSync(ERROR_LOG_FILE)) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(ERROR_LOG_FILE, `\n\n${"=".repeat(80)}\nNEW SESSION STARTED: ${timestamp}\n${"=".repeat(80)}\n\n`);
} else {
  fs.writeFileSync(ERROR_LOG_FILE, `Error Log File - Created: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`);
}

const CSV_URL = process.argv[2];
const BASE_FOLDER = process.argv[3] || "boats";
const imagesExt = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".ico",
];
const videosExt = [
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".flv",
  ".wmv",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".ogv",
];

// const CSV_URL =
//   "https://docs.google.com/spreadsheets/d/1YV0UnfKjiNRa8mUaXTt3mcbMFTS0VGPLebdIqAPqFU0/export?format=csv&gid=0";
// const CSV_URL =
//   "https://docs.google.com/spreadsheets/d/1WRz0yUuBDSaAjQUc1w8X8rgKPedHE4KUKfR1lTm0smQ/export?format=csv&edit?gid=569293808#gid=569293808/";
//   "https://docs.google.com/spreadsheets/d/1WRz0yUuBDSaAjQUc1w8X8rgKPedHE4KUKfR1lTm0smQ/export?format=csv&edit?gid=514993967#gid=514993967";
//https://docs.google.com/spreadsheets/d/1WRz0yUuBDSaAjQUc1w8X8rgKPedHE4KUKfR1lTm0smQ/edit?gid=514993967#gid=514993967

const products = await getDataFromCSVUrl(CSV_URL, BASE_FOLDER.toLowerCase());

async function migrateFolder(url) {
  const uploadedImages = [];
  const uploadedVideos = [];
  const skippedFiles = [];
  
  if (!url) {
    console.warn("No Dropbox link provided, skipping...");
    return null;
  }

  let folderName;
  try {
    // 1️⃣ Get folder metadata
    const meta = await dropbox.sharingGetSharedLinkMetadata({ url: url });
    folderName = meta.result.name;
    console.log("\n📁 Folder name:", folderName);
  } catch (err) {
    const errorMsg = `Failed to get Dropbox folder metadata for ${url}`;
    console.warn(errorMsg, err.error_summary || err.message);
    logError("migrateFolder - Get Metadata", err, { url });
    return null; // skip this folder
  }

  // Target folders for ImageKit (images) and Cloudinary (videos)
  const IMAGEKIT_BASE_FOLDER = `/${BASE_FOLDER}/${sanitizeFileName(folderName)}`;
  const CLOUDINARY_BASE_FOLDER = `${BASE_FOLDER}/${sanitizeFileName(folderName)}`;
  
  console.log("📂 ImageKit folder:", IMAGEKIT_BASE_FOLDER);
  console.log("📂 Cloudinary folder:", CLOUDINARY_BASE_FOLDER);

  let list;
  try {
    // 2️⃣ List files in shared folder
    list = await dropbox.filesListFolder({
      path: "",
      shared_link: { url: url },
    });
  } catch (err) {
    const errorMsg = `Failed to list files for folder ${folderName}`;
    console.warn(errorMsg, err.error_summary || err.message);
    logError("migrateFolder - List Files", err, { folderName, url });
    return null;
  }
  
  console.log(`\n📊 Found ${list.result.entries.length} items in folder\n`);
  
  for (const file of list.result.entries) {
    if (file[".tag"] !== "file") continue;

    console.log(`\n🔄 Processing: ${file.name}`);

    const safeName = sanitizeFileName(file.name);
    const ext = safeName.substring(safeName.lastIndexOf(".")).toLowerCase();
    const fileSize = file.size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    let fileUrl;

    // ==================== IMAGE UPLOAD (ImageKit) ====================
    if (imagesExt.includes(ext)) {
      try {
        const filePath = file.path_lower || "/" + file.name;
        
        console.log(`  📥 Downloading image from Dropbox...`);
        const download = await dropbox.sharingGetSharedLinkFile({
          url: url,
          path: filePath,
        });
        const buffer = Buffer.from(download.result.fileBinary, "binary");

        console.log(`  📤 Uploading image to ImageKit (${fileSizeMB} MB)...`);
        const response = await imagekit.upload({
          file: buffer,
          fileName: safeName,
          folder: IMAGEKIT_BASE_FOLDER,
          useUniqueFileName: false,
        });
        
        fileUrl = response.url;
        uploadedImages.push(fileUrl);
        console.log(`  ✅ Image uploaded successfully!`);
        console.log(`     URL: ${fileUrl}`);
      } catch (error) {
        logError("Image Upload", error, {
          fileName: file.name,
          safeName,
          size: fileSizeMB + " MB",
          folder: folderName,
        });
        console.log(`  ⚠️  Skipping ${file.name} due to error...`);
        skippedFiles.push({
          name: file.name,
          type: "image",
          size: fileSizeMB,
          reason: error.message || "Unknown error",
        });
        continue;
      }
    } 
    // ==================== VIDEO UPLOAD (Cloudinary) ====================
    else if (videosExt.includes(ext)) {
      try {
        const filePath = file.path_lower || "/" + file.name;
        
        console.log(`  📥 Downloading video from Dropbox (${fileSizeMB} MB)...`);
        const download = await dropbox.sharingGetSharedLinkFile({
          url: url,
          path: filePath,
        });
        
        const buffer = Buffer.from(download.result.fileBinary, "binary");
        
        console.log(`  📤 Uploading video to Cloudinary (${fileSizeMB} MB)...`);
        
        let uploadResult;
        
        // For videos over 100MB, use upload_large with temporary file for chunked upload
        if (fileSizeMB > 100) {
          console.log(`  ⚡ Using chunked upload for large file (${fileSizeMB} MB)...`);
          
          // Write buffer to temporary file
          const fs = await import('fs');
          const path = await import('path');
          const os = await import('os');
          
          const tempDir = os.tmpdir();
          const tempFilePath = path.join(tempDir, `cloudinary_upload_${Date.now()}_${safeName}`);
          
          try {
            // Write buffer to temp file
            fs.writeFileSync(tempFilePath, buffer);
            
            // Upload using upload_large (supports chunked upload for large files)
            uploadResult = await cloudinary.uploader.upload_large(tempFilePath, {
              resource_type: "video",
              folder: CLOUDINARY_BASE_FOLDER,
              public_id: safeName.substring(0, safeName.lastIndexOf(".")),
              overwrite: false,
              chunk_size: 20_000_000, // 20 MB chunks
              timeout: 600000, // 10 minutes for large files
            });
            
            // Clean up temp file
            fs.unlinkSync(tempFilePath);
          } catch (error) {
            // Clean up temp file on error
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
            throw error;
          }
        } 
        // For smaller videos, use regular upload with data URI
        else {
          // Convert buffer to base64 data URI for proper authenticated upload
          // NOTE: upload_stream has a bug in SDK v2.x that incorrectly treats it as unsigned upload
          // Using direct upload() method with data URI as workaround
          const base64Video = buffer.toString('base64');
          const dataUri = `data:video/${ext.slice(1)};base64,${base64Video}`;
          
          uploadResult = await cloudinary.uploader.upload(dataUri, {
            resource_type: "video",
            type: "upload", // Explicitly specify signed upload
            folder: CLOUDINARY_BASE_FOLDER,
            public_id: safeName.substring(0, safeName.lastIndexOf(".")),
            overwrite: false,
            timeout: 600000, // 10 minutes for large files
          });
        }
        
        fileUrl = uploadResult.secure_url;
        uploadedVideos.push(fileUrl);
        
        console.log(`  ✅ Video uploaded successfully!`);
        console.log(`     URL: ${fileUrl}`);
      } catch (error) {
        logError("Video Upload", error, {
          fileName: file.name,
          safeName,
          size: fileSizeMB + " MB",
          folder: folderName,
        });
        console.log(`  ⚠️  Skipping ${file.name} due to error...`);
        skippedFiles.push({
          name: file.name,
          type: "video",
          size: fileSizeMB,
          reason: error.message || "Unknown error",
        });
        continue;
      }
    } 
    // ==================== UNKNOWN FILE TYPE ====================
    else {
      console.log(`  ⏭️  Skipping unknown file type: ${file.name}`);
      continue;
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log(`📊 FOLDER SUMMARY: ${folderName}`);
  console.log("=".repeat(80));
  console.log(`✅ Images uploaded: ${uploadedImages.length}`);
  console.log(`✅ Videos uploaded: ${uploadedVideos.length}`);
  console.log(`⚠️  Files skipped: ${skippedFiles.length}`);
  
  if (skippedFiles.length > 0) {
    console.log("\n⚠️  Skipped files details:");
    skippedFiles.forEach(f => {
      console.log(`   - ${f.name} (${f.type}, ${f.size} MB): ${f.reason}`);
    });
    console.log("\n💡 Check error_logs.txt for detailed error information");
  }
  console.log("=".repeat(80) + "\n");

  const uploadedData = {
    titleImage: uploadedImages[0] || "",
    titleVideo: uploadedVideos[0] || "",
    galleryImages: uploadedImages.slice(1),
    galleryVideos: uploadedVideos.slice(1),
  };

  return uploadedData;
}

console.log("\n" + "=".repeat(80));
console.log("🚀 STARTING MIGRATION PROCESS");
console.log("=".repeat(80));
console.log(`📊 CSV URL: ${CSV_URL}`);
console.log(`📁 Base Folder: ${BASE_FOLDER}`);
console.log(`📝 Total products to process: ${products.length}`);
console.log("=".repeat(80) + "\n");

let processedCount = 0;
let successCount = 0;
let failedCount = 0;

for (const product of products) {
  processedCount++;
  console.log(`\n${"=".repeat(80)}`);
  console.log(`PRODUCT ${processedCount}/${products.length}`);
  console.log("=".repeat(80));
  
  const dropboxLink = product["dropboxLink"];
  
  if (!dropboxLink) {
    console.log("⚠️  No Dropbox link found for this product, skipping...");
    continue;
  }

  try {
    const uploadedData = await migrateFolder(dropboxLink);

    if (!uploadedData) {
      failedCount++;
      logError("Product Migration", new Error("migrateFolder returned null"), {
        productIndex: processedCount,
        dropboxLink,
      });
      console.log("❌ Failed to migrate this product's folder\n");
      continue;
    }

    // Update product object
    product.titleImage = uploadedData.titleImage || "";
    product.titleVideo = uploadedData.titleVideo || "";
    
    // Combine videos first, then images in galleryContent
    product.galleryContent = [
      ...uploadedData.galleryVideos,
      ...uploadedData.galleryImages
    ];
    
    product.instantBooking = true;
    
    if (BASE_FOLDER === "boats") {
      if (product.inclusions && typeof product.inclusions === "string") {
        product.inclusions = product.inclusions.split(",").map((inc) => inc.trim());
      }
      product.category = BASE_FOLDER;
    }
    
    delete product["dropboxLink"];
    
    successCount++;
    console.log("✅ Product migration completed successfully!\n");
  } catch (error) {
    failedCount++;
    logError("Product Migration Loop", error, {
      productIndex: processedCount,
      dropboxLink,
      product: JSON.stringify(product, null, 2),
    });
    console.log("❌ Failed to migrate product due to unexpected error\n");
    // Continue to next product instead of exiting
    continue;
  }
}

// Save results to JSON file
try {
  const outputFile = `${BASE_FOLDER}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(products, null, 2));
  console.log("\n" + "=".repeat(80));
  console.log("🎉 MIGRATION COMPLETED!");
  console.log("=".repeat(80));
  console.log(`📊 Total products: ${products.length}`);
  console.log(`✅ Successfully migrated: ${successCount}`);
  console.log(`❌ Failed: ${failedCount}`);
  console.log(`📄 Output file: ${outputFile}`);
  console.log(`📋 Error log: ${ERROR_LOG_FILE}`);
  console.log("=".repeat(80) + "\n");
} catch (error) {
  logError("Save JSON File", error, {
    outputFile: `${BASE_FOLDER}.json`,
  });
  console.error("❌ CRITICAL ERROR: Failed to save output JSON file!");
  process.exit(1);
}