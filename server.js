const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LOCATIONS = {
  iquique: { name: "Iquique", latitude: -20.2141, longitude: -70.1524 },
  altoHospicio: { name: "Alto Hospicio", latitude: -20.2670, longitude: -70.1030 }
};

const CACHE_TIME = 5 * 60 * 1000;
const FAILURE_COOLDOWN = 10 * 60 * 1000;

let weatherCache = null;
let weatherCacheTime = 0;
let openMeteoBlockedUntil = 0;

function weatherLabel(code) {
  const labels = {
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

  return labels[code] || "Condición no especificada";
}

async function getOpenMeteo(location) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");

  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);

  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m"
  );

  url.searchParams.set(
    "hourly",
    "precipitation,precipitation_probability"
  );

  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "America/Santiago");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "TARAVIA/1.5 https://github.com/Rolyorellana/Taravia-"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo HTTP ${response.status}`);
  }

  const data = await response.json();

  const current = data.current || {};
  const hourly = data.hourly || {};

  const probs = Array.isArray(
    hourly.precipitation_probability
  )
    ? hourly.precipitation_probability
        .slice(0, 6)
        .map(Number)
        .filter(Number.isFinite)
    : [];

  const precipitation = Array.isArray(
    hourly.precipitation
  )
    ? hourly.precipitation
        .slice(0, 24)
        .map(Number)
        .filter(Number.isFinite)
    : [];

  return {
    location: location.name,
    temperature: current.temperature_2m ?? null,
    apparentTemperature:
      current.apparent_temperature ?? null,
    humidity:
      current.relative_humidity_2m ?? null,
    precipitation:
      current.precipitation ?? null,
    rain:
      current.rain ?? null,
    rain24: precipitation.length
      ? precipitation.reduce(
          (a, b) => a + b,
          0
        )
      : Number(current.precipitation || 0),
    precipitationProbabilityNext6h:
      probs.length ? Math.max(...probs) : null,
    wind:
      current.wind_speed_10m ?? null,
    windDirection:
      current.wind_direction_10m ?? null,
    weatherCode:
      current.weather_code ?? null,
    condition:
      weatherLabel(current.weather_code),
    observedAt:
      current.time ||
      new Date().toISOString(),
    source: "Open-Meteo"
  };
}

async function getMetNorway(location) {
  const url = new URL(
    "https://api.met.no/weatherapi/locationforecast/2.0/compact"
  );

  url.searchParams.set(
    "lat",
    location.latitude.toFixed(4)
  );

  url.searchParams.set(
    "lon",
    location.longitude.toFixed(4)
  );

  const response = await fetch(
    url.toString(),
    {
      headers: {
        "User-Agent":
          "TARAVIA/1.5 https://github.com/Rolyorellana/Taravia-"
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `MET Norway HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const series =
    data?.properties?.timeseries || [];

  if (!series.length) {
    throw new Error(
      "MET Norway sin datos"
    );
  }

  const now = Date.now();

  const closest = series.reduce(
    (best, item) => {
      const distance = Math.abs(
        new Date(item.time).getTime() -
          now
      );

      if (!best) {
        return {
          item,
          distance
        };
      }

      return distance < best.distance
        ? {
            item,
            distance
          }
        : best;
    },
    null
  );

  const first =
    closest?.item || series[0];

  const details =
    first?.data?.instant?.details ||
    {};

  const next1 =
    first?.data?.next_1_hours?.details ||
    {};

  const next6 =
    first?.data?.next_6_hours?.details ||
    {};

  const precipitation =
    next1.precipitation_amount ??
    next6.precipitation_amount ??
    0;

  const probability =
    next1.probability_of_precipitation ??
    next6.probability_of_precipitation ??
    0;

  const symbol =
    first?.data?.next_1_hours
      ?.summary?.symbol_code ||
    first?.data?.next_6_hours
      ?.summary?.symbol_code ||
    "";

  return {
    location: location.name,

    temperature:
      details.air_temperature ??
      null,

    apparentTemperature:
      null,

    humidity:
      details.relative_humidity ??
      null,

    precipitation,

    rain: precipitation,

    rain24: precipitation,

    precipitationProbabilityNext6h:
      probability,

    wind:
      details.wind_speed != null
        ? Number(details.wind_speed) * 3.6
        : null,

    windDirection:
      details.wind_from_direction ??
      null,

    weatherCode:
      null,

    condition:
      symbol ||
      "Pronóstico MET Norway",

    observedAt:
      first.time ||
      new Date().toISOString(),

    source: "MET Norway"
  };
}

async function fetchWeatherLocation(
  location
) {
  const now = Date.now();

  if (
    now >= openMeteoBlockedUntil
  ) {
    try {
      return await getOpenMeteo(
        location
      );
    } catch (error) {
      if (
        String(error.message).includes(
          "HTTP 429"
        )
      ) {
        openMeteoBlockedUntil =
          now + FAILURE_COOLDOWN;

        console.warn(
          "OPEN_METEO_429: usando MET Norway durante 10 minutos"
        );
      } else {
        console.warn(
          `OPEN_METEO_ERROR: ${error.message}`
        );
      }
    }
  }

  return getMetNorway(location);
}

async function getWeatherData() {
  const now = Date.now();

  if (
    weatherCache &&
    now - weatherCacheTime <
      CACHE_TIME
  ) {
    return {
      ...weatherCache,
      cached: true
    };
  }

  const results =
    await Promise.allSettled([
      fetchWeatherLocation(
        LOCATIONS.iquique
      ),
      fetchWeatherLocation(
        LOCATIONS.altoHospicio
      )
    ]);

  const iquique =
    results[0].status ===
    "fulfilled"
      ? results[0].value
      : {
          error:
            results[0].reason
              ?.message ||
            "Sin respuesta"
        };

  const altoHospicio =
    results[1].status ===
    "fulfilled"
      ? results[1].value
      : {
          error:
            results[1].reason
              ?.message ||
            "Sin respuesta"
        };

  const data = {
    iquique,
    altoHospicio,
    fetchedAt:
      new Date().toISOString(),
    cached: false
  };

  if (
    !iquique.error ||
    !altoHospicio.error
  ) {
    weatherCache = data;
    weatherCacheTime = now;
  }

  return data;
}

function calculateRisk(weather) {
  const items = [
    weather.iquique,
    weather.altoHospicio
  ].filter(
    x => x && !x.error
  );

  if (!items.length) {
    return {
      score: null,
      label: "SIN DATOS"
    };
  }

  let score = 2;

  if (
    items.some(
      x =>
        Number(
          x.precipitationProbabilityNext6h
        ) >= 60
    )
  ) {
    score = 5;
  }

  if (
    items.some(
      x => Number(x.wind) >= 45
    )
  ) {
    score = Math.max(
      score,
      6
    );
  }

  if (
    items.some(
      x => Number(x.rain24) >= 5
    )
  ) {
    score = Math.max(
      score,
      6
    );
  }

  let label = "Bajo";

  if (score >= 9) {
    label = "Crítico";
  } else if (score >= 7) {
    label = "Alto";
  } else if (score >= 5) {
    label = "Vigilancia alta";
  } else if (score >= 3) {
    label = "Vigilancia";
  }

  return {
    score,
    label
  };
}

function getRoutes() {
  return [
    {
      code: "A-16",
      name: "Iquique – Alto Hospicio",
      priority: "alta",
      status:
        "Verificación oficial requerida"
    },
    {
      code: "A-1 / Ruta 1",
      name: "Eje costero y accesos",
      priority: "alta",
      status:
        "Verificación oficial requerida"
    },
    {
      code: "Ruta 5",
      name: "Conexión norte/sur",
      priority: "media",
      status:
        "Verificación oficial requerida"
    },
    {
      code: "A-504",
      name: "Accesos sector Iquique",
      priority: "media",
      status:
        "Verificación oficial requerida"
    },
    {
      code: "A-506",
      name: "Conexiones sectoriales",
      priority: "media",
      status:
        "Verificación oficial requerida"
    }
  ];
}

async function buildDashboard() {
  const weather =
    await getWeatherData();

  const risk =
    calculateRisk(weather);

  const weatherItems = [
    weather.iquique,
    weather.altoHospicio
  ].filter(
    x => x && !x.error
  );

  const errors = [];

  if (!weatherItems.length) {
    errors.push("Clima");
  }

  const temp =
    weatherItems.length
      ? weatherItems.reduce(
          (sum, x) =>
            sum +
            Number(
              x.temperature || 0
            ),
          0
        ) / weatherItems.length
      : null;

  const humidity =
    weatherItems.length
      ? weatherItems.reduce(
          (sum, x) =>
            sum +
            Number(
              x.humidity || 0
            ),
          0
        ) / weatherItems.length
      : null;

  const wind =
    weatherItems.length
      ? Math.max(
          ...weatherItems.map(
            x =>
              Number(
                x.wind || 0
              )
          )
        )
      : null;

  const rain24 =
    weatherItems.length
      ? Math.max(
          ...weatherItems.map(
            x =>
              Number(
                x.rain24 || 0
              )
          )
        )
      : null;

  const probability =
    weatherItems.length
      ? Math.max(
          ...weatherItems.map(
            x =>
              Number(
                x.precipitationProbabilityNext6h ||
                  0
              )
          )
        )
      : null;

  let recommendation =
    "No se detecta una señal automática de riesgo alto.";

  if (risk.score === null) {
    recommendation =
      "Datos meteorológicos no disponibles.";
  } else if (
    risk.score >= 7
  ) {
    recommendation =
      "Revisa SENAPRED y MOP antes de desplazarte.";
  } else if (
    risk.score >= 5
  ) {
    recommendation =
      "Precaución. Revisa las condiciones de la ruta antes de salir.";
  }

  return {
    version: "1.6.0",

    fetchedAt:
      new Date().toISOString(),

    weather: {
      temp,
      humidity,
      wind,
      rain24,
      probability,
      score: risk.score,
      locations: weather,
      errors
    },

    mop: {
      incidents: 0,
      routes: getRoutes(),
      items: []
    },

    dmc: {
      configured: false,
      status: "Consulta oficial"
    },

    sources: [
      {
        id: "openMeteo",
        name: "Open-Meteo",
        status:
          openMeteoBlockedUntil >
          Date.now()
            ? "limitada; usando respaldo"
            : weatherItems.length
            ? "ok"
            : "error"
      },

      {
        id: "metNorway",
        name: "MET Norway",
        status:
          weatherItems.some(
            x =>
              x.source ===
              "MET Norway"
          )
            ? "ok"
            : "respaldo"
      },

      {
        id: "mop",
        name: "MOP Vialidad",
        status:
          "consulta_oficial"
      },

      {
        id: "dmc",
        name: "DMC",
        status:
          "consulta_oficial"
