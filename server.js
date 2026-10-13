'use strict';
// Ecowitt monitor: an Ecowitt weather station, as Home Assistant sees it (the core `ecowitt` integration), served to
// the Ecowitt card and a standalone dashboard: live readings, today's highs and lows, the pressure trend, history up
// to a year (from HA's long-term statistics), and alerts (wind gusts, heavy rain, frost, falling pressure, the station
// going quiet, low sensor batteries) through a Home Assistant webhook and/or ntfy.
// No dependencies (Node 22's built-in WebSocket). Settings and the alert log persist in data/.

const http = require('http');
const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {}

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => (env(k) !== '' && Number.isFinite(Number(env(k))) ? Number(env(k)) : d);
const PORT = num('PORT', 7120);
const HA_URL = env('HA_URL', 'http://homeassistant.local:8123').replace(/\/+$/, '');
const HA_TOKEN = env('HA_TOKEN');
const STATION = env('STATION'); // optional: which station, when HA has more than one (the start of its sensors' unique IDs)
const HA_WEBHOOK = env('HA_WEBHOOK');
// ntfy (https://ntfy.sh, or your own server): phone alerts without Home Assistant's companion app. NTFY_URL is the
// topic URL; NTFY_TOKEN only for a protected server or topic.
const NTFY_URL = env('NTFY_URL');
const NTFY_TOKEN = env('NTFY_TOKEN');
const DASHBOARD_URL = env('DASHBOARD_URL'); // where tapping an ntfy alert goes
const AUTH = require('./auth')(env('ADMIN_PASSWORD'), 'ecowitt-monitor', env('ADMIN_TRUSTED_IPS'));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return d;
  }
};
const writeJson = (f, v) => {
  try {
    fs.writeFileSync(f + '.tmp', JSON.stringify(v));
    fs.renameSync(f + '.tmp', f);
  } catch (e) {
    log('write failed', f, e.message);
  }
};

// ---- the station's sensors -----------------------------------------------------------------------------------------
// HA's ecowitt sensors have unique IDs "<station>-<field>", the field being the Ecowitt protocol's own name (tempc,
// windgustkmh...). Each reading here lists the fields that can carry it (metric first); values are converted to
// metric whatever unit HA shows them in.
const FIELDS = {
  outT: ['tempc', 'tempf'], inT: ['tempinc', 'tempinf'], feels: ['tempfeelsc', 'tempfeelsf'], chill: ['windchillc', 'windchillf'],
  dew: ['dewpointc', 'dewpointf'], inDew: ['dewpointinc', 'dewpointinf'], outH: ['humidity'], inH: ['humidityin'],
  wind: ['windspeedkmh', 'windspeedmph'], gust: ['windgustkmh', 'windgustmph'], gustMax: ['maxdailygustkmh', 'maxdailygust'],
  dir: ['winddir'], rainRate: ['rainratemm', 'rainratein'], rainEvent: ['eventrainmm', 'eventrainin'],
  rainHour: ['hourlyrainmm', 'hourlyrainin'], rainDay: ['dailyrainmm', 'dailyrainin'], rainWeek: ['weeklyrainmm', 'weeklyrainin'],
  rainMonth: ['monthlyrainmm', 'monthlyrainin'], rainYear: ['yearlyrainmm', 'yearlyrainin'],
  press: ['baromrelhpa', 'baromrelin'], pressAbs: ['baromabshpa', 'baromabsin'],
  solar: ['solarradiation'], uv: ['uv'], lux: ['solarradiation_lux'],
};
const UNIT = { outT: '°C', inT: '°C', feels: '°C', chill: '°C', dew: '°C', inDew: '°C', outH: '%', inH: '%', wind: 'km/h', gust: 'km/h', gustMax: 'km/h', dir: '°', rainRate: 'mm/h', rainEvent: 'mm', rainHour: 'mm', rainDay: 'mm', rainWeek: 'mm', rainMonth: 'mm', rainYear: 'mm', press: 'hPa', pressAbs: 'hPa', solar: 'W/m²', uv: '', lux: 'lx' };

function toMetric(v, unit) {
  switch ((unit || '').toLowerCase()) {
    case '°f': return ((v - 32) * 5) / 9;
    case 'k': return v - 273.15;
    case 'mph': return v * 1.609344;
    case 'm/s': return v * 3.6;
    case 'kn': case 'kt': return v * 1.852;
    case 'ft/s': return v * 1.09728;
    case 'in': return v * 25.4;
    case 'in/h': return v * 25.4;
    case 'cm': return v * 10;
    case 'inhg': return v * 33.8639;
    case 'pa': return v / 100;
    case 'kpa': return v * 10;
    case 'mbar': case 'mmhg': return unit.toLowerCase() === 'mmhg' ? v * 1.33322 : v;
    case 'psi': return v * 68.9476;
    default: return v;
  }
}

// ---- stations ----------------------------------------------------------------------------------------------------
// One or more stations, each read from its own Home Assistant. In .env either HA_URL / HA_TOKEN (one station), or
// STATION_1_NAME, STATION_1_HA_URL, STATION_1_HA_TOKEN (STATION_1_ID to pick one of several stations in that HA),
// STATION_2_..., and so on.
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'station';
const STATION_CONFIG = [];
for (let i = 1; i <= 9; i++) {
  const url = env(`STATION_${i}_HA_URL`), token = env(`STATION_${i}_HA_TOKEN`);
  if (url || token) STATION_CONFIG.push({ name: env(`STATION_${i}_NAME`, `Station ${i}`), url, token, match: env(`STATION_${i}_ID`) });
}
if (!STATION_CONFIG.length) STATION_CONFIG.push({ name: env('STATION_NAME', ''), url: HA_URL, token: HA_TOKEN, match: STATION });

const RANGES = {
  '6h': { ms: 6 * 3600e3, period: '5minute', cache: 60e3 },
  '24h': { ms: 24 * 3600e3, period: '5minute', cache: 120e3 },
  '7d': { ms: 7 * 864e5, period: 'hour', cache: 600e3 },
  '30d': { ms: 30 * 864e5, period: 'hour', cache: 1800e3 },
  '1y': { ms: 365 * 864e5, period: 'day', cache: 3 * 3600e3 },
};
const SERIES = { outT: ['mean', 'min', 'max'], inT: ['mean', 'min', 'max'], outH: ['mean'], inH: ['mean'], wind: ['mean', 'max'], gust: ['max'], press: ['mean'], rainMonth: ['change'] };

class Station {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.id = slug(cfg.name || 'station');
    this.url = (cfg.url || '').replace(/\/+$/, '');
    this.sensors = {}; // key -> entity_id
    this.units = {}; // entity_id -> unit shown in HA
    this.batteries = []; // [{ entity_id, name }]
    this.batteryLow = {};
    this.live = {}; // key -> { v, t }
    this.lastData = 0;
    this.pressHist = []; // [t, hPa], last 6 h
    this.ws = null;
    this.wsId = 1;
    this.pending = new Map();
    this.connected = false;
    this.error = '';
    this.reconnectMs = 2000;
    this.subId = 0;
    this.histCache = new Map();
    this.todayCache = null;
    this.device = '';
  }

  call(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1 || !this.connected) return reject(new Error(`${this.name}: Home Assistant not connected${this.error ? ` (${this.error})` : ''}`));
      const id = this.wsId++;
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: Home Assistant timed out`));
      }, timeoutMs);
      this.pending.set(id, (m) => (clearTimeout(to), m.success === false ? reject(new Error(m.error?.message || 'HA error')) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  connect() {
    if (!this.url || !this.cfg.token) {
      this.error = 'no Home Assistant address or token in .env';
      log(this.name + ':', this.error);
      return;
    }
    try {
      this.ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/api/websocket');
    } catch (e) {
      this.error = e.message;
      return setTimeout(() => this.connect(), this.reconnectMs);
    }
    const ws = this.ws;
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: this.cfg.token }));
      if (m.type === 'auth_invalid') {
        this.error = 'Home Assistant refused the token';
        log(this.name + ':', this.error);
        return;
      }
      if (m.type === 'auth_ok') {
        this.connected = true;
        this.error = '';
        this.reconnectMs = 2000;
        log(`${this.name}: connected to Home Assistant ${m.ha_version} at ${this.url}`);
        try {
          await this.setup();
        } catch (e) {
          this.error = e.message;
          log(this.name + ': setup failed:', e.message);
        }
        return;
      }
      if (m.type === 'event' && m.id === this.subId) return this.onEntities(m.event);
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p(m);
      }
    };
    ws.onclose = () => {
      if (this.connected) log(this.name + ': Home Assistant connection closed');
      this.connected = false;
      for (const p of this.pending.values()) p({ success: false, error: { message: 'connection closed' } });
      this.pending.clear();
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(60000, this.reconnectMs * 2);
    };
    ws.onerror = () => {
      this.error = `can't reach Home Assistant at ${this.url}`;
    };
  }

  async setup() {
    const reg = await this.call({ type: 'config/entity_registry/list' });
    const eco = reg.filter((e) => e.platform === 'ecowitt' && !e.disabled_by);
    const ids = [...new Set(eco.map((e) => e.unique_id.split('-')[0]))];
    const sid = this.cfg.match ? ids.find((s) => s.startsWith(this.cfg.match)) : ids[0];
    if (!sid) throw new Error(ids.length ? `no Ecowitt station matches ${this.cfg.match}` : 'this Home Assistant has no Ecowitt sensors (add the Ecowitt integration)');
    if (ids.length > 1 && !this.cfg.match) log(`${this.name}: ${ids.length} stations in this HA; using ${sid} (set its _ID to pick another)`);
    const mine = eco.filter((e) => e.unique_id.startsWith(sid + '-'));
    const byField = Object.fromEntries(mine.map((e) => [e.unique_id.slice(sid.length + 1), e.entity_id]));
    this.sensors = {};
    for (const [k, cands] of Object.entries(FIELDS)) {
      const f = cands.find((c) => byField[c]);
      if (f) this.sensors[k] = byField[f];
    }
    this.batteries = mine.filter((e) => /batt/i.test(e.unique_id) && e.entity_id.startsWith('binary_sensor.')).map((e) => ({ entity_id: e.entity_id, name: e.original_name || e.unique_id.split('-').pop() }));
    const devs = await this.call({ type: 'config/device_registry/list' });
    const dev = devs.find((d) => d.id === mine[0]?.device_id);
    this.device = dev ? dev.name_by_user || dev.name || '' : '';
    if (!this.name) this.name = this.device || 'Ecowitt';
    log(`${this.name}: ${this.device}, ${Object.keys(this.sensors).length} readings, ${this.batteries.length} batteries`);
    const subscribe = [...Object.values(this.sensors), ...this.batteries.map((b) => b.entity_id)];
    this.subId = this.wsId++;
    this.ws.send(JSON.stringify({ id: this.subId, type: 'subscribe_entities', entity_ids: subscribe }));
    this.histCache.clear();
    this.todayCache = null;
    await this.seedPressure().catch((e) => log(this.name + ': pressure history:', e.message));
  }

  keyOf(eid) {
    return Object.keys(this.sensors).find((k) => this.sensors[k] === eid);
  }

  onEntities(ev) {
    const now = Date.now();
    for (const [eid, s] of Object.entries(ev.a || {})) {
      if (s.a?.unit_of_measurement) this.units[eid] = s.a.unit_of_measurement;
      this.apply(eid, s.s, (s.lu || s.lc || now / 1000) * 1000);
    }
    for (const [eid, d] of Object.entries(ev.c || {})) {
      const p = d['+'];
      if (!p) continue;
      if (p.a?.unit_of_measurement) this.units[eid] = p.a.unit_of_measurement;
      if (p.s !== undefined) this.apply(eid, p.s, (p.lu || p.lc || now / 1000) * 1000);
      else if (p.lu) {
        const k = this.keyOf(eid);
        if (k && this.live[k]) this.live[k].t = p.lu * 1000;
        this.lastData = Math.max(this.lastData, p.lu * 1000);
      }
    }
    scheduleCheck(this);
  }

  apply(eid, state, t) {
    if (this.batteries.some((b) => b.entity_id === eid)) {
      this.batteryLow[eid] = state === 'on';
      return;
    }
    const k = this.keyOf(eid);
    if (!k) return;
    const n = Number(state);
    if (state === 'unknown' || state === 'unavailable' || state === '' || !Number.isFinite(n)) {
      this.live[k] = { v: null, t };
      return;
    }
    const v = Math.round(toMetric(n, this.units[eid]) * 100) / 100;
    this.live[k] = { v, t };
    this.lastData = Math.max(this.lastData, t);
    if (k === 'press') {
      this.pressHist.push([t, v]);
      while (this.pressHist.length && t - this.pressHist[0][0] > 6 * 3600e3) this.pressHist.shift();
    }
  }

  v(k) {
    return this.live[k]?.v;
  }

  // The last few hours of pressure from HA, so the trend is right straight after a restart.
  async seedPressure() {
    const id = this.sensors.press;
    if (!id) return;
    const r = await this.call({ type: 'recorder/statistics_during_period', start_time: new Date(Date.now() - 4 * 3600e3).toISOString(), statistic_ids: [id], period: '5minute', types: ['mean'] });
    const old = (r[id] || []).filter((x) => Number.isFinite(x.mean)).map((x) => [x.start + 150e3, Math.round(toMetric(x.mean, this.units[id]) * 100) / 100]);
    this.pressHist.unshift(...old.filter((x) => !this.pressHist.length || x[0] < this.pressHist[0][0]));
  }

  // Pressure change over the last 3 hours (hPa).
  pressTrend() {
    const now = this.v('press');
    if (!Number.isFinite(now) || !this.pressHist.length) return null;
    const tNow = Date.now(), want = 3 * 3600e3;
    let best = null;
    for (const [t, v] of this.pressHist) {
      const age = tNow - t;
      if (age >= 2.75 * 3600e3 && age <= 3.5 * 3600e3 && (!best || Math.abs(age - want) < Math.abs(tNow - best[0] - want))) best = [t, v];
    }
    return best ? Math.round((now - best[1]) * 10) / 10 : null;
  }

  // History from HA's statistics: 6 h / 24 h from the 5-minute statistics (kept for the recorder's purge_keep_days,
  // 10 by default), 7 d / 30 d hourly, 1 y daily. Temperatures with min and max per bucket; wind as the mean speed
  // and the highest gust; rain as the change in the monthly total. That one tracks the yearly total exactly, where the
// daily total's statistics missed rain on some days; a negative change (a counter reset HA misread, or bad data) is
// dropped, since rain can't be negative.
  async history(range) {
    const R = RANGES[range];
    if (!R) throw new Error('range must be one of ' + Object.keys(RANGES).join(', '));
    const c = this.histCache.get(range);
    if (c && Date.now() - c.at < R.cache) return c.data;
    const keys = Object.keys(SERIES).filter((k) => this.sensors[k]);
    const end = Date.now(), start = end - R.ms;
    const r = await this.call({
      type: 'recorder/statistics_during_period', start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
      statistic_ids: keys.map((k) => this.sensors[k]), period: R.period, types: ['mean', 'min', 'max', 'change'],
    }, 60000);
    const t = [...new Set(keys.flatMap((k) => (r[this.sensors[k]] || []).map((x) => x.start)))].sort((a, b) => a - b);
    const idx = new Map(t.map((x, i) => [x, i]));
    const series = {};
    for (const k of keys) {
      const u = this.units[this.sensors[k]];
      const out = Object.fromEntries(SERIES[k].map((f) => [f, new Array(t.length).fill(null)]));
      for (const x of r[this.sensors[k]] || []) {
        const i = idx.get(x.start);
        for (const f of SERIES[k]) if (Number.isFinite(x[f])) out[f][i] = f === 'change' && x[f] < 0 ? 0 : Math.round(toMetric(x[f], u) * 100) / 100;
      }
      series[k] = out;
    }
    const data = { station: this.id, range, period: R.period, start, end, t, series, units: Object.fromEntries(keys.map((k) => [k, UNIT[k]])) };
    this.histCache.set(range, { at: Date.now(), data });
    return data;
  }

  // Today's highs and lows (local midnight on): the 5-minute statistics so far, plus the live value.
  async today() {
    if (!this.todayCache || Date.now() - this.todayCache.at > 120e3) {
      const mid = new Date();
      mid.setHours(0, 0, 0, 0);
      const keys = ['outT', 'inT', 'outH', 'gust', 'press'].filter((k) => this.sensors[k]);
      const r = await this.call({ type: 'recorder/statistics_during_period', start_time: mid.toISOString(), statistic_ids: keys.map((k) => this.sensors[k]), period: '5minute', types: ['min', 'max'] });
      const data = {};
      for (const k of keys) {
        const rows = r[this.sensors[k]] || [], u = this.units[this.sensors[k]];
        const mins = rows.map((x) => x.min).filter(Number.isFinite), maxs = rows.map((x) => x.max).filter(Number.isFinite);
        data[k] = { min: mins.length ? toMetric(Math.min(...mins), u) : null, max: maxs.length ? toMetric(Math.max(...maxs), u) : null };
      }
      this.todayCache = { at: Date.now(), data };
    }
    const out = {};
    for (const [k, x] of Object.entries(this.todayCache.data)) {
      const v = this.v(k);
      const lo = [x.min, v].filter(Number.isFinite), hi = [x.max, v].filter(Number.isFinite);
      out[k] = { min: lo.length ? Math.round(Math.min(...lo) * 10) / 10 : null, max: hi.length ? Math.round(Math.max(...hi) * 10) / 10 : null };
    }
    return out;
  }

  snapshot() {
    return {
      station: this.id, name: this.name, device: this.device, ha: this.connected, error: this.error || null,
      updated: this.lastData || null, age: this.lastData ? Math.round((Date.now() - this.lastData) / 1000) : null,
      values: Object.fromEntries(Object.keys(this.sensors).map((k) => [k, this.live[k]?.v ?? null])),
      units: Object.fromEntries(Object.keys(this.sensors).map((k) => [k, UNIT[k]])),
      pressTrend3h: this.pressTrend(),
      batteries: this.batteries.map((b) => ({ name: b.name, low: !!this.batteryLow[b.entity_id] })),
    };
  }
}

const STATIONS = STATION_CONFIG.map((c) => new Station(c));
// Unique ids even if two names slug the same.
STATIONS.forEach((s, i) => {
  if (STATIONS.findIndex((x) => x.id === s.id) !== i) s.id += '-' + (i + 1);
});
const stationOf = (id) => STATIONS.find((s) => s.id === id) || STATIONS[0];

// ---- alerts ------------------------------------------------------------------------------------------------------
const DEFAULTS = {
  gust: { on: true, kmh: 60 }, // a gust at or above this
  rainRate: { on: true, mmh: 15 }, // heavy rain: rain rate at or above this
  rainDay: { on: true, mm: 30 }, // a wet day: today's rain reaches this (once a day)
  frost: { on: true, c: 0 }, // outdoor temperature at or below this
  heat: { on: false, c: 30 }, // outdoor temperature at or above this
  pressure: { on: true, hpa: 4 }, // pressure falling this much in 3 hours (a storm coming)
  offline: { on: true, min: 20 }, // no readings from the station for this long
  battery: { on: true }, // a sensor reports a low battery
  cooldownHours: 6, // the same alert at most this often
};
let settings = mergeSettings(DEFAULTS, readJson(SETTINGS_FILE, {}));
let alerts = readJson(ALERTS_FILE, []);
const state = readJson(path.join(DATA_DIR, 'alert-state.json'), {}); // "<station>:<kind>" -> { armed, firedAt, day }
const saveState = () => writeJson(path.join(DATA_DIR, 'alert-state.json'), state);

// Thresholds are shared; `stations` turns alerts on or off per station (all on unless listed as false).
function mergeSettings(base, p) {
  const out = JSON.parse(JSON.stringify(base));
  out.stations = { ...(base.stations || {}) };
  for (const [k, v] of Object.entries(p || {})) {
    if (k === 'cooldownHours') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n <= 168) out.cooldownHours = n;
    } else if (k === 'stations' && v && typeof v === 'object') {
      for (const [id, on] of Object.entries(v)) if (typeof on === 'boolean') out.stations[id] = on;
    } else if (out[k] && v && typeof v === 'object') {
      for (const [f, x] of Object.entries(v)) {
        if (f === 'on' && typeof x === 'boolean') out[k].on = x;
        else if (f in out[k] && f !== 'on' && Number.isFinite(Number(x))) out[k][f] = Number(x);
      }
    }
  }
  return out;
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? (Math.round(v * 10 ** d) / 10 ** d).toString() : '?');
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => (Number.isFinite(deg) ? COMPASS[Math.round(deg / 22.5) % 16] : '');

// One rule: fires when `cond` holds, it's armed and out of cooldown; re-arms once `clear` holds.
function rule(st, kind, cond, clear, make) {
  const key = `${st.id}:${kind}`;
  const s = (state[key] ||= { armed: true, firedAt: 0 });
  if (cond && s.armed && Date.now() - s.firedAt >= settings.cooldownHours * 3600e3) {
    s.armed = false;
    s.firedAt = Date.now();
    saveState();
    send(st, make());
  } else if (!s.armed && clear) {
    s.armed = true;
    saveState();
  }
}

const checkTimers = new Map();
function scheduleCheck(st) {
  clearTimeout(checkTimers.get(st.id));
  checkTimers.set(st.id, setTimeout(() => check(st), 3000));
}
function check(st) {
  const S = settings;
  if (S.stations[st.id] === false) return;
  const v = (k) => st.v(k);
  const at = STATIONS.length > 1 ? ` at ${st.name}` : '';
  if (st.lastData && Date.now() - st.lastData < 10 * 60e3) {
    const g = v('gust');
    if (S.gust.on && Number.isFinite(g))
      rule(st, 'gust', g >= S.gust.kmh, g < S.gust.kmh * 0.7, () => ({
        kind: 'gust', priority: 'high', title: `💨 Wind gust ${fmt(g, 0)} km/h${at}`,
        message: `From the ${compass(v('dir'))}, wind ${fmt(v('wind'), 0)} km/h. Today's highest gust ${fmt(Math.max(g, v('gustMax') ?? 0), 0)} km/h.`,
      }));
    const rr = v('rainRate');
    if (S.rainRate.on && Number.isFinite(rr))
      rule(st, 'rainRate', rr >= S.rainRate.mmh, rr < S.rainRate.mmh * 0.3, () => ({
        kind: 'rainRate', priority: 'high', title: `🌧️ Heavy rain${at}: ${fmt(rr)} mm/h`, message: `${fmt(v('rainDay'))} mm so far today, ${fmt(v('rainEvent'))} mm this rain event.`,
      }));
    const rd = v('rainDay');
    if (S.rainDay.on && Number.isFinite(rd)) {
      const day = new Date().toDateString(), key = `${st.id}:rainDay`;
      const s = (state[key] ||= { armed: true, firedAt: 0 });
      if (s.day !== day) (s.day = day), (s.armed = true);
      if (s.armed && rd >= S.rainDay.mm) {
        s.armed = false;
        s.firedAt = Date.now();
        saveState();
        send(st, { kind: 'rainDay', priority: 'default', title: `🌧️ ${fmt(rd)} mm of rain today${at}`, message: `Rain rate now ${fmt(rr)} mm/h. This month ${fmt(v('rainMonth'))} mm.` });
      }
    }
    const t = v('outT');
    if (S.frost.on && Number.isFinite(t))
      rule(st, 'frost', t <= S.frost.c, t >= S.frost.c + 2, () => ({
        kind: 'frost', priority: 'default', title: `🥶 Frost${at}: ${fmt(t)} °C`, message: `Feels like ${fmt(v('feels'))} °C, humidity ${fmt(v('outH'), 0)}%, dew point ${fmt(v('dew'))} °C.`,
      }));
    if (S.heat.on && Number.isFinite(t))
      rule(st, 'heat', t >= S.heat.c, t <= S.heat.c - 2, () => ({
        kind: 'heat', priority: 'default', title: `🥵 Hot${at}: ${fmt(t)} °C`, message: `Feels like ${fmt(v('feels'))} °C, humidity ${fmt(v('outH'), 0)}%, UV ${fmt(v('uv'), 0)}.`,
      }));
    const dp = st.pressTrend();
    if (S.pressure.on && Number.isFinite(dp))
      rule(st, 'pressure', dp <= -S.pressure.hpa, dp > -S.pressure.hpa / 2, () => ({
        kind: 'pressure', priority: 'high', title: `📉 Pressure falling fast${at}: ${fmt(dp)} hPa in 3 h`, message: `Now ${fmt(v('press'))} hPa. Wind ${fmt(v('wind'), 0)} km/h from the ${compass(v('dir'))}, gusting ${fmt(v('gust'), 0)}.`,
      }));
  }
  if (S.battery.on)
    for (const b of st.batteries)
      rule(st, 'battery:' + b.entity_id, !!st.batteryLow[b.entity_id], !st.batteryLow[b.entity_id], () => ({
        kind: 'battery', priority: 'default', title: `🔋 ${st.name}: ${b.name} low`, message: 'Time to change the batteries in that sensor.',
      }));
}

// A station going quiet: checked every minute (no updates means no events to trigger a check).
setInterval(() => {
  if (!settings.offline.on) return;
  for (const st of STATIONS) {
    if (!st.lastData || settings.stations[st.id] === false) continue;
    const quietMin = (Date.now() - st.lastData) / 60e3;
    rule(st, 'offline', quietMin >= settings.offline.min, quietMin < 2, () => ({
      kind: 'offline', priority: 'default', title: `📡 ${st.name} weather station has gone quiet`,
      message: `No readings for ${Math.round(quietMin)} minutes${st.connected ? '' : " (and its Home Assistant isn't answering)"}. Check the console's Wi-Fi and its upload to Home Assistant.`,
    }));
  }
}, 60e3);

async function send(st, alert) {
  const rec = { t: Date.now(), station: st.id, stationName: st.name, tag: `ecowitt-${st.id}-${alert.kind}`, ...alert };
  alerts.push(rec);
  alerts = alerts.slice(-200);
  writeJson(ALERTS_FILE, alerts);
  log('alert', alert.kind, alert.title, '|', alert.message);
  if (!HA_WEBHOOK && !NTFY_URL) return rec;
  const results = await Promise.all([HA_WEBHOOK && sendWebhook(rec), NTFY_URL && sendNtfy(rec)].filter(Boolean));
  rec.sent = results.some(Boolean);
  writeJson(ALERTS_FILE, alerts);
  return rec;
}

async function postJson(url, obj, headers = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj), signal: ctl.signal });
  } finally {
    clearTimeout(to);
  }
}
async function sendWebhook(alert) {
  try {
    const r = await postJson(HA_WEBHOOK, alert);
    if (!r.ok) log('webhook HTTP', r.status);
    return r.ok;
  } catch (e) {
    log('webhook failed:', e.message);
    return false;
  }
}
const NTFY_TAGS = { gust: 'dash', rainRate: 'cloud_with_rain', rainDay: 'umbrella', frost: 'snowflake', heat: 'fire', pressure: 'chart_with_downwards_trend', offline: 'satellite', battery: 'battery', test: 'white_check_mark' };
async function sendNtfy(alert) {
  try {
    const u = new URL(NTFY_URL);
    const msg = {
      topic: u.pathname.replace(/^\/+|\/+$/g, ''), title: alert.title, message: alert.message || '',
      priority: alert.priority === 'high' ? 4 : 3, tags: [NTFY_TAGS[alert.kind] || 'partly_sunny'],
      ...(DASHBOARD_URL ? { click: DASHBOARD_URL } : {}),
    };
    const r = await postJson(`${u.origin}/`, msg, NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {});
    if (!r.ok) log('ntfy HTTP', r.status);
    return r.ok;
  } catch (e) {
    log('ntfy failed:', e.message);
    return false;
  }
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization' };
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 50_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, { error: 'not found' }, 404);
    const ext = path.extname(file);
    if (ext === '.html') buf = Buffer.from(buf.toString().replaceAll('__V__', String(Math.round(fs.statSync(path.join(__dirname, 'dist', 'ecowitt-card.js')).mtimeMs))));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...CORS });
    res.end(buf);
  });
}
function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  try {
    const st = stationOf(url.searchParams.get('station'));
    if (p === '/api/status') {
      const ok = (x) => x.connected && !!x.lastData && Date.now() - x.lastData < 15 * 60e3;
      return sendJson(res, {
        ok: STATIONS.every(ok), alerts: { webhook: !!HA_WEBHOOK, ntfy: !!NTFY_URL },
        stations: STATIONS.map((x) => ({ id: x.id, name: x.name, ok: ok(x), ha: x.connected, error: x.error || null, readings: Object.keys(x.sensors).length, age: x.lastData ? Math.round((Date.now() - x.lastData) / 1000) : null })),
      }, STATIONS.some(ok) ? 200 : 503);
    }
    if (p === '/api/stations') return sendJson(res, STATIONS.map((x) => ({ id: x.id, name: x.name, device: x.device, ha: x.connected, error: x.error || null })));
    if (p === '/api/live') {
      let t = null;
      try {
        t = await st.today();
      } catch (e) {}
      return sendJson(res, { ...st.snapshot(), today: t, stations: STATIONS.map((x) => ({ id: x.id, name: x.name })) });
    }
    if (p === '/api/history') return sendJson(res, await st.history(url.searchParams.get('range') || '24h'));
    if (p === '/api/auth') return sendJson(res, AUTH.status(req));
    if (p === '/api/login' && req.method === 'POST') {
      const r = await AUTH.login(req, (await body(req)).password);
      return sendJson(res, r.body, r.status);
    }
    if (/^\/api\/(settings|test-alert)$/.test(p) && req.method !== 'GET' && !AUTH.isAdmin(req)) return sendJson(res, { error: 'sign in to change alerts' }, 401);
    if (p === '/api/settings' && req.method === 'GET') return sendJson(res, { ...settings, webhook: !!HA_WEBHOOK, ntfy: !!NTFY_URL });
    if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
      settings = mergeSettings(settings, await body(req));
      writeJson(SETTINGS_FILE, settings);
      return sendJson(res, { ...settings, webhook: !!HA_WEBHOOK, ntfy: !!NTFY_URL });
    }
    if (p === '/api/alerts') return sendJson(res, alerts.slice(-100).reverse());
    if (p === '/api/test-alert' && req.method === 'POST') {
      const s = st.snapshot().values;
      const rec = await send(st, { kind: 'test', priority: 'default', title: `✅ ${st.name}: test alert`, message: `${fmt(s.outT)} °C, wind ${fmt(s.wind, 0)} km/h gusting ${fmt(s.gust, 0)}, ${fmt(s.press)} hPa.` });
      return sendJson(res, { ok: true, sent: rec.sent ?? false, webhook: !!HA_WEBHOOK, ntfy: !!NTFY_URL });
    }
    if (p === '/api') return sendJson(res, { service: 'ecowitt-monitor', endpoints: ['/api/status', '/api/stations', '/api/live?station=', '/api/history?station=&range=6h|24h|7d|30d|1y', '/api/settings', '/api/alerts', '/api/test-alert', '/api/auth', '/api/login'] });
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(__dirname, 'web', 'index.html'));
    if (p === '/card-config.json') return sendFile(res, path.join(DATA_DIR, 'card.json'));
    const m = /^\/(web|dist)\/([\w.-]+)$/.exec(p);
    if (m) return sendFile(res, path.join(__dirname, m[1], m[2]));
    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => log(`ecowitt-monitor on :${PORT} (dashboard at /, stations: ${STATIONS.map((x) => x.name || x.url).join(', ')}, alerts: ${[HA_WEBHOOK && 'HA webhook', NTFY_URL && 'ntfy'].filter(Boolean).join(' + ') || 'none set'}, ${AUTH.required ? 'guests read-only' : 'no sign-in'})`));
for (const st of STATIONS) st.connect();
