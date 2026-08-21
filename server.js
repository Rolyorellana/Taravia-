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

async function getJson(url, timeoutMs = 12000) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TARAVIA/1.4.1"
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

async function getWeather(location) {
  const url = new URL(
    "https://api.open-meteo.com/v1/forecast"
  );

  url.searchParams.set(
    "latitude",
    location.latitude
  );

  url.searchParams.set(
    "longitude",
    location.longitude
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

  const data = await getJson(url.toString());

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

  const probability =
    probabilities.length
      ? Math.max(...probabilities)
      : null;

  const rain24 =
    precipitation.length
      ? precipitation.reduce(
          (sum, value) => sum + value,
          0
        )
      : Number(current.precipitation ?? 0);

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
    rain24,
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
    source: "Open-Meteo"
  };
}

async function getMop() {
  const url =
    "https://rest-sit.mop.gob.cl/arcgis/rest/services/VIALIDAD/Emergencias_Vialidad/MapServer/0/query" +
    "?where=1%3D1&outFields=*&returnGeometry=false&f=json";

  const data = await getJson(url);

  return Array.isArray(data.features)
    ? data.features.map(
        feature => feature.attributes || {}
      )
    : [];
}

function clean(value) {
  return String(value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function riskBand(score) {
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

function roadScore(items) {
  if (!items.length) {
    return 0;
  }

  let score = 4;

  for (const item of items) {
    const text = clean(
      JSON.stringify(item)
    );

    if (
      /NO OPERATIVO|CORTADO|CERRADO/.test(text)
    ) {
      score = Math.max(score, 10);
    } else if (
      /PARCIAL|RESTRICC|DESVIO/.test(text)
    ) {
      score = Math.max(score, 7);
    }
  }

  return score;
}

function buildRoads(items) {
  return ROUTES.map(route => {
    const matches = items.filter(item => {
      const text = clean(
        Object.values(item).join(" ")
      );

      return route.keys.some(key =>
        text.includes(clean(key))
      );
    });

    const score = roadScore(matches);

    return {
      name: route.name,
      desc: route.desc,
      incidents: matches.length,
      score,
      status:
        matches.length
          ? riskBand(score)[0]
          : "SIN REPORTE"
    };
  });
}

async function buildSummary() {
  const started = Date.now();

  const [
    iquiqueResult,
    hospicioResult,
    mopResult
  ] = await Promise.allSettled([
    getWeather(LOCATIONS.iquique),
    getWeather(LOCATIONS.altoHospicio),
    getMop()
  ]);

  const weather = {
    iquique:
      iquiqueResult.status === "fulfilled"
        ? iquiqueResult.value
        : {
            error:
              iquiqueResult.reason?.message ||
              "Sin respuesta"
          },

    altoHospicio:
      hospicioResult.status === "fulfilled"
        ? hospicioResult.value
        : {
            error:
              hospicioResult.reason?.message ||
              "Sin respuesta"
          }
  };

  const mopItems =
    mopResult.status === "fulfilled"
      ? mopResult.value
      : [];

  const weatherItems = [
    weather.iquique,
    weather.altoHospicio
  ].filter(
    item => item && !item.error
  );

  let weatherRisk = 2;

  if (
    weatherItems.some(
      item =>
        Number(
          item.precipitationProbabilityNext6h
        ) >= 60
    )
  ) {
    weatherRisk = 5;
  }

  if (
    weatherItems.some(
      item => Number(item.wind) >= 45
    )
  ) {
    weatherRisk = Math.max(
      weatherRisk,
      6
    );
  }

  if (
    weatherItems.some(
      item => Number(item.rain24) >= 5
    )
  ) {
    weatherRisk = Math.max(
      weatherRisk,
      6
    );
  }

  const routes =
    buildRoads(mopItems);

  const roadRisk =
    routes.length
      ? Math.max(
          0,
          ...routes.map(
            route => route.score
          )
        )
      : 0;

  const overallRisk =
    Math.round(
      (
        (
          weatherRisk +
          Math.min(roadRisk, 10)
        ) / 2
      ) * 10
    ) / 10;

  const sources =
    SOURCES.map(source => ({
      ...source,

      status:
        source.id === "openMeteo"
          ? (
              weatherItems.length
                ? "ok"
                : "error"
            )

        : source.id === "mop"
          ? (
              mopResult.status ===
              "fulfilled"
                ? "ok"
                : "error"
            )

        : "consulta_oficial"
    }));

  return {
    app: "TARAVIA",
    version: "1.4.1",

    generatedAt:
      new Date().toISOString(),

    elapsedMs:
      Date.now() - started,

    locations: LOCATIONS,

    weather,

    road: {
      routes,
      checkedAt:
        new Date().toISOString()
    },

    roadItems:
      mopItems.slice(0, 30),

    sources,

    risk: {
      score: overallRisk,
      label:
        riskBand(overallRisk)[0]
    },

    recommendation:
      overallRisk >= 7
        ? "Revisa MOP y SENAPRED antes de desplazarte."
        : overallRisk >= 5
          ? "Precaucion: revisa vialidad oficial antes de salir."
          : "No se detecta una señal automatica de riesgo alto."
  };
}

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      app: "TARAVIA",
      version: "1.4.1",
      time:
        new Date().toISOString()
    });
  }
);

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
        item =>
          item &&
          !item.error
      );

      const temp =
        weatherItems.length
          ? weatherItems.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.temperature ?? 0
                ),
              0
            ) /
            weatherItems.length
          : null;

      const humidity =
        weatherItems.length
          ? weatherItems.reduce(
              (sum, item) =>
                sum +
                Number(
                  item.humidity ?? 0
                ),
              0
            ) /
            weatherItems.length
          : null;

      const wind =
        weatherItems.length
          ? Math.max(
              ...weatherItems.map(
                item =>
                  Number(
                    item.wind ?? 0
                  )
              )
            )
          : null;

      const rain24 =
        weatherItems.length
          ? Math.max(
              ...weatherItems.map(
                item =>
                  Number(
                    item.rain24 ?? 0
                  )
              )
            )
          : null;

      const probability =
        weatherItems.length
          ? Math.max(
              ...weatherItems.map(
                item =>
                  Number(
                    item.precipitationProbabilityNext6h ??
                    0
                  )
              )
            )
          : null;

      const weatherErrors = [
        summary.weather?.iquique?.error,
        summary.weather?.altoHospicio?.error
      ].filter(Boolean);

      const dmcConfigured =
        Boolean(
          process.env.DMC_USER &&
          process.env.DMC_TOKEN
        );

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json({
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
            weatherItems.length
              ? Math.max(
                  2,
                  ...weatherItems.map(
                    item =>
                      Number(
                        item.precipitationProbabilityNext6h ??
                        0
                      ) >= 60
                        ? 5
                        : Number(
                            item.wind ?? 0
                          ) >= 45
                          ? 6
                          : Number(
                              item.rain24 ?? 0
                            ) >= 5
                            ? 6
                            : 2
                  )
                )
              : null,

          locations:
            summary.weather,

          errors:
            weatherErrors
        },

        mop: {
          incidents:
            summary.roadItems.length,

          routes:
            summary.road.routes,

          items:
            summary.roadItems
        },

        dmc: {
          configured:
            dmcConfigured,

          status:
            dmcConfigured
              ? "Configurada"
              : "No configurada"
        },

        sources:
          summary.sources,

        errors:
          weatherErrors.concat(
            summary.sources.some(
              source =>
                source.id === "mop" &&
                source.status === "error"
            )
              ? ["MOP"]
              : []
          ),

        risk:
          summary.risk.score,

        riskBand:
          summary.risk.label,

        recommendation:
          summary.recommendation
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
          error.message,
        version: "1.4.1"
      });
    }
  }
);

app.get(
  "/api/summary",
  async (_req, res) => {
    try {
      const summary =
        await buildSummary();

      res.set(
        "Cache-Control",
        "no-store"
      );

      res.json(summary);

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
          error.message,
        version: "1.4.1"
      });
    }
  }
);

app.get(
  "/api/sources",
  (_req, res) => {
    res.json(SOURCES);
  }
);

app.get(
  "/{*splat}",
  (_req, res) => {
    res.sendFile(
      "index.html",
      {
        root:
          path.join(
            __dirname,
            "public"
          )
      }
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `TARAVIA listening on port ${PORT}`
    );
  }
);
