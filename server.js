const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   CONFIGURACION
========================================================= */

const LOCATIONS = {
  iquique: {
    name: "Iquique",
    latitude: -20.2141,
    longitude: -70.1524
  },
  altoHospicio: {
    name: "Alto Hospicio",
    latitude: -20.2670,
    longitude: -70.1030
  }
};

const SOURCES = [
  {
    id: "openMeteo",
    name: "Open-Meteo",
    type: "clima",
    url: "https://open-meteo.com/",
    automatic: true
  },
  {
    id: "senapred",
    name: "SENAPRED",
    type: "alertas",
    url: "https://senapred.cl/",
    automatic: false
  },
  {
    id: "dmc",
    name: "Direccion Meteorologica de Chile",
    type: "meteorologia",
    url: "https://www.meteochile.gob.cl/",
    automatic: false
  },
  {
    id: "mop",
    name: "Ministerio de Obras Publicas",
    type: "vialidad",
    url: "https://www.mop.gob.cl/",
    automatic: true
  }
];

const ROUTES = [
  {
    name: "A-16",
    keys: ["A-16", "RUTA 16"],
    desc: "Iquique - Alto Hospicio"
  },
  {
    name: "A-1 / Ruta 1",
    keys: ["A-1", "RUTA 1"],
    desc: "Iquique - Aeropuerto Diego Aracena"
  },
  {
    name: "Ruta 5",
    keys: ["RUTA 5"],
    desc: "Eje interior"
  },
  {
    name: "A-504",
    keys: ["A-504", "A504"],
    desc: "Conexion sectorial"
  },
  {
    name: "A-506",
    keys: ["A-506", "A506"],
    desc: "Conexion sectorial"
  },
  {
    name: "A-616",
    keys: ["A-616", "A616"],
    desc: "Conexion Alto Hospicio"
  }
];

/* =========================================================
   CACHE
========================================================= */

const CACHE_TIME = 5 * 60 * 1000;

let weatherCache = {
  data: null,
  timestamp: 0
};

let mopCache = {
  data: null,
  timestamp: 0
};

/* =========================================================
   UTILIDADES
========================================================= */

function clean(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cToLabel(code) {
  const map = {
    0: "Despejado",
    1: "Mayormente despejado",
    2: "Parcialmente nublado",
    3: "Nublado",
    45: "Niebla",
    48: "Niebla con escarcha",
    51: "Llovizna ligera",
    53: "Llovizna moderada",
    55: "Llovizna intensa",
    61: "Lluvia ligera",
    63: "Lluvia moderada",
    65: "Lluvia intensa",
    71: "Nieve ligera",
    73: "Nieve moderada",
    75: "Nieve intensa",
    80: "Chubascos ligeros",
    81: "Chubascos moderados",
    82: "Chubascos intensos",
    95: "Tormenta",
    96: "Tormenta con granizo",
    99: "Tormenta fuerte con granizo"
  };

  return map[code] || "Condicion no especificada";
}

function riskBand(score) {
  if (score == null) {
    return ["SIN DATOS", "gray"];
  }

  if (score < 3) {
    return ["BAJO", "green"];
  }

  if (score < 5) {
    return ["VIGILANCIA", "yellow"];
  }

  if (score < 7) {
    return ["VIGILANCIA ALTA", "orange"];
  }

  if (score < 9) {
    return ["ALTO", "orange"];
  }

  return ["CRITICO", "red"];
}

async function getJson(url, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TARAVIA/1.5"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

/* =========================================================
   METEOROLOGIA
   Una sola consulta para Iquique + Alto Hospicio
========================================================= */

async function getWeather() {
  const now = Date.now();

  if (
    weatherCache.data &&
    now - weatherCache.timestamp < CACHE_TIME
  ) {
    return {
      ...weatherCache.data,
      cached: true
    };
  }

  const url = new URL(
    "https://api.open-meteo.com/v1/forecast"
  );

  url.searchParams.set(
    "latitude",
    `${LOCATIONS.iquique.latitude},${LOCATIONS.altoHospicio.latitude}`
  );

  url.searchParams.set(
    "longitude",
    `${LOCATIONS.iquique.longitude},${LOCATIONS.altoHospicio.longitude}`
  );

  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m"
  );

  url.searchParams.set(
    "hourly",
    "precipitation,precipitation_probability"
  );

  url.searchParams.set(
    "forecast_days",
    "2"
  );

  url.searchParams.set(
    "timezone",
    "America/Santiago"
  );

  try {
    const data = await getJson(
      url.toString()
    );

    const currentList =
      Array.isArray(data.current)
        ? data.current
        : [data.current];

    const hourlyList =
      Array.isArray(data.hourly)
        ? data.hourly
        : [data.hourly];

    const results = {};

    const locationNames = [
      "iquique",
      "altoHospicio"
    ];

    for (
      let i = 0;
      i < locationNames.length;
      i++
    ) {
      const key = locationNames[i];

      const current =
        currentList[i] || {};

      const hourly =
        hourlyList[i] || {};

      const probabilities =
        Array.isArray(
          hourly.precipitation_probability
        )
          ? hourly.precipitation_probability
              .slice(0, 6)
              .map(Number)
              .filter(Number.isFinite)
          : [];

      const precipitation =
        Array.isArray(
          hourly.precipitation
        )
          ? hourly.precipitation
              .slice(0, 24)
              .map(Number)
              .filter(Number.isFinite)
          : [];

      const rain24 =
        precipitation.length
          ? precipitation.reduce(
              (sum, value) =>
                sum + value,
              0
            )
          : Number(
              current.precipitation ?? 0
            );

      const probability =
        probabilities.length
          ? Math.max(
              ...probabilities
            )
          : null;

      results[key] = {
        location:
          LOCATIONS[key].name,

        temperature:
          current.temperature_2m ?? null,

        apparentTemperature:
          current.apparent_temperature ??
          null,

        humidity:
          current.relative_humidity_2m ??
          null,

        precipitation:
          current.precipitation ?? null,

        rain:
          current.rain ?? null,

        rain24,

        precipitationProbabilityNext6h:
          probability,

        wind:
          current.wind_speed_10m ?? null,

        windDirection:
          current.wind_direction_10m ??
          null,

        weatherCode:
          current.weather_code ?? null,

        condition:
          cToLabel(
            current.weather_code
          ),

        observedAt:
          current.time ||
          new Date().toISOString(),

        source: "Open-Meteo"
      };
    }

    const result = {
      iquique: results.iquique,
      altoHospicio:
        results.altoHospicio,
      fetchedAt:
        new Date().toISOString(),
      cached: false,
      error: null
    };

    weatherCache = {
      data: result,
      timestamp: Date.now()
    };

    return result;

  } catch (error) {

    console.error(
      "WEATHER_ERROR",
      error.message
    );

    if (weatherCache.data) {
      return {
        ...weatherCache.data,
        cached: true,
        stale: true,
        error:
          "Open-Meteo temporalmente limitado; mostrando ultimo dato valido."
      };
    }

    return {
      iquique: {
        error: error.message
      },

      altoHospicio: {
        error: error.message
      },

      fetchedAt:
        new Date().toISOString(),

      cached: false,
      stale: false,
      error: error.message
    };
  }
}

/* =========================================================
   MOP
========================================================= */

async function getMop() {
  const now = Date.now();

  if (
    mopCache.data &&
    now - mopCache.timestamp < CACHE_TIME
  ) {
    return {
      data: mopCache.data,
      cached: true,
      error: null
    };
  }

  const url =
    "https://rest-sit.mop.gob.cl/arcgis/rest/services/VIALIDAD/Emergencias_Vialidad/MapServer/0/query" +
    "?where=1%3D1" +
    "&outFields=*" +
    "&returnGeometry=false" +
    "&f=json";

  try {

    const data =
      await getJson(url);

    const items =
      Array.isArray(data.features)
        ? data.features.map(
            feature =>
              feature.attributes || {}
          )
        : [];

    mopCache = {
      data: items,
      timestamp: Date.now()
    };

    return {
      data: items,
     
