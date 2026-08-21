const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static("public"));

const LOCATIONS = {
  iquique: { name: "Iquique", latitude: -20.2141, longitude: -70.1524 },
  altoHospicio: { name: "Alto Hospicio", latitude: -20.2670, longitude: -70.1030 }
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
    name: "Dirección Meteorológica de Chile",
    type: "meteorologia",
    url: "https://www.meteochile.gob.cl/",
    automatic: false
  },
  {
    id: "mop",
    name: "Ministerio de Obras Públicas",
    type: "vialidad",
    url: "https://www.mop.gob.cl/",
    automatic: false
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
  return map[code] || "Condición no especificada";
}

function withTimeout(url, ms = 9000) {
  return fetch(url, {
    headers: { "User-Agent": "TARAVIA/1.4.1" },
    signal: AbortSignal.timeout(ms)
  });
}

async function getWeather(location) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m"
  );
  url.searchParams.set("hourly", "precipitation_probability");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "America/Santiago");

  const response = await withTimeout(url.toString());
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const data = await response.json();

  const current = data.current || {};
  const probability = Array.isArray(data.hourly?.precipitation_probability)
    ? Math.max(...data.hourly.precipitation_probability.slice(0, 6).map(Number).filter(Number.isFinite), 0)
    : null;

  return {
    location: location.name,
    temperature: current.temperature_2m ?? null,
    apparentTemperature: current.apparent_temperature ?? null,
    humidity: current.relative_humidity_2m ?? null,
    precipitation: current.precipitation ?? null,
    rain: current.rain ?? null,
    precipitationProbabilityNext6h: probability,
    wind: current.wind_speed_10m ?? null,
    windDirection: current.wind_direction_10m ?? null,
    weatherCode: current.weather_code ?? null,
    condition: cToLabel(current.weather_code),
    observedAt: current.time || new Date().toISOString(),
    source: "Open-Meteo"
  };
}

function roadSnapshot() {
  // This intentionally does NOT invent live road conditions.
  // Until an official machine-readable road-status feed is connected,
  // TARAVIA reports the routes that must be checked and links to official sources.
  return {
    status: "requiere_verificacion_oficial",
    label: "Verificación oficial requerida",
    routes: [
      { code: "A-16", name: "Iquique – Alto Hospicio", priority: "alta" },
      { code: "A-1 / Ruta 1", name: "Eje costero y accesos", priority: "alta" },
      { code: "Ruta 5", name: "Conexión hacia el sur/norte", priority: "media" },
      { code: "A-504", name: "Accesos y conexión sector Iquique", priority: "media" },
      { code: "A-506", name: "Conexiones sectoriales", priority: "media" },
      { code: "Aeropuerto Diego Aracena", name: "Acceso aeroportuario", priority: "media" }
    ],
    checkedAt: new Date().toISOString(),
    sources: [
      { name: "SENAPRED", url: "https://senapred.cl/" },
      { name: "MOP", url: "https://www.mop.gob.cl/" }
    ]
  };
}

async function buildSummary() {
  const started = Date.now();

  const weatherResults = await Promise.allSettled([
    getWeather(LOCATIONS.iquique),
    getWeather(LOCATIONS.altoHospicio)
  ]);

  const weather = {
    iquique: weatherResults[0].status === "fulfilled"
      ? weatherResults[0].value
      : { error: weatherResults[0].reason?.message || "Sin respuesta" },
    altoHospicio: weatherResults[1].status === "fulfilled"
      ? weatherResults[1].value
      : { error: weatherResults[1].reason?.message || "Sin respuesta" }
  };

  const availableWeather = [weather.iquique, weather.altoHospicio]
    .filter(x => x && !x.error);

  let risk = 2;
  if (availableWeather.some(x => Number(x.precipitationProbabilityNext6h) >= 60)) risk = 5;
  if (availableWeather.some(x => Number(x.wind) >= 45)) risk = Math.max(risk, 6);
  if (availableWeather.some(x => Number(x.precipitation) >= 2)) risk = Math.max(risk, 6);

  const sourceStatus = SOURCES.map(s => ({
    ...s,
    status: s.automatic ? (availableWeather.length ? "ok" : "error") : "consulta_oficial"
  }));

  return {
    app: "TARAVÍA",
    version: "1.4.1",
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    locations: LOCATIONS,
    weather,
    road: roadSnapshot(),
    sources: sourceStatus,
    risk: {
      score: risk,
      label: risk <= 3 ? "Bajo" : risk <= 5 ? "Moderado" : risk <= 7 ? "Alto" : "Muy alto"
    },
    recommendation:
      risk >= 6
        ? "Revisa SENAPRED y MOP antes de desplazarte."
        : "Condiciones meteorológicas sin señal automática de riesgo alto; revisa vialidad oficial antes de salir."
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "TARAVÍA",
    version: "1.4.1",
    time: new Date().toISOString()
  });
});

app.get("/api/dashboard", async (_req, res) => {
    const s = await buildSummary();

    const weatherItems = [
      s.weather?.iquique,
      s.weather?.altoHospicio
    ].filter(x => x && !x.error);

    let temp = null;
    let humidity = null;
    let wind = null;
    let rain24 = null;
    let probability = null;

    if (weatherItems.length > 0) {
      temp =
        weatherItems.reduce(
          (sum, x) => sum + Number(x.temperature ?? 0),
          0
        ) / weatherItems.length;

      humidity =
        weatherItems.reduce(
          (sum, x) => sum + Number(x.humidity ?? 0),
          0
        ) / weatherItems.length;

      wind = Math.max(
        ...weatherItems.map(x => Number(x.wind ?? 0))
      );

      rain24 = Math.max(
        ...weatherItems.map(x => Number(x.precipitation ?? 0))
      );

      probability = Math.max(
        ...weatherItems.map(
          x => Number(x.precipitationProbabilityNext6h ?? 0)
        )
      );
    }

    const weatherErrors = [
      s.weather?.iquique?.error,
      s.weather?.altoHospicio?.error
    ].filter(Boolean);

    res.json({
      version: s.version,
      fetchedAt: s.generatedAt,

      weather: {
        temp,
        humidity,
        wind,
        rain24,
        probability,
        score: s.risk?.score ?? null,
        locations: s.weather,
        errors: weatherErrors
      },

      mop: {
        incidents: 0,
        routes: s.road?.routes || [],
        items: []
      },

      dmc: {
        configured: false,
        status: "Consulta oficial"
      },

      errors: weatherErrors,

      risk: s.risk?.score ?? null,
      riskBand: s.risk?.label ?? "SIN DATOS"
    });

  } catch (error) {
    console.error("DASHBOARD_ERROR", error);

    res.status(502).json({
      ok: false,
      error: "No se pudo completar el dashboard",
      detail: error.message
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TARAVÍA escuchando en puerto ${PORT}`);
});
