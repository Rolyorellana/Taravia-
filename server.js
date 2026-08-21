const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const HISTORY_FILE = path.join("/tmp", "taravia-history.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LOCATIONS = {
  iquique: { name: "Iquique", lat: -20.2141, lon: -70.1524 },
  hospicio: { name: "Alto Hospicio", lat: -20.2670, lon: -70.1000 }
};

const ROUTES = [
  { name: "A-16", keys: ["A-16", "RUTA 16"], desc: "Iquique ↔ Alto Hospicio" },
  { name: "A-616", keys: ["A-616", "A616"], desc: "Conexión Alto Hospicio" },
  { name: "A-504", keys: ["A-504", "A504"], desc: "Conexión Alto Hospicio" },
  { name: "A-506", keys: ["A-506", "A506"], desc: "Conexión sector Alto Hospicio" },
  { name: "Ruta 1 / A-1", keys: ["A-1", "RUTA 1"], desc: "Iquique ↔ Aeropuerto Diego Aracena" },
  { name: "Ruta 5", keys: ["RUTA 5"], desc: "Eje interior" }
];

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}
function writeHistory(rows) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  rows = rows.filter(x => x.ts >= cutoff).slice(-500);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(rows));
}
function clean(v) {
  return String(v ?? "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function roadScore(items) {
  let s = 0;
  for (const x of items) {
    const e = clean(JSON.stringify(x));
    if (/NO OPERATIVO|CORTADO|CERRADO/.test(e)) s = Math.max(s, 10);
    else if (/PARCIAL|RESTRICC/.test(e)) s = Math.max(s, 7);
    else s = Math.max(s, 4);
  }
  return s;
}
function riskBand(s) {
  if (s < 3) return ["BAJO", "green"];
  if (s < 5) return ["VIGILANCIA", "yellow"];
  if (s < 7) return ["VIGILANCIA ALTA", "orange"];
  if (s < 9) return ["ALTO", "orange"];
  return ["CRÍTICO", "red"];
}
async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "TARAVIA/1.4" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function weatherOne(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&timezone=America%2FSantiago&forecast_days=2` +
    `&current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m` +
    `&hourly=precipitation,precipitation_probability`;
  return getJson(url);
}
async function getWeather() {
  const [a,b] = await Promise.all([weatherOne(LOCATIONS.iquique), weatherOne(LOCATIONS.hospicio)]);
  const all = [a,b];
  const temp = all.reduce((s,x)=>s+x.current.temperature_2m,0)/all.length;
  const humidity = all.reduce((s,x)=>s+x.current.relative_humidity_2m,0)/all.length;
  const wind = Math.max(...all.map(x=>x.current.wind_speed_10m));
  const rain24 = Math.max(...all.map(x=>x.hourly.precipitation.slice(0,24).reduce((s,v)=>s+v,0)));
  const prob = Math.max(...all.map(x=>Math.max(...x.hourly.precipitation_probability.slice(0,24))));
  const met = rain24 > 10 ? 8 : rain24 > 5 ? 6 : rain24 > 1 ? 4 : 2;
  return { temp, humidity, wind, rain24, probability: prob, score: met, fetchedAt: new Date().toISOString() };
}
async function getMop() {
  const url = "https://rest-sit.mop.gob.cl/arcgis/rest/services/VIALIDAD/Emergencias_Vialidad/MapServer/0/query" +
    "?where=1%3D1&outFields=*&returnGeometry=false&f=json";
  const j = await getJson(url);
  return (j.features || []).map(x => x.attributes);
}
function buildRoads(items) {
  return ROUTES.map(r => {
    const matches = items.filter(x => r.keys.some(k => clean(Object.values(x).join(" ")).includes(clean(k))));
    const score = roadScore(matches);
    return { name:r.name, desc:r.desc, incidents:matches.length, score, status:matches.length ? riskBand(score)[0] : "SIN REPORTE" };
  });
}
async function getDmc() {
  const user = process.env.DMC_USER;
  const token = process.env.DMC_TOKEN;
  if (!user || !token) return { configured:false, status:"No configurada" };
  const url = "https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesRedEma" +
    `?usuario=${encodeURIComponent(user)}&token=${encodeURIComponent(token)}`;
  try {
    const j = await getJson(url);
    const rows = j.datosEstaciones || [];
    const st = rows.find(x => /iquique|diego aracena|cavancha|los condores|unap/i.test(x.estacion?.nombreEstacion || ""));
    const d = st?.datos?.[0];
    if (!d) return { configured:true, status:"Sin dato local reciente" };
    const raw = d.temperatura02Mts ?? d.temperatura;
    const m = String(raw ?? "").match(/-?\d+(?:\.\d+)?/);
    return { configured:true, status:"Conectada", station:st.estacion.nombreEstacion, temperature:m ? Number(m[0]) : null, moment:d.momento || null };
  } catch (e) {
    return { configured:true, status:"No disponible" };
  }
}

app.get("/api/health", (_req,res) => res.json({ok:true, version:"1.4.0", time:new Date().toISOString()}));

app.get("/api/dashboard", async (_req,res) => {
  const result = { version:"1.4.0", fetchedAt:new Date().toISOString(), weather:null, mop:null, dmc:null, errors:[] };
  const [w,m,d] = await Promise.allSettled([getWeather(), getMop(), getDmc()]);
  if (w.status === "fulfilled") result.weather = w.value; else result.errors.push("Open-Meteo");
  if (m.status === "fulfilled") {
    result.mop = { incidents:m.value.length, routes:buildRoads(m.value), items:m.value.slice(0,30) };
  } else result.errors.push("MOP");
  if (d.status === "fulfilled") result.dmc = d.value; else result.errors.push("DMC");

  const ms = result.weather?.score;
  const rs = result.mop ? Math.max(0, ...result.mop.routes.map(x=>x.score)) : null;
  result.risk = (ms != null && rs != null) ? Math.round(((ms + Math.min(rs,10))/2)*10)/10 : null;
  if (result.risk != null) result.riskBand = riskBand(result.risk)[0];
  res.json(result);
});

app.get("/api/history", (_req,res) => res.json(readHistory()));

app.post("/api/snapshot", async (_req,res) => {
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

app.get("/api/summary", async (req, res) => {
  try {
    const summary = await buildSummary();
    res.set("Cache-Control", "no-store");
    res.json(summary);
  } catch (error) {
    console.error("SUMMARY_ERROR", error);
    res.status(502).json({
      ok: false,
      error: "No se pudo completar la consulta",
      detail: error.message,
      version: "1.4.1"
    });
  }
});

app.get("/api/sources", (req, res) => {
  res.json(SOURCES);
});

app.get("*", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TARAVÍA v1.4.1 listening on port ${PORT}`);
});
