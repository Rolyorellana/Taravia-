const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static("public"));

/* =========================================================
   TARAVÍA 1.5.2
   Servidor principal
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
    automatic: true
  },
  {
    id: "metNorway",
    name: "MET Norway",
    type: "clima",
    automatic: true
  },
  {
    id: "mop",
    name: "MOP Vialidad",
    type: "vialidad",
    automatic: false
  },
  {
    id: "senapred",
    name: "SENAPRED",
    type: "alertas",
    automatic: false
  }
];

/* =========================================================
   CACHÉ
   Evita golpear Open-Meteo repetidamente y recibir HTTP 429.
   ========================================================= */

const weatherCache = new Map();

const CACHE_TIME = 10 * 60 * 1000;

/* =========================================================
   UTILIDADES
   ========================================================= */

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

  return map[code] || "Condición no especificada";
}

async function fetchWithTimeout(url, options = {}, timeout = 9000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeout)
  });
}

/* =========================================================
   OPEN-METEO
   ========================================================= */

async function getOpenMeteo(location) {
  const cacheKey = `openmeteo-${location.name}`;
  const cached = weatherCache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_TIME) {
    return {
      ...cached.data,
      cached: true
    };
  }

  const url = new URL(
    "https://api.open-meteo.com/v1/forecast"
  );

  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);

  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "rain",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m"
    ].join(",")
  );

  url.searchParams.set(
    "hourly",
    "precipitation_probability"
  );

  url.searchParams.set("forecast_days", "1");
  url.searchParams.set(
    "timezone",
    "America/Santiago"
  );

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        "User-Agent": "TARAVIA/1.5.2"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Open-Meteo HTTP ${response.status}`
    );
  }

  const data = await response.json();
  const current = data.current || {};

  const probabilities =
    Array.isArray(
      data.hourly?.precipitation_probability
    )
      ? data.hourly.precipitation_probability
          .slice(0, 6)
          .map(Number)
          .filter(Number.isFinite)
      : [];

  const probability =
    probabilities.length > 0
      ? Math.max(...probabilities)
      : 0;

  const result = {
    location: location.name,
    temperature:
      current.temperature_2m ?? null,

    apparentTemperature:
      current.apparent_temperature ?? null,

    humidity:
      current.relative_humidity_2m ?? null,

    precipitation:
      current.precipitation ?? null,

    rain:
      current.rain ?? null,

    precipitationProbabilityNext6h:
      probability,

    wind:
      current.wind_speed_10m ?? null,

    windDirection:
      current.wind_direction_10m ?? null,

    weatherCode:
      current.weather_code ?? null,

    condition:
      cToLabel(current.weather_code),

    observedAt:
      current.time ||
      new Date().toISOString(),

    source: "Open-Meteo",

    cached: false
  };

  weatherCache.set(cacheKey, {
    time: Date.now(),
    data: result
  });

  return result;
}

/* =========================================================
   RESPALDO MET NORWAY
   ========================================================= */

async function getMetNorway(location) {
  const url =
    `https://api.met.no/weatherapi/locationforecast/2.0/compact` +
    `?lat=${location.latitude}` +
    `&lon=${location.longitude}`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "TARAVIA/1.5.2 contacto-taravia@example.com"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `MET Norway HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const first =
    data.properties?.timeseries?.[0];

  if (!first) {
    throw new Error(
      "MET Norway sin datos"
    );
  }

  const details =
    first.data?.instant?.details || {};

  const nextHours =
    data.properties?.timeseries?.slice(0, 6) || [];

  const probabilities = nextHours
    .map(
      item =>
        Number(
          item.data?.next_1_hours
            ?.details
            ?.probability_of_precipitation
        )
    )
    .filter(Number.isFinite);

  const probability =
    probabilities.length
      ? Math.max(...probabilities)
      : 0;

  return {
    location: location.name,

    temperature:
      details.air_temperature ?? null,

    apparentTemperature: null,

    humidity:
      details.relative_humidity ?? null,

    precipitation:
      first.data?.next_1_hours
        ?.details
        ?.precipitation_amount ?? 0,

    rain:
      first.data?.next_1_hours
        ?.details
        ?.precipitation_amount ?? 0,

    precipitationProbabilityNext6h:
      probability,

    wind:
      details.wind_speed ?? null,

    windDirection:
      details.wind_from_direction ?? null,

    weatherCode: null,

    condition:
      "Datos meteorológicos alternativos",

    observedAt:
      first.time ||
      new Date().toISOString(),

    source: "MET Norway",

    cached: false
  };
}

/* =========================================================
   OBTENER CLIMA CON RESPALDO
   ========================================================= */

async function getWeather(location) {
  try {
    return await getOpenMeteo(location);
  } catch (openError) {
    console.warn(
      `[TARAVÍA] Open-Meteo falló para ${location.name}:`,
      openError.message
    );
  }

  try {
    return await getMetNorway(location);
  } catch (metError) {
    console.warn(
      `[TARAVÍA] MET Norway falló para ${location.name}:`,
      metError.message
    );
  }

  const cached =
    weatherCache.get(
      `openmeteo-${location.name}`
    );

  if (cached) {
    return {
      ...cached.data,
      cached: true,
      source: "Open-Meteo (caché)"
    };
  }

  throw new Error(
    `No hay datos meteorológicos disponibles para ${location.name}`
  );
}

/* =========================================================
   VIALIDAD
   No inventamos cortes ni accidentes.
   ========================================================= */

function roadSnapshot() {
  return {
    status: "requiere_verificacion_oficial",

    label:
      "Verificación oficial requerida",

    routes: [
      {
        code: "A-16",
        name: "Iquique – Alto Hospicio",
        priority: "alta",
        status: "Verificación oficial requerida"
      },
      {
        code: "A-1 / Ruta 1",
        name: "Eje costero y accesos",
        priority: "alta",
        status: "Verificación oficial requerida"
      },
      {
        code: "Ruta 5",
        name: "Conexión norte/sur",
        priority: "media",
        status: "Verificación oficial requerida"
      },
      {
        code: "A-504",
        name: "Accesos sector Iquique",
        priority: "media",
        status: "Verificación oficial requerida"
      },
      {
        code: "A-506",
        name: "Conexiones sectoriales",
        priority: "media",
        status: "Verificación oficial requerida"
      }
    ],

    checkedAt:
      new Date().toISOString(),

    sources: [
      {
        name: "SENAPRED",
        url: "https://senapred.cl/"
      },
      {
        name: "MOP",
        url: "https://www.mop.gob.cl/"
      }
    ]
  };
}

/* =========================================================
   RIESGO
   ========================================================= */

function calculateRisk(weatherItems) {
  let risk = 2;

  if (
    weatherItems.some(
      x =>
        Number(
          x.precipitationProbabilityNext6h
        ) >= 60
    )
  ) {
    risk = Math.max(risk, 5);
  }

  if (
    weatherItems.some(
      x => Number(x.wind) >= 45
    )
  ) {
    risk = Math.max(risk, 6);
  }

  if (
    weatherItems.some(
      x => Number(x.precipitation) >= 2
    )
  ) {
    risk = Math.max(risk, 6);
  }

  if (
    weatherItems.some(
      x =>
        typeof x.weatherCode === "number" &&
        [95, 96, 99].includes(
          x.weatherCode
        )
    )
  ) {
    risk = Math.max(risk, 8);
  }

  let label = "Bajo";

  if (risk >= 8) {
    label = "Muy alto";
  } else if (risk >= 6) {
    label = "Alto";
  } else if (risk >= 4) {
    label = "Moderado";
  }

  return {
    score: risk,
    label
  };
}

/* =========================================================
   RESUMEN GENERAL
   ========================================================= */

async function buildSummary() {
  const started = Date.now();

  const results =
    await Promise.allSettled([
      getWeather(LOCATIONS.iquique),
      getWeather(LOCATIONS.altoHospicio)
    ]);

  const weather = {
    iquique:
      results[0].status === "fulfilled"
        ? results[0].value
        : {
            error:
              results[0].reason?.message ||
              "Sin respuesta"
          },

    altoHospicio:
      results[1].status === "fulfilled"
        ? results[1].value
        : {
            error:
              results[1].reason?.message ||
              "Sin respuesta"
          }
  };

  const availableWeather = [
    weather.iquique,
    weather.altoHospicio
  ].filter(
    x => x && !x.error
  );

  const risk =
    calculateRisk(
      availableWeather
    );

  const weatherErrors = [
    weather.iquique?.error,
    weather.altoHospicio?.error
  ].filter(Boolean);

  const sourceStatus =
    SOURCES.map(source => ({
      ...source,

      status:
        source.automatic
          ? availableWeather.length > 0
            ? "ok"
            : "error"
          : "consulta_oficial"
    }));

  return {
    app: "TARAVÍA",

    version: "1.5.2",

    generatedAt:
      new Date().toISOString(),

    elapsedMs:
      Date.now() - started,

    weather,

    road:
      roadSnapshot(),

    sources:
      sourceStatus,

    risk,

    recommendation:
      risk.score >= 6
        ? "Precaución: revisa SENAPRED y MOP antes de desplazarte."
        : "Precaución normal. Revisa vialidad oficial antes de salir.",

    errors:
      weatherErrors
  };
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      app: "TARAVÍA",
      version: "1.5.2",
      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   DASHBOARD API
   ========================================================= */

app.get(
  "/api/dashboard",
  async (_req, res) => {
    try {
      const summary =
        await buildSummary();

      const weatherItems = [
        summary.weather?.iquique,
        summary.weather?.altoHospicio
      ].filter(
        x => x && !x.error
      );

      let temp = null;
      let humidity = null;
      let wind = null;
      let rain24 = null;
      let probability = null;

      if (weatherItems.length > 0) {
        temp =
          weatherItems.reduce(
            (sum, x) =>
              sum +
              Number(
                x.temperature ?? 0
              ),
            0
          ) /
          weatherItems.length;

        humidity =
          weatherItems.reduce(
            (sum, x) =>
              sum +
              Number(
                x.humidity ?? 0
              ),
            0
          ) /
          weatherItems.length;

        wind =
          Math.max(
            ...weatherItems.map(
              x =>
                Number(
                  x.wind ?? 0
                )
            )
          );

        rain24 =
          Math.max(
            ...weatherItems.map(
              x =>
                Number(
                  x.precipitation ?? 0
                )
            )
          );

        probability =
          Math.max(
            ...weatherItems.map(
              x =>
                Number(
                  x.precipitationProbabilityNext6h ??
                  0
                )
            )
          );
      }

      const availableSources =
        summary.sources.filter(
          x =>
            x.status === "ok"
        ).length;

      res.json({
        ok: true,

        version:
          summary.version,

        fetchedAt:
          summary.generatedAt,

        weather: {
          temp,
          humidity,
          wind,
          rain24,
          probability,

          score:
            summary.risk?.score ??
            null,

          locations:
            summary.weather,

          errors:
            summary.errors
        },

        mop: {
          incidents: 0,

          routes:
            summary.road?.routes ||
            [],

          items: [],

          status:
            "Verificación oficial requerida"
        },

        dmc: {
          configured: false,
          status:
            "Consulta oficial"
        },

        senapred: {
          configured: false,
          status:
            "Consulta oficial"
        },

        sources: {
          available:
            availableSources,

          total:
            SOURCES.length,

          items:
            summary.sources
        },

        errors:
          summary.errors,

        risk:
          summary.risk?.score ??
          null,

        riskBand:
          summary.risk?.label ??
          "SIN DATOS",

        recommendation:
          summary.recommendation,

        cached:
          weatherItems.some(
            x => x.cached === true
          )
      });
    } catch (error) {
      console.error(
        "DASHBOARD_ERROR",
        error
      );

      res.status(502).json({
        ok: false,

        error:
          "No se pudo completar el dashboard",

        detail:
          error.message
      });
    }
  }
);

/* =========================================================
   INICIO DEL SERVIDOR
   ========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `TARAVÍA escuchando en puerto ${PORT}`
    );
  }
);
