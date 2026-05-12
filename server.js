require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default;
const { point } = require("@turf/helpers");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YANDEX_GEOCODER_API_KEY = String(process.env.YANDEX_GEOCODER_API_KEY || "")
  .trim()
  .replace(/^['\"]|['\"]$/g, "");

const zonesPath = path.join(__dirname, "zones.geojson");
const zonesFile = JSON.parse(fs.readFileSync(zonesPath, "utf8"));

const zones = zonesFile.features
  .filter((feature) => feature && feature.geometry && feature.properties)
  .sort((a, b) => Number(a.properties.priority || 999) - Number(b.properties.priority || 999));

const ALLOWED_CITY = "ижевск";

const OTHER_CITIES = [
  "москва",
  "санкт-петербург",
  "питер",
  "казань",
  "пермь",
  "екатеринбург",
  "уфа",
  "самара",
  "саратов",
  "нижний новгород",
  "новосибирск",
  "челябинск",
  "омск",
  "краснодар",
  "воронеж",
  "ростов",
  "тюмень",
  "сочи",
  "алания",
  "анталия"
];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasAllowedCity(address) {
  return normalizeText(address).includes(ALLOWED_CITY);
}

function hasExplicitOtherCity(address) {
  const lower = normalizeText(address);
  return OTHER_CITIES.some((city) => lower.includes(city));
}

function isClearlyOutsideIzhevsk(rawAddress) {
  return hasExplicitOtherCity(rawAddress) && !hasAllowedCity(rawAddress);
}

// Пример входа: "Ижевск, Советская, 2, 1, 3, 8".
// Для Яндекс Геокодера оставляем только: "Ижевск, Советская, 2".
function prepareAddressForGeocoder(rawAddress) {
  const value = String(rawAddress || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[;|]+/g, ",");

  if (!value) return "";

  let address = value;

  if (!hasAllowedCity(address)) {
    address = `Ижевск, ${address}`;
  }

  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    const city = parts[0];
    const street = parts[1];
    const houseCandidate = parts[2];
    const houseMatch = houseCandidate.match(/\d+[а-яa-z0-9/\-]*/i);

    if (houseMatch) {
      return `${city}, ${street}, ${houseMatch[0]}`;
    }
  }

  return address;
}

async function geocodeAddress(rawAddress) {
  if (!YANDEX_GEOCODER_API_KEY || YANDEX_GEOCODER_API_KEY === "your_yandex_key_here") {
    throw new Error("YANDEX_GEOCODER_API_KEY is not set or placeholder is used");
  }

  const geocoderAddress = prepareAddressForGeocoder(rawAddress);

  const url = new URL("https://geocode-maps.yandex.ru/1.x/");
  url.searchParams.set("apikey", YANDEX_GEOCODER_API_KEY);
  url.searchParams.set("geocode", geocoderAddress);
  url.searchParams.set("lang", "ru_RU");
  url.searchParams.set("format", "json");
  url.searchParams.set("results", "1");

  console.log("RAW ADDRESS:", rawAddress);
  console.log("GEOCODER ADDRESS:", geocoderAddress);
  console.log("YANDEX URL:", url.toString());

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("YANDEX ERROR BODY:", text);
    throw new Error(`Yandex Geocoder error: ${response.status}`);
  }

  const data = await response.json();
  const collection = data?.response?.GeoObjectCollection;
  const featureMembers = collection?.featureMember || [];
  const foundCount = Number(collection?.metaDataProperty?.GeocoderResponseMetaData?.found || 0);

  if (!featureMembers.length || foundCount === 0) return null;

  const geoObject = featureMembers[0]?.GeoObject;
  const pos = geoObject?.Point?.pos;
  if (!pos) return null;

  const [longitude, latitude] = pos.split(" ").map(Number);
  const meta = geoObject?.metaDataProperty?.GeocoderMetaData || {};
  const components = meta.Address?.Components || [];

  return {
    longitude,
    latitude,
    foundAddress: meta.text || geocoderAddress,
    precision: meta.precision || "unknown",
    kind: meta.kind || "unknown",
    locality: components.find((component) => component.kind === "locality")?.name || "",
    street: components.find((component) => component.kind === "street")?.name || "",
    house: components.find((component) => component.kind === "house")?.name || "",
    geocoderAddress
  };
}

function isIzhevskAddress(geocoded) {
  const found = normalizeText(geocoded?.foundAddress);
  const locality = normalizeText(geocoded?.locality);
  return found.includes(ALLOWED_CITY) || locality.includes(ALLOWED_CITY);
}

function looksLikeHouse(rawAddress, geocoded) {
  return (
    geocoded?.kind === "house" ||
    geocoded?.precision === "exact" ||
    Boolean(geocoded?.house) ||
    /\d/.test(String(rawAddress || ""))
  );
}

function findDeliveryZone(longitude, latitude) {
  const userPoint = point([longitude, latitude]);

  for (const zone of zones) {
    if (booleanPointInPolygon(userPoint, zone)) {
      return zone.properties;
    }
  }

  return null;
}

function successResponse(zone, geocoded) {
  return {
    delivery_price: Number(zone.price || 0),
    delivery_time: String(zone.delivery_time || zone.time || ""),
    status: "ok",
    message: `Адрес доставки: ${geocoded.foundAddress}`,
    zone: zone.title || zone.name || ""
  };
}

function errorResponse(message, status = "error") {
  return {
    delivery_price: 0,
    delivery_time: "",
    status,
    message
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Delivery API работает. Используйте POST /delivery"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/delivery", async (req, res) => {
  try {
    const { address } = req.body || {};

    if (!address || String(address).trim().length < 5) {
      return res.json(
        errorResponse("Введите адрес полностью: город, улица, дом, подъезд, этаж, квартира/офис")
      );
    }

    // Другие города сразу блокируем. В Яндекс не отправляем.
    if (isClearlyOutsideIzhevsk(address)) {
      return res.json(
        errorResponse("К сожалению, данный адрес находится вне зоны доставки", "out_of_zone")
      );
    }

    const geocoded = await geocodeAddress(address);

    if (!geocoded) {
      return res.json(errorResponse("Введен несуществующий адрес ❗"));
    }

    if (!isIzhevskAddress(geocoded)) {
      return res.json(
        errorResponse("К сожалению, данный адрес находится вне зоны доставки", "out_of_zone")
      );
    }

    if (!looksLikeHouse(address, geocoded)) {
      return res.json(errorResponse("Не удалось точно определить дом. Укажите адрес с номером дома"));
    }

    const zone = findDeliveryZone(geocoded.longitude, geocoded.latitude);

    if (!zone) {
      return res.json(
        errorResponse("К сожалению, данный адрес находится вне зоны доставки", "out_of_zone")
      );
    }

    return res.json(successResponse(zone, geocoded));
  } catch (error) {
    console.error(error);
    return res.status(500).json(errorResponse("Ошибка проверки адреса. Попробуйте позже"));
  }
});

app.listen(PORT, () => {
  console.log(`Delivery API started on port ${PORT}`);
});
