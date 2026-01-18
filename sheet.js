import fetch from "node-fetch";
import csvParser from "csv-parser";
import { Readable } from "stream";

const COLUMN_MAP_BOATS = {
  "Sr. No": "id",
  "Product Name": "name",
  Tagline: "tagline",
  Description: "description",
  Location: "location",
  "Starting price ($)": "basePrice",
  Rating: "rating",
  ReviewCount: "reviewCount",
  Reviews: "reviews",
  "Instant Booking": "instantBooking",
  
  Size: "size",
  Unit: "unit",
  "Trip Duration Hours": "tripDuration",
  Departure: "departure",
  Inclusions: "inclusions",
  "Guests Max": "maxGuests",
  Year: "year",
  Cabins: "cabins",
  
  Bathrooms: "bathrooms",
  
  "Dropbox Link": "dropboxLink",
};

const COLUMN_MAP_CARS = {
  "Sr. No": "id",
  "Product Name": "name",
  Tagline: "tagline",
  Description: "description",
  Location: "location",
  "Price": "basePrice",
  Rating: "rating",
  ReviewCount: "reviewCount",
  Reviews: "reviews",
  "Instant Booking": "instantBooking",
  
  Bathrooms: "bathrooms",
  Gear: "gear",
  "Gear Type": "gearType",
  "Top Speed": "topSpeed",
  Seats: "seats",
  
  "Dropbox Link": "dropboxLink",
};

const COLUMN_MAP_VILLAS = {
  "Sr. No": "id",
  "Product Name": "name",
  Tagline: "tagline",
  Description: "description",
  Location: "location",
  "Starting price ($)": "basePrice",
  Rating: "rating",
  ReviewCount: "reviewCount",
  Reviews: "reviews",
  "Instant Booking": "instantBooking",
  
  Bathroom: "bathrooms",
  Bedroom: "bedrooms",

  "Dropbox Link": "dropboxLink",
};

function transformRow(row, type) {
  const COLUMN_MAP =
    type == "boats"
      ? COLUMN_MAP_BOATS
      : type == "villas"
        ? COLUMN_MAP_VILLAS
        : COLUMN_MAP_CARS;
  const result = {};

  for (const csvKey in COLUMN_MAP) {
    const newKey = COLUMN_MAP[csvKey];

    if (row[csvKey] !== undefined) {
      result[newKey] = row[csvKey];
    }
  }

  return result;
}

export async function readCSV(url, type) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to download CSV: ${res.status}`);
  }

  const text = await res.text();

  return new Promise((resolve, reject) => {
    const rows = [];

    Readable.from(text)
      .pipe(csvParser())
      .on("data", (row) => {
        rows.push(transformRow(row, type));
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

export const getDataFromCSVUrl = async (url, type) => {
  const data = await readCSV(url, type);
  return data;
};

// const CSV_URL =
//   "https://docs.google.com/spreadsheets/d/1YV0UnfKjiNRa8mUaXTt3mcbMFTS0VGPLebdIqAPqFU0/export?format=csv&gid=0";

// const procducts = await getDataFromCSVUrl(CSV_URL);
// console.log(procducts);
