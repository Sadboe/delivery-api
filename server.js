require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY;
const DEBUG_RESPONSE = String(process.env.DEBUG_RESPONSE || "true").toLowerCase() === "true";

const zonesPath = path.join(__dirname, "zones.geojson");
let zonesData;
try {
  zonesData = JSON.parse(fs.readFileSync(zonesPath, "utf8"));
} catch (error) {
  console.error("Cannot read zones.geojson:", error.message);
  process.exit(1);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/ё/g, "е")
    .replace(/Ё/g, "Е")
    .trim();
}

const UDMURTIA_LOCALITIES = [
  "ягул",
  "первомайский",
  "хохряки",
  "италмас",
  "пирогово",
  "октябрьский",
  "завьялово",
  "чемошур",
  "средний",
  "люкшудья",
  "шабердино",
];

function hasWord(text, word) {
  return new RegExp(`(^|[^а-яa-z])${word}([^а-яa-z]|$)`, "i").test(text);
}

function hasUdmurtiaContext(address) {
  const lower = normalizeText(address).toLowerCase();
  return lower.includes("удмурт") || lower.includes("завьялов") || lower.includes("ижевск");
}

function hasKnownUdmurtiaLocality(address) {
  const lower = normalizeText(address).toLowerCase();
  return UDMURTIA_LOCALITIES.some((locality) => hasWord(lower, locality));
}

function cleanAddressMarkers(value) {
  return normalizeText(value)
    .replace(/№\s*/gi, "")
    .replace(/No\s*:?\s*/gi, "")
    .replace(/N\s*:?\s*/gi, "");
}

function isHouseToken(value) {
  const token = normalizeText(value).replace(/\s+/g, "");
  // Дом: 10, 10Б, 10/1, 122А и т.п.
  return /^\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?$/i.test(token);
}

function cutAddressAfterHouse(rawAddress) {
  const address = cleanAddressMarkers(rawAddress);
  if (!address) return "";

  const parts = address
    .split(",")
    .map((part) => normalizeText(part))
    .filter(Boolean);

  // Если адрес введён с запятыми, отрезаем подъезд/этаж/квартиру после дома.
  if (parts.length > 1) {
    let houseIndex = -1;
    for (let i = 0; i < parts.length; i++) {
      if (isHouseToken(parts[i])) {
        houseIndex = i;
        break;
      }
    }

    return houseIndex >= 0
      ? parts.slice(0, houseIndex + 1).join(", ")
      : parts.join(", ");
  }

  // Если запятых нет: "Первомайский Полевая 10Б 9".
  // Берём текст до первого похожего номера дома включительно, чтобы убрать квартиру/этаж.
  const tokens = address.split(" ").map((part) => normalizeText(part)).filter(Boolean);
  const houseIndex = tokens.findIndex(isHouseToken);
  if (houseIndex >= 1) {
    return tokens.slice(0, houseIndex + 1).join(" ");
  }

  return address;
}

function makeGeocodeCandidates(rawAddress) {
  const prepared = cutAddressAfterHouse(rawAddress);
  if (!prepared) return [];

  const candidates = [];
  const add = (value) => {
    const normalized = normalizeText(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  if (hasUdmurtiaContext(prepared)) {
    // Если регион/Ижевск уже указан, не добавляем лишние города, но оставляем исходный адрес.
    add(prepared);
  } else if (hasKnownUdmurtiaLocality(prepared)) {
    // Если указан пригород/населённый пункт вроде Первомайский или Ягул,
    // сначала принудительно ищем его в Удмуртии, чтобы Яндекс не уводил в Украину/другой регион.
    add(`Удмуртская Республика, Завьяловский район, ${prepared}`);
    add(`Удмуртская Республика, ${prepared}`);
    add(prepared);
  } else {
    // Если город не указан, сначала считаем, что это Ижевск.
    add(`Ижевск, ${prepared}`);

    // Затем ищем шире по Удмуртии.
    add(`Удмуртская Республика, ${prepared}`);

    // Последний резерв — как ввёл пользователь.
    add(prepared);
  }

  return candidates;
}

function getResponseMeta(collection) {
  return collection?.metaDataProperty?.GeocoderResponseMetaData || {};
}

function getFeatureMembers(data) {
  return data?.response?.GeoObjectCollection?.featureMember || [];
}

function getGeoObjectInfo(member) {
  const obj = member?.GeoObject;
  const meta = obj?.metaDataProperty?.GeocoderMetaData || {};
  const pointPos = obj?.Point?.pos || "";
  const [lonStr, latStr] = pointPos.split(" ");
  const lon = Number(lonStr);
  const lat = Number(latStr);

  const address = meta.Address || {};
  const components = Array.isArray(address.Components) ? address.Components : [];
  const countryCode = address.country_code || "";
  const formattedAddress = address.formatted || meta.text || obj?.name || "";

  return {
    obj,
    meta,
    lon,
    lat,
    kind: meta.kind || "",
    precision: meta.precision || "",
    text: meta.text || "",
    formattedAddress,
    countryCode,
    components,
  };
}

function hasHouseComponent(info) {
  return info.components.some((component) => component.kind === "house" && component.name);
}

function isAccurateEnough(info) {
  if (!Number.isFinite(info.lon) || !Number.isFinite(info.lat)) return false;

  if (info.kind === "house") return true;
  if (hasHouseComponent(info)) return true;

  if (info.precision === "exact" && /\b\d+\s*[а-яa-z]?\b/i.test(info.formattedAddress)) {
    return true;
  }

  return false;
}

async function geocodeOneAddress(addressForGeocoder) {
  if (!YANDEX_GEOCODER_API_KEY) {
    throw new Error("YANDEX_GEOCODER_API_KEY is not set");
  }

  const url = new URL("https://geocode-maps.yandex.ru/1.x/");
  url.searchParams.set("apikey", YANDEX_GEOCODER_API_KEY);
  url.searchParams.set("geocode", addressForGeocoder);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "ru_RU");
  url.searchParams.set("results", "10");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "delivery-api/1.0" },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Yandex Geocoder error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const collection = data?.response?.GeoObjectCollection;
  const responseMeta = getResponseMeta(collection);
  const members = getFeatureMembers(data);

  if (!members.length || responseMeta.found === "0") {
    return { status: "not_found", addressForGeocoder, responseMeta };
  }

  const parsed = members.map(getGeoObjectInfo);
  const accurate = parsed.find(isAccurateEnough);
  const selected = accurate || parsed[0];

  return {
    status: accurate ? "ok" : "not_house",
    addressForGeocoder,
    responseMeta,
    ...selected,
  };
}

async function geocodeCandidates(rawAddress) {
  const candidates = makeGeocodeCandidates(rawAddress);
  if (!candidates.length) return [];

  const results = [];
  for (const candidate of candidates) {
    const result = await geocodeOneAddress(candidate);
    results.push(result);
  }
  return results;
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);

    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygon(point, polygonCoordinates) {
  if (!Array.isArray(polygonCoordinates) || !polygonCoordinates.length) return false;

  const outerRing = polygonCoordinates[0];
  if (!pointInRing(point, outerRing)) return false;

  for (let i = 1; i < polygonCoordinates.length; i++) {
    if (pointInRing(point, polygonCoordinates[i])) return false;
  }

  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;

  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }

  return false;
}

function findMatchingZone(lon, lat) {
  const point = [lon, lat];
  const features = Array.isArray(zonesData.features) ? zonesData.features : [];

  const matches = features.filter((feature) => pointInGeometry(point, feature.geometry));
  if (!matches.length) return null;

  // Если зоны пересекаются, выбираем зону с МЕНЬШИМ priority.
  // Сейчас у тебя: green=1, blue=2, purple=3.
  // Это значит: если точка одновременно в зелёной и фиолетовой, победит зелёная.
  matches.sort((a, b) => {
    const priorityA = Number(a?.properties?.priority ?? 9999);
    const priorityB = Number(b?.properties?.priority ?? 9999);
    return priorityA - priorityB;
  });

  return matches[0];
}

function getZoneTitle(zone) {
  return zone?.properties?.title || zone?.properties?.name || "Зона доставки";
}

function getZonePrice(zone) {
  const value = zone?.properties?.price;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getZoneTime(zone) {
  return zone?.properties?.time || zone?.properties?.delivery_time || "";
}

function withDebug(payload, geocodeResult, extra = {}) {
  if (!DEBUG_RESPONSE) return payload;

  return {
    ...payload,
    debug_geocode_candidates: extra.candidates || undefined,
    debug_geocode_address: geocodeResult?.addressForGeocoder || "",
    debug_lon: Number.isFinite(geocodeResult?.lon) ? geocodeResult.lon : null,
    debug_lat: Number.isFinite(geocodeResult?.lat) ? geocodeResult.lat : null,
    debug_precision: geocodeResult?.precision || "",
    debug_kind: geocodeResult?.kind || "",
    debug_formatted_address: geocodeResult?.formattedAddress || "",
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Delivery API работает. Используйте POST /delivery",
    zones_count: Array.isArray(zonesData.features) ? zonesData.features.length : 0,
    priority_rule: "lower priority wins: green=1, blue=2, purple=3",
  });
});

app.post("/delivery", async (req, res) => {
  try {
    const address = normalizeText(req.body?.address);

    if (!address) {
      return res.json({
        delivery_price: 0,
        delivery_time: "",
        status: "error",
        message: "Введите адрес: населённый пункт, улица и дом",
      });
    }

    const candidates = makeGeocodeCandidates(address);
    const geocodeResults = await geocodeCandidates(address);

    if (!geocodeResults.length) {
      return res.json({
        delivery_price: 0,
        delivery_time: "",
        status: "error",
        message: "Не удалось найти адрес. Укажите населённый пункт, улицу и номер дома.",
        debug_geocode_candidates: DEBUG_RESPONSE ? candidates : undefined,
      });
    }

    let firstAccurate = null;
    let firstFound = geocodeResults.find((r) => r.status !== "not_found") || geocodeResults[0];

    // Выбираем первый точный адрес, который попал в зону.
    for (const result of geocodeResults) {
      if (result.status !== "ok") continue;
      if (!firstAccurate) firstAccurate = result;

      const zone = findMatchingZone(result.lon, result.lat);
      if (zone) {
        return res.json(withDebug({
          delivery_price: getZonePrice(zone),
          delivery_time: getZoneTime(zone),
          status: "ok",
          message: `Адрес доставки: ${result.formattedAddress || address}`,
          zone: getZoneTitle(zone),
        }, result, { candidates }));
      }
    }

    // Если адреса находились, но ни один точный результат не попал в зону.
    if (firstAccurate) {
      return res.json(withDebug({
        delivery_price: 0,
        delivery_time: "",
        status: "out_of_zone",
        message: "К сожалению, данный адрес находится вне зоны доставки",
      }, firstAccurate, { candidates }));
    }

    // Если Яндекс что-то нашёл, но не дом.
    if (firstFound && firstFound.status === "not_house") {
      return res.json(withDebug({
        delivery_price: 0,
        delivery_time: "",
        status: "error",
        message: "Не удалось точно определить дом. Укажите населённый пункт, улицу и номер дома.",
      }, firstFound, { candidates }));
    }

    return res.json(withDebug({
      delivery_price: 0,
      delivery_time: "",
      status: "error",
      message: "Не удалось найти адрес. Укажите населённый пункт, улицу и номер дома.",
    }, firstFound, { candidates }));
  } catch (error) {
    console.error("Delivery API error:", error);
    return res.json({
      delivery_price: 0,
      delivery_time: "",
      status: "error",
      message: "Ошибка проверки адреса. Попробуйте позже",
      debug_error: DEBUG_RESPONSE ? error.message : undefined,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Delivery API started on port ${PORT}`);
});
