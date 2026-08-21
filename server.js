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
  try {
    const data = await (await fetch(`http://127.0.0.1:${PORT}/api/dashboard`)).json();
    if (data.risk == null) return res.status(503).json({ok:false, message:"No hay suficientes fuentes para guardar un corte."});
    const row = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      risk: data.risk,
      weather: data.weather,
      roadScore: data.mop ? Math.max(0,...data.mop.routes.map(x=>x.score)) : null,
      dmc: data.dmc || null
    };
    const h = readHistory(); h.push(row); writeHistory(h);
    res.json({ok:true,row});
  } catch (e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

app.use((_req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => console.log(`TARAVÍA v1.4 listening on ${PORT}`));
