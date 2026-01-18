import ImageKit from "imagekit";
import { Dropbox } from "dropbox";
import fetch from "node-fetch";
import fs from "fs";
import { getDataFromCSVUrl } from "./sheet.js";

const imagekit = new ImageKit({
  publicKey: "public_RHUuVs+0yCF/s0giAdN6ZJWHvBE=",
  privateKey: "private_azq33yQXmV19vcG2z49w77oykrk=",
  urlEndpoint: "https://ik.imagekit.io/hamknight",
});

const dropbox = new Dropbox({
  accessToken:
    "sl.u.AGNN5ybfLqSMJUhBDrDJQXX7-MpiT1egl77utRfa6MquuAxOlnxsQCxElRZtRB1sYymuRkyoEmO8Hoep9G8PCzFptMYtSRtOhc9BNnQ7hGw22jjcWV4GhwT-5IdSGvqri45LCdd5hqAFIIBioxR9l4cvVdqBGP1P-7blVos3nKCHxFJLlP64zSQNKu5CJLGXkj9ioIkeFx1GawIuBy7h0Ky_hjsmrdDozc7OwrWgClufFpeiqUQqzJdWn5Ry3xNpBFn5F1O0RCzvq2deOJK-1d3vJF2XCMFHyujMcFedd7ZKISRHIyjRBblJTizInI9AnPihSmSGRwbovTxZAnIZSHELEjDRKbWdARYvfBhq1AheQFOVU7lVY6EYgl8-RpLHJYLq90uIuudz49BSqRbh5bVkGqWdSe7QSyxvtPHkDhy7JguQnTrYwRjtP9IROWJGGgpZ8rshgThLasSWkPh8ayD0ynkt8qOP23xlwYwBeFD5crGcrDgxanUJxDgEXxamiKeC6sgrlNkwnkOHBhOiU79iBYRmXrY_4duVHVFqVbD4VURJvqy7tu3xrXWes9ihQ8_Tmb0_NoIlCjPHpQq3GsewnOeeRvc1SJ3ZXJPmdltoyQCO6OOq7H2bxhJDbqqi6xLc8Oy6yhzJuC9gDsl_CSUgyvGX0eKWj65Y9ZkEFf0PIlUgmVPLBSHSzcqDAZADqYX627Oe5yCIiW4LmdOrovdHlWEX0AV-cNDrRKoVUviKYgZjLkS6rQpcBYbq4Ce79GuYDoKBJWYXbBIksLm4mJRCZIx3G4CRZ5_VybkpCqVQj_Bp5GSvRDaJbFQTJQzI4aCJ9NytzbTrwJpyYzdPwDMz_SY5ejIs0k5_tGOn2xT01IhtpoRyW2C3yO1-behFRxdgoEBT7qzMNZNdRtp6G6qqXB3pqCGqs775VxNGVQ2wsBtOb2P0srboSpyVwwZ90fPM-lyBJk5bGahFF6GZTQz4qaTbEQ7dTueeL4yW_LeDMFyZQ8eYGPAOi9YZqhQwXMJ4xdPOqdMrCTIx_q2zbCs5mRPxm3hL5z4SeVRvUqUcgkKGBT8UW6_kC_Pg_tTV01kibdjXpYMHKntQUZjRE2bzvoZeYl7Casq77rNG4ss1Wkr9-k6z6VRjd0s2NUYlLoICe_B6eWWeDl3G0q8X8EyTW5g83utBVzQQeCEIr6feFNOcLYRXaqYGeHzCL-ViWWedGugQm_jKId0Dy9qC0vMy9dbX5XKxwvaYfz5sNO9zW7S6JQtfhu_AgyNkrCyCMZB_BWFrRPd049UIJ61EeLZYaFrDf2G-Ec51Fr5zh3XdBRt5eb9L9-eWB6tXFpDsm9q_WCLMfYTxryKqbRSRVk7j2IesNd9aXI95zpeMkAbUSTXfmc4r_5YVVCeoOL20KAjTMpJNKQEt5HEP2nQ0p24G4eFGWtaEZ1AhS-ISseDqsw",
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
  if (!url) {
    console.warn("No Dropbox link provided, skipping...");
    return null;
  }

  let folderName;
  try {
    // 1️⃣ Get folder metadata
    const meta = await dropbox.sharingGetSharedLinkMetadata({ url: url });
    folderName = meta.result.name;
    console.log("\nFolder name:", folderName);
  } catch (err) {
    console.warn(
      `Failed to get Dropbox folder metadata for ${url}:`,
      err.error_summary || err.message,
    );
    return null; // skip this folder
  }

  // Target ImageKit folder
  const IMAGEKIT_BASE_FOLDER = `/${BASE_FOLDER}/${sanitizeFileName(folderName)}`;
  console.log("IMAGEKIT_BASE_FOLDER", IMAGEKIT_BASE_FOLDER);

  let list;
  try {
    // 2️⃣ List files in shared folder
    list = await dropbox.filesListFolder({
      path: "",
      shared_link: { url: url },
    });
  } catch (err) {
    console.warn(
      `Failed to list files for folder ${folderName}:`,
      err.error_summary || err.message,
    );
    return null;
  }
  for (const file of list.result.entries) {
    if (file[".tag"] !== "file") continue;

    console.log("Downloading:", file.name);

    const safeName = sanitizeFileName(file.name);

    // Dropbox download from shared link
    // Use "/" + file.name to construct the path relative to the shared folder root
    const filePath = file.path_lower || "/" + file.name;
    const download = await dropbox.sharingGetSharedLinkFile({
      url: url,
      path: filePath,
    });
    const buffer = Buffer.from(download.result.fileBinary, "binary");

    // Determine file type
    const ext = safeName.substring(safeName.lastIndexOf(".")).toLowerCase();

    let fileUrl;

    if (imagesExt.includes(ext)) {
      // Upload small image normally
      const response = await imagekit.upload({
        file: buffer,
        fileName: safeName,
        folder: IMAGEKIT_BASE_FOLDER,
        useUniqueFileName: false,
      });
      fileUrl = response.url;
      uploadedImages.push(fileUrl);
    } else if (videosExt.includes(ext)) {
      // Upload large video via stream
      const tempPath = `./temp_${safeName}`;
      fs.writeFileSync(tempPath, buffer); // save temporarily

      const stream = fs.createReadStream(tempPath);
      const response = await imagekit.upload({
        file: stream,
        fileName: safeName,
        folder: IMAGEKIT_BASE_FOLDER,
        useUniqueFileName: false,
      });

      fileUrl = response.url;
      uploadedVideos.push(fileUrl);

      // Remove temp file
      fs.unlinkSync(tempPath);
    } else {
      console.log("Skipping unknown file type:", file.name);
      continue;
    }

    console.log("Uploaded to ImageKit:", fileUrl);
  }

  const uploadedData = {
    titleImage: uploadedImages[0] || "",
    titleVideo: uploadedVideos[0] || "",
    galleryImages: uploadedImages.slice(1),
    galleryVideos: uploadedVideos.slice(1),
  };

  console.log("Saved to JSON under key:", folderName);
  return uploadedData;
}

for (const product of products) {
  const dropboxLink = product["dropboxLink"];
  if (!dropboxLink) continue;

  const uploadedData = await migrateFolder(dropboxLink);

  // Update product object
  product.titleImage = uploadedData?.titleImage || "";
  product.titleVideo = uploadedData?.titleVideo || "";
  product.galleryContent =
    [...uploadedData?.galleryVideos, ...uploadedData?.galleryImages] || [];
  product.instantBooking = true;
  if (BASE_FOLDER === "boats") {
    product.inclusions = product.inclusions.split(",").map((inc) => inc);
    product.category = BASE_FOLDER;
  }
  delete product["dropboxLink"];
}
fs.writeFileSync(`${BASE_FOLDER}.json`, JSON.stringify(products, null, 2));
console.log("Migration completed!", products);