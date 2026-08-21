const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

const CACHE_TIME = 5 * 60 * 1000;

let weatherCache = null;
let weatherCacheTime = 0;

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
    80: "Chubascos ligeros",
    81: "Chubascos moderados",
    82: "Chubascos intensos",
    95: "Tormenta",
    96: "Tormenta con granizo",
    99: "Tormenta fuerte con granizo"
  };

  return labels[code] || "Condición no especificada";
}

async function getWeather(location) {
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
      "User-Agent": "TARAVIA/1.5"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `Open-Meteo HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const current = data.current || {};
  const hourly = data.hourly || {};

  const probabilities =
    Array.isArray(hourly.precipitation_probability)
      ? hourly.precipitation_probability
          .slice(0, 6)
          .map(Number)
          .filter(Number.isFinite)
      : [];

  const precipitation =
    Array.isArray(hourly.precipitation)
      ? hourly.precipitation
          .slice(0, 24)
          .map(Number)
          .filter(Number.isFinite)
      : [];

  const probability = probabilities.length
    ? Math.max(...probabilities)
    : null;

  const rain24 = precipitation.length
    ? precipitation.reduce(
        (sum, value) => sum + value,
        0
      )
    : Number(current.precipitation || 0);

  return {
    location: location.name,
    temperature: current.temperature_2m ?? null,
    apparentTemperature: current.apparent_temperature ?? null,
    humidity: current.relative_humidity_2m ?? null,
    precipitation: current.precipitation ?? null,
    rain: current.rain ?? null,
    rain24: rain24,
    precipitationProbabilityNext6h: probability,
    wind: current.wind_speed_10m ?? null,
    windDirection: current.wind_direction_10m ?? null,
    weatherCode: current.weather_code ?? null,
    condition: weatherLabel(current.weather_code),
    observedAt: current.time || new Date().toISOString(),
    source: "Open-Meteo"
  };
}

async function getWeatherData() {
  const now = Date.now();

  if (
    weatherCache &&
    now - weatherCacheTime < CACHE_TIME
  ) {
    return {
      ...weatherCache,
      cached: true
    };
  }

  const results = await Promise.allSettled([
    getWeather(LOCATIONS.iquique),
    getWeather(LOCATIONS.altoHospicio)
  ]);

  const iquique =
    results[0].status === "fulfilled"
      ? results[0].value
      : {
          error:
            results[0].reason?.message ||
            "Sin respuesta"
        };

  const altoHospicio =
    results[1].status === "fulfilled"
      ? results[1].value
      : {
          error:
            results[1].reason?.message ||
            "Sin respuesta"
        };

  const data = {
    iquique,
    altoHospicio,
    fetchedAt: new Date().toISOString(),
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
    item =>
      item &&
      !item.error
  );

  if (!items.length) {
    return {
      score: null,
      label: "SIN DATOS"
    };
  }

  let score = 2;

  const highRainProbability =
    items.some(
      item =>
        Number(
          item.precipitationProbabilityNext6h
        ) >= 60
    );

  const highWind =
    items.some(
      item =>
        Number(item.wind) >= 45
    );

  const significantRain =
    items.some(
      item =>
        Number(item.rain24) >= 5
    );

  if (highRainProbability) {
    score = 5;
  }

  if (highWind) {
    score = Math.max(score, 6);
  }

  if (significantRain) {
    score = Math.max(score, 6);
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
  ];
}

async function buildDashboard() {
  const weather = await getWeatherData();

  const risk = calculateRisk(weather);

  const weatherItems = [
    weather.iquique,
    weather.altoHospicio
  ].filter(
    item =>
      item &&
      !item.error
  );

  const errors = [];

  if (!weatherItems.length) {
    errors.push("Open-Meteo");
  }

  const temp = weatherItems.length
    ? weatherItems.reduce(
        (sum, item) =>
          sum +
          Number(item.temperature || 0),
        0
      ) / weatherItems.length
    : null;

  const humidity = weatherItems.length
    ? weatherItems.reduce(
        (sum, item) =>
          sum +
          Number(item.humidity || 0),
        0
      ) / weatherItems.length
    : null;

  const wind = weatherItems.length
    ? Math.max(
        ...weatherItems.map(
          item =>
            Number(item.wind || 0)
        )
      )
    : null;

  const rain24 = weatherItems.length
    ? Math.max(
        ...weatherItems.map(
          item =>
            Number(item.rain24 || 0)
        )
      )
    : null;

  const probability = weatherItems.length
    ? Math.max(
        ...weatherItems.map(
          item =>
            Number(
              item.precipitationProbabilityNext6h || 0
            )
        )
      )
    : null;

  let recommendation =
    "No se detecta una señal automática de riesgo alto.";

  if (risk.score === null) {
    recommendation =
      "Datos meteorológicos no disponibles.";
  } else if (risk.score >= 7) {
    recommendation =
      "Revisa SENAPRED y MOP antes de desplazarte.";
  } else if (risk.score >= 5) {
    recommendation =
      "Precaución. Revisa las condiciones de la ruta antes de salir.";
  }

  return {
    version: "1.5.1",

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
      errors: errors
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
        status: weatherItems.length
          ? "ok"
          : "error"
      },
      {
        id: "mop",
        name: "MOP Vialidad",
        status: "consulta_oficial"
      },
      {
        id: "dmc",
        name: "DMC",
        status: "consulta_oficial"
      },
      {
        id: "senapred",
        name: "SENAPRED",
        status: "consulta_oficial"
      }
    ],

    errors,

    risk: risk.score,

    riskBand: risk.label,

    recommendation,

    cached: Boolean(weather.cached)
  };
}

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      app: "TARAVÍA",
      version: "1.5.1",
      time: new Date().toISOString()
    });
  }
);

app.get(
  "/api/dashboard",
  async (_req, res) => {
    try {
      const dashboard =
        await buildDashboard();

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(dashboard);

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

app.get(
  "/api/summary",
  async (_req, res) => {
    try {
      const dashboard =
        await buildDashboard();

      res.json(dashboard);

    } catch (error) {
      console.error(
        "SUMMARY_ERROR",
        error
      );

      res.status(502).json({
        ok: false,
        error:
          "No se pudo completar la consulta",
        detail:
          error.message
      });
    }
  }
);

app.get(
  "/api/sources",
  (_req, res) => {
    res.json([
      {
        id: "openMeteo",
        name: "Open-Meteo",
        url: "https://open-meteo.com/"
      },
      {
        id: "mop",
        name: "MOP",
        url: "https://www.mop.gob.cl/"
      },
      {
        id: "dmc",
        name: "DMC",
        url: "https://www.meteochile.gob.cl/"
      },
      {
        id: "senapred",
        name: "SENAPRED",
        url: "https://senapred.cl/"
      }
    ]);
  }
);

app.get(
  "/{*splat}",
  (_req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `TARAVÍA escuchando en puerto ${PORT}`
    );
  }
);
