// Ecowitt card: an Ecowitt weather station (or several: Home / Cottage...) from ecowitt-monitor.
//   Now     outdoor temperature with today's high and low, wind compass, rain, pressure and its 3-hour trend,
//           sun and UV, indoor readings, sensor batteries
//   Graphs  temperature, humidity, wind, rain and pressure over 6 h, 24 h, 7 d, 30 d or a year
//   Alerts  what to alert on (gusts, heavy rain, a wet day, frost, heat, falling pressure, the station going quiet,
//           low batteries), per station, a test alert, and the recent alerts
// Config:
//   type: custom:ecowitt-card
//   monitor: [http://192.168.1.20:7120]    # ecowitt-monitor; the first that answers is used
//   station: home                          # optional: which station to start on (else the last one picked)
//   title: Weather                         # optional
//   tab: graphs, range: 7d                 # optional: open on this tab / graph range
// Everything comes from the monitor, so the same card runs on its standalone dashboard.

const RANGES = [["6h", "6 h"], ["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["1y", "1 y"]];
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (d) => (Number.isFinite(d) ? COMPASS[Math.round(d / 22.5) % 16] : "–");
const fin = Number.isFinite;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const f1 = (v, d = 1) => (fin(v) ? (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
const f0 = (v) => f1(v, 0);
const store = {
  get(k, d) {
    try {
      return localStorage.getItem("ecowitt-card:" + k) ?? d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("ecowitt-card:" + k, v);
    } catch (e) {}
  },
};

// WHO UV index bands.
const uvBand = (u) => (u < 3 ? ["Low", "#4caf50"] : u < 6 ? ["Moderate", "#fdd835"] : u < 8 ? ["High", "#fb8c00"] : u < 11 ? ["Very high", "#e53935"] : ["Extreme", "#8e24aa"]);
// Beaufort description for a wind speed in km/h.
const BEAUFORT = [[1, "Calm"], [6, "Light air"], [12, "Light breeze"], [20, "Gentle breeze"], [29, "Moderate breeze"], [39, "Fresh breeze"], [50, "Strong breeze"], [62, "Near gale"], [75, "Gale"], [89, "Strong gale"], [103, "Storm"], [118, "Violent storm"], [Infinity, "Hurricane force"]];
const beaufort = (k) => (fin(k) ? BEAUFORT.find(([max]) => k < max)[1] : "");
// Pressure tendency over 3 hours (WMO-style words).
const tendency = (d) => (!fin(d) ? ["", "–"] : d <= -6 ? ["Falling very fast", "⇊"] : d <= -3.5 ? ["Falling fast", "↓"] : d <= -1.5 ? ["Falling", "↘"] : d < 1.5 ? ["Steady", "→"] : d < 3.5 ? ["Rising", "↗"] : d < 6 ? ["Rising fast", "↑"] : ["Rising very fast", "⇈"]);

const ALERT_ROWS = [
  ["gust", "Wind gusts", "mdi:weather-windy", [["kmh", "km/h or more", 10, 200, 5]]],
  ["rainRate", "Heavy rain", "mdi:weather-pouring", [["mmh", "mm/h or more", 1, 200, 1]]],
  ["rainDay", "A wet day", "mdi:umbrella", [["mm", "mm in a day", 1, 500, 5]]],
  ["frost", "Frost", "mdi:snowflake", [["c", "°C or colder", -40, 10, 0.5]]],
  ["heat", "Heat", "mdi:thermometer-high", [["c", "°C or hotter", 15, 50, 1]]],
  ["pressure", "Pressure falling fast", "mdi:trending-down", [["hpa", "hPa drop in 3 h", 1, 20, 0.5]]],
  ["offline", "Station gone quiet", "mdi:access-point-network-off", [["min", "minutes without data", 5, 1440, 5]]],
  ["battery", "Low sensor battery", "mdi:battery-alert", []],
  ["lightning", "Lightning nearby", "mdi:flash", [["km", "km or closer", 1, 100, 1]]],
];

const STYLE = `
  :host { --ec-warm: #ff7043; --ec-cold: #42a5f5; --ec-rain: #29b6f6; --ec-wind: #26a69a; --ec-gust: #ffa726; --ec-in: #ab47bc;
          --ec-press: #8d6e63; --ec-hum: #5c6bc0; --ec-ok: var(--success-color, #43a047); --ec-bad: var(--error-color, #db4437); }
  ha-card { padding: 14px 16px 16px; overflow: hidden; }
  .top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-size: 1.25em; font-weight: 500; flex: 1; min-width: 120px; display: flex; align-items: center; gap: 8px; }
  .title ha-icon { color: var(--primary-color); }
  .seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); gap: 2px; }
  .seg button { border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-weight: 500; padding: 6px 14px;
                border-radius: 999px; cursor: pointer; }
  .seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .pill { font-size: .8em; padding: 4px 10px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
  .pill.bad { background: color-mix(in srgb, var(--ec-bad) 20%, transparent); color: var(--ec-bad); font-weight: 500; }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); margin: 12px 0 14px; }
  .tabs button { flex: 1; border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-weight: 500; padding: 7px; border-radius: 999px; cursor: pointer; }
  .tabs button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 1100px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: var(--secondary-background-color); border-radius: 14px; padding: 12px 14px; min-width: 0; }
  .ph { display: flex; align-items: center; gap: 6px; font-size: .8em; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
  .ph ha-icon { --mdc-icon-size: 18px; }
  .big { font-size: 3.2em; font-weight: 300; line-height: 1; }
  .big small { font-size: .4em; color: var(--secondary-text-color); margin-left: 2px; }
  .sub { color: var(--secondary-text-color); font-size: .9em; margin-top: 4px; }
  .hilo { display: flex; gap: 14px; margin-top: 8px; font-size: .95em; }
  .hilo .hi { color: var(--ec-warm); } .hilo .lo { color: var(--ec-cold); }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: .95em; margin-top: 8px; }
  .kv span:nth-child(odd) { color: var(--secondary-text-color); }
  .kv b { font-weight: 500; text-align: right; }
  .wind { display: flex; gap: 12px; align-items: center; }
  .wind svg { width: 130px; height: 130px; flex: none; }
  .uvbar { height: 8px; border-radius: 4px; margin: 8px 0 4px; background: linear-gradient(90deg, #4caf50 0%, #4caf50 18%, #fdd835 18%, #fdd835 41%, #fb8c00 41%, #fb8c00 59%, #e53935 59%, #e53935 82%, #8e24aa 82%); position: relative; }
  .uvbar i { position: absolute; top: -4px; width: 4px; height: 16px; border-radius: 2px; background: var(--primary-text-color); transform: translateX(-2px); }
  .rainrows { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; align-items: center; font-size: .92em; margin-top: 6px; }
  .rainrows .bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--ec-rain) 20%, transparent); overflow: hidden; }
  .rainrows .bar i { display: block; height: 100%; background: var(--ec-rain); border-radius: 3px; }
  .rainrows span:first-child { color: var(--secondary-text-color); }
  .warn { color: var(--ec-bad); font-weight: 500; }
  .pair { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }
  .phs { text-transform: none; letter-spacing: 0; }
  .smap { position: relative; height: 380px; border-radius: 12px; overflow: hidden; background: #0b1a2a; }
  .smap .tiles img, .smap .wms img { position: absolute; left: 0; top: 0; user-select: none; pointer-events: none; }
  .smap .wms img { width: 100%; height: 100%; opacity: 0; z-index: 1; }
  .smap svg.ov { z-index: 3; } .smap .zoom, .smap .play, .smap .attr { z-index: 4; }
  .smap .pp { display: inline-flex; padding: 5px 7px; } .smap .pp svg { width: 14px; height: 14px; fill: #fff; }
  .smap .wms img.on { opacity: .85; }
  .smap svg.ov { position: absolute; inset: 0; width: 100%; height: 100%; }
  .smap .zoom { position: absolute; right: 8px; top: 8px; display: flex; gap: 4px; }
  .smap button { border: none; border-radius: 8px; padding: 5px 9px; font: inherit; font-size: .8em; cursor: pointer; background: rgba(0,0,0,.6); color: #fff; }
  .smap button.on { background: var(--primary-color); }
  .smap .play { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 6px; align-items: center; }
  .smap .play b { background: rgba(0,0,0,.6); color: #fff; border-radius: 8px; padding: 4px 8px; font-size: .8em; font-weight: 500; }
  .smap .attr { position: absolute; right: 6px; bottom: 4px; font-size: 10px; color: rgba(255,255,255,.85); text-shadow: 0 0 3px #000; text-align: right; }
  .rdleg { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: .85em; color: var(--secondary-text-color); flex-wrap: wrap; }
  .rdleg i { width: 70px; height: 8px; border-radius: 4px; display: inline-block; margin-right: 8px; }
  .rdleg i.rain { background: linear-gradient(90deg, #99ffff, #00b7ff, #0047ff, #00ff00, #00b200, #ffff00, #ffaa00, #ff0000, #ff00ff); }
  .rdleg i.snow { background: linear-gradient(90deg, #ccffff, #99ccff, #6699ff, #3366ff, #9933cc, #cc00cc); }
  .rdleg .note { margin-left: auto; }
  @media (max-width: 640px) { .smap { height: 300px; } }
  .panel.wide { grid-column: 1 / -1; }
  .ranges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .ranges button { border: 1px solid var(--divider-color); background: var(--card-background-color, transparent); color: var(--primary-text-color); font: inherit;
                   padding: 6px 14px; border-radius: 999px; cursor: pointer; }
  .ranges button.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
  .chart { background: var(--secondary-background-color); border-radius: 14px; padding: 10px 12px 6px; position: relative; min-width: 0; }
  .chart h4 { margin: 0 0 4px; font-size: .9em; font-weight: 500; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .chart h4 .lg { font-weight: 400; font-size: .85em; color: var(--secondary-text-color); display: inline-flex; gap: 4px; align-items: center; }
  .chart h4 .lg i { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
  .chart svg { width: 100%; height: 170px; display: block; touch-action: pan-y; }
  .chart .tip { position: absolute; pointer-events: none; background: var(--card-background-color, #222); color: var(--primary-text-color); border: 1px solid var(--divider-color);
                border-radius: 8px; padding: 6px 8px; font-size: .8em; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); display: none; z-index: 2; }
  .axis { fill: var(--secondary-text-color); font-size: 10px; }
  .gridl { stroke: var(--divider-color); stroke-width: 1; }
  .msg { color: var(--secondary-text-color); padding: 18px 4px; }
  .msg.bad { color: var(--ec-bad); }
  .al { display: grid; gap: 8px; }
  .al .row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; background: var(--secondary-background-color); border-radius: 12px; padding: 8px 12px; }
  .al .row .n { font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .al .row .n ha-icon { color: var(--primary-color); --mdc-icon-size: 20px; }
  .al .row .thr { display: flex; align-items: center; gap: 6px; font-size: .9em; color: var(--secondary-text-color); }
  .al input[type=number] { width: 72px; font: inherit; padding: 5px 6px; border-radius: 8px; border: 1px solid var(--divider-color);
                            background: var(--card-background-color, #fff); color: var(--primary-text-color); color-scheme: light dark; }
  .sw { position: relative; width: 40px; height: 22px; flex: none; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw span { position: absolute; inset: 0; border-radius: 11px; background: var(--disabled-text-color, #888); cursor: pointer; transition: background .15s; }
  .sw span::after { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .sw input:checked + span { background: var(--primary-color); }
  .sw input:checked + span::after { transform: translateX(18px); }
  .sw input:disabled + span { opacity: .5; cursor: default; }
  .btn { border: 1px solid var(--divider-color); background: var(--card-background-color, transparent); color: var(--primary-text-color); font: inherit; padding: 7px 14px; border-radius: 10px; cursor: pointer; }
  .btn.pri { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .bar2 { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0 6px; }
  .note { font-size: .85em; color: var(--secondary-text-color); }
  .log { margin-top: 10px; display: grid; gap: 6px; }
  .log .e { background: var(--secondary-background-color); border-radius: 10px; padding: 7px 10px; font-size: .9em; }
  .log .e .t { color: var(--secondary-text-color); font-size: .85em; }
  .login { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .login input { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  @media (max-width: 500px) { .big { font-size: 2.6em; } .charts { grid-template-columns: 1fr; } .wind svg { width: 110px; height: 110px; } }
`;

class EcowittCard extends HTMLElement {
  setConfig(config) {
    const m = config?.monitor;
    if (!m || (Array.isArray(m) && !m.length)) throw new Error("ecowitt-card: set `monitor:` to your ecowitt-monitor's address");
    this._config = { title: "", ...config, monitor: (Array.isArray(m) ? m : [m]).map((u) => String(u).replace(/\/+$/, "")) };
    this._tab = config.tab || store.get("tab", "now");
    this._range = config.range || store.get("range", "24h");
    this._station = config.station || store.get("station", "");
    this._base = null;
    if (this.isConnected) this._start();
  }

  set hass(h) {
    this._hass = h;
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  static getStubConfig() {
    return { monitor: ["http://192.168.1.20:7120"] };
  }

  connectedCallback() {
    if (this._config) this._start();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearInterval(this._histTimer);
    this._timer = this._histTimer = null;
    this._radar?.stop();
  }

  _start() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._built) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>
        <div class="top"><div class="title"><ha-icon icon="mdi:weather-partly-cloudy"></ha-icon><span id="title"></span></div>
          <div class="seg" id="stations"></div><span class="pill" id="age"></span></div>
        <div class="tabs" id="tabs">${[["now", "Now"], ["graphs", "Graphs"], ["alerts", "Alerts"]].map(([k, n]) => `<button data-tab="${k}">${n}</button>`).join("")}</div>
        <div id="body"><div class="msg">Connecting to ecowitt-monitor…</div></div></ha-card>`;
      this._built = true;
      const $ = (id) => this.shadowRoot.getElementById(id);
      this.$ = { title: $("title"), stations: $("stations"), age: $("age"), tabs: $("tabs"), body: $("body") };
      this.$.tabs.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tab]");
        if (b) this._setTab(b.dataset.tab);
      });
      this.$.stations.addEventListener("click", (e) => {
        const b = e.target.closest("[data-st]");
        if (b && b.dataset.st !== this._station) {
          this._station = b.dataset.st;
          store.set("station", this._station);
          this._live = null;
          this._hist = null;
          this._paintTop();
          this._refresh(true);
        }
      });
    }
    this._paintTabs();
    if (!this._timer) {
      this._timer = setInterval(() => this._refresh(), 15000);
      this._refresh(true);
    }
  }

  _setTab(t) {
    this._tab = t;
    store.set("tab", t);
    this._paintTabs();
    this._paintBody(true);
  }

  _paintTabs() {
    for (const b of this.$.tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === this._tab);
  }

  // ---- data ----------------------------------------------------------------------------------------------------
  async _fetch(path, opts = {}) {
    const bases = this._base ? [this._base, ...this._config.monitor.filter((b) => b !== this._base)] : this._config.monitor;
    let last;
    for (const b of bases) {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), opts.timeout || 15000);
        const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(this._token() ? { Authorization: "Bearer " + this._token() } : {}) };
        const r = await fetch(b + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: "no-store" });
        clearTimeout(to);
        this._base = b;
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(j.error || `HTTP ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return j;
      } catch (e) {
        last = e;
        if (e.status) throw e; // the monitor answered: don't try the others
      }
    }
    throw last || new Error("no monitor answered");
  }

  _token() {
    return store.get("token:" + (this._base || ""), "");
  }

  async _refresh(force) {
    try {
      const q = this._station ? `?station=${encodeURIComponent(this._station)}` : "";
      const live = await this._fetch("/api/live" + q);
      this._err = null;
      this._live = live;
      this._stations = live.stations || [];
      if (!this._station || !this._stations.some((s) => s.id === this._station)) this._station = live.station;
      this._paintTop();
      if (this._tab === "now") this._paintBody(force);
      else if (force) this._paintBody(true);
    } catch (e) {
      this._err = e.message;
      this._paintTop();
      if (!this._live) this.$.body.innerHTML = `<div class="msg bad">Can't reach ecowitt-monitor (${esc(this._config.monitor.join(", "))}): ${esc(e.message)}</div>`;
    }
  }

  _paintTop() {
    const L = this._live;
    this.$.title.textContent = this._config.title || (L ? (this._stations.length > 1 ? "Weather" : L.name || "Weather") : "Weather");
    this.$.stations.style.display = this._stations?.length > 1 ? "" : "none";
    this.$.stations.innerHTML = (this._stations || []).map((s) => `<button data-st="${esc(s.id)}" class="${s.id === this._station ? "on" : ""}">${esc(s.name)}</button>`).join("");
    const age = L?.age;
    const stale = this._err || !L?.ha || !fin(age) || age > 900;
    this.$.age.className = "pill" + (stale ? " bad" : "");
    this.$.age.textContent = this._err ? "Monitor unreachable" : !L ? "" : !L.ha ? "HA not connected" : !fin(age) ? "No data yet" : age < 90 ? `Updated ${age} s ago` : age < 5400 ? `Updated ${Math.round(age / 60)} min ago` : `No data for ${Math.round(age / 3600)} h`;
  }

  _paintBody(force) {
    if (this._tab === "now") return this._paintNow();
    if (this._tab === "graphs") return this._paintGraphs(force);
    if (this._tab === "alerts") return force ? this._paintAlerts() : null;
  }

  // ---- Now -----------------------------------------------------------------------------------------------------
  _paintNow() {
    const L = this._live;
    if (!L) return;
    if (L.error && !L.ha) {
      this.$.body.innerHTML = `<div class="msg bad">${esc(L.name)}: ${esc(L.error)}</div>`;
      return;
    }
    const v = L.values || {}, T = L.today || {};
    const hilo = (k, unit, d = 1) => (T[k] && (fin(T[k].max) || fin(T[k].min)) ? `<div class="hilo"><span class="hi">▲ ${f1(T[k].max, d)}${unit}</span><span class="lo">▼ ${f1(T[k].min, d)}${unit}</span><span class="sub" style="margin:0">today</span></div>` : "");
    const [uvName, uvCol] = uvBand(v.uv ?? 0);
    const [tName, tArrow] = tendency(L.pressTrend3h);
    const rainMax = Math.max(1, v.rainDay ?? 0, v.rainEvent ?? 0, v.rainHour ?? 0);
    const rainRow = (n, x, scale) => `<span>${n}</span><div class="bar"><i style="width:${Math.min(100, ((x ?? 0) / scale) * 100)}%"></i></div><b>${f1(x)} mm</b>`;
    const low = (L.batteries || []).filter((b) => b.low);
    this.$.body.innerHTML = `<div class="grid">
      <div class="panel"><div class="ph"><ha-icon icon="mdi:thermometer"></ha-icon>Outside</div>
        <div class="big">${f1(v.outT)}<small>°C</small></div>
        <div class="sub">Feels like ${f1(v.feels)} °C${fin(v.chill) && v.chill < v.outT - 0.5 ? ` · wind chill ${f1(v.chill)} °C` : ""}</div>
        ${hilo("outT", "°")}
        <div class="kv"><span>Humidity</span><b>${f0(v.outH)} %</b><span>Dew point</span><b>${f1(v.dew)} °C</b></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:weather-windy"></ha-icon>Wind</div>
        <div class="wind">${this._compassSvg(v.dir, v.wind)}
          <div><div class="big" style="font-size:2.4em">${f0(v.wind)}<small>km/h</small></div>
            <div class="sub">${esc(beaufort(v.wind))}${fin(v.dir) ? ` from the ${compass(v.dir)} (${f0(v.dir)}°)` : ""}</div>
            <div class="kv"><span>Gust</span><b>${f0(v.gust)} km/h</b><span>Highest today</span><b>${f0(v.gustMax)} km/h</b></div></div></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:weather-rainy"></ha-icon>Rain</div>
        <div class="big" style="font-size:2.4em">${f1(v.rainRate)}<small>mm/h</small></div>
        <div class="sub">${(v.rainRate ?? 0) > 0 ? "Raining now" : "Not raining"}</div>
        <div class="rainrows">${rainRow("This hour", v.rainHour, rainMax)}${rainRow("Today", v.rainDay, rainMax)}${rainRow("This event", v.rainEvent, rainMax)}</div>
        <div class="kv"><span>This week</span><b>${f1(v.rainWeek)} mm</b><span>This month</span><b>${f1(v.rainMonth)} mm</b><span>This year</span><b>${f1(v.rainYear)} mm</b></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:gauge"></ha-icon>Pressure</div>
        <div class="big" style="font-size:2.4em">${f1(v.press)}<small>hPa</small></div>
        <div class="sub" style="font-size:1.05em">${tArrow} ${esc(tName)}${fin(L.pressTrend3h) ? ` (${L.pressTrend3h > 0 ? "+" : ""}${f1(L.pressTrend3h)} hPa in 3 h)` : ""}</div>
        ${hilo("press", "", 1)}</div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Sun</div>
        <div class="big" style="font-size:2.4em">${f0(v.solar)}<small>W/m²</small></div>
        <div class="sub">UV index <b style="color:${uvCol}">${f0(v.uv)}</b> · ${uvName}</div>
        <div class="uvbar"><i style="left:${Math.min(100, ((v.uv ?? 0) / 11) * 100)}%"></i></div>
        <div class="kv"><span>Light</span><b>${fin(v.lux) ? Math.round(v.lux).toLocaleString() : "–"} lx</b></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:home-thermometer"></ha-icon>Inside</div>
        <div class="big" style="font-size:2.4em">${f1(v.inT)}<small>°C</small></div>
        ${hilo("inT", "°")}
        <div class="kv"><span>Humidity</span><b>${f0(v.inH)} %</b><span>Dew point</span><b>${f1(v.inDew)} °C</b>
          ${(L.batteries || []).length ? `<span>Batteries</span><b class="${low.length ? "warn" : ""}">${low.length ? esc(low.map((b) => b.name.replace(/ battery/i, "")).join(", ")) + " low" : "OK"}</b>` : ""}</div></div>
      ${L.home ? `<div class="pair">${L.lightning ? this._lightningPanel(L.lightning) : ""}${this._radarPanel()}</div>` : ""}
    </div>`;
    if (L.home) this._mountMaps(L);
  }

  // Lightning (Blitzortung): the last hour's strikes on the map, newest brightest, and the nearest / latest strike and
  // counts under it.
  _lightningPanel(Lt) {
    const ago = (t) => {
      const s = Math.round((Date.now() - t) / 1000);
      return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
    };
    const where = (x) => (x ? `${f0(x.km)} km ${compass(x.bearing)}, ${ago(x.t)}` : "–");
    const quiet = !Lt.count60;
    return `<div class="panel"><div class="ph"><ha-icon icon="mdi:flash"></ha-icon>Lightning <span class="phs">· Blitzortung, within 100 km</span></div>
      <div id="map-lt" class="smap"></div>
      <div class="kv">
        ${quiet ? `<span>Last hour</span><b>No strikes</b>` : `<span>Last 15 min · hour</span><b>${Lt.count15} · ${Lt.count60} strike${Lt.count60 === 1 ? "" : "s"}</b>`}
        <span>Nearest, 15 min</span><b>${where(Lt.nearest15)}</b>
        <span>Nearest, hour</span><b>${where(Lt.nearest60)}</b>
        <span>Latest</span><b>${Lt.last ? where(Lt.last) : "none in the last 3 h"}</b>
        ${quiet ? "" : `<span></span><b class="sub" style="font-weight:400"><span style="color:#ffee58">⚡</span> 5 min <span style="color:#ffa726">●</span> 15 min <span style="color:#ff5252">●</span> 1 h</b>`}</div></div>`;
  }

  // Environment Canada's radar (MSC GeoMet, free, no key): rain and snow rate, the last hour looped.
  _radarPanel() {
    return `<div class="panel"><div class="ph"><ha-icon icon="mdi:radar"></ha-icon>Radar <span class="phs">· Environment Canada, rain and snow</span></div>
      <div id="map-rd" class="smap"></div>
      <div class="rdleg"><span>Rain</span><i class="rain"></i><span>Snow</span><i class="snow"></i><span class="note" id="rd-note"></span></div></div>`;
  }

  // The maps are kept between repaints (moved into the new panels), so tiles and radar frames don't reload every 15 s.
  _mountMaps(L) {
    const st = this._station;
    if (!this._maps) {
      this._maps = {
        lt: new SatMap({ ranges: [25, 50, 100], key: "ltkm", def: 100, rings: [10, 25, 50, 100], onDraw: (v) => this._drawStrikes(v) }),
        rd: new SatMap({ ranges: [50, 100, 250], key: "rdkm", def: 250, rings: [50, 100, 250], onDraw: (v) => this._radar?.draw(v), attr: "Radar: Environment and Climate Change Canada" }),
      };
      this._radar = new Radar(this._maps.rd);
    }
    const lt = this.shadowRoot.getElementById("map-lt"), rd = this.shadowRoot.getElementById("map-rd");
    this._lt = L.lightning;
    if (lt) this._maps.lt.mount(lt, L.home, st);
    if (rd) {
      this._maps.rd.mount(rd, L.home, st);
      this._radar.start(this.shadowRoot.getElementById("rd-note"));
    }
  }

  // Strikes on the lightning map, oldest first so the newest are on top.
  _drawStrikes(v) {
    let s = "";
    for (const [age, , , la, lo] of [...(this._lt?.strikes || [])].sort((a, b) => b[0] - a[0])) {
      if (!fin(la) || !fin(lo)) continue;
      const [x, y] = v.P(la, lo);
      if (x < -10 || y < -10 || x > v.W + 10 || y > v.H + 10) continue;
      const col = age < 300 ? "#ffee58" : age < 900 ? "#ffa726" : "#ff5252";
      s += age < 300
        ? `<path d="M${x - 2},${y - 7} L${x + 3},${y - 1} L${x},${y - 1} L${x + 2},${y + 7} L${x - 3},${y} L${x},${y} Z" fill="${col}" stroke="#000" stroke-width=".8"/>`
        : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${col}" stroke="#000" stroke-width=".7" opacity="${age < 900 ? 1 : 0.75}"/>`;
    }
    return s;
  }

  // A compass rose with an arrow pointing the way the wind is blowing (it comes from `dir`).
  _compassSvg(dir, speed) {
    let ticks = "";
    for (let i = 0; i < 72; i++) {
      const a = (i * 5 * Math.PI) / 180, major = i % 18 === 0, mid = i % 9 === 0;
      const r1 = major ? 50 : mid ? 53 : 56, r2 = 60;
      ticks += `<line x1="${70 + r1 * Math.sin(a)}" y1="${70 - r1 * Math.cos(a)}" x2="${70 + r2 * Math.sin(a)}" y2="${70 - r2 * Math.cos(a)}" stroke="var(--secondary-text-color)" stroke-opacity="${major ? 0.9 : 0.35}" stroke-width="${major ? 2 : 1}"/>`;
    }
    const lab = ["N", "E", "S", "W"].map((t, i) => {
      const a = (i * 90 * Math.PI) / 180;
      return `<text x="${70 + 40 * Math.sin(a)}" y="${70 - 40 * Math.cos(a) + 4}" text-anchor="middle" style="font-size:12px;font-weight:600;fill:${t === "N" ? "var(--ec-bad)" : "var(--secondary-text-color)"}">${t}</text>`;
    }).join("");
    const arrow = fin(dir)
      ? `<g transform="rotate(${dir + 180} 70 70)"><path d="M70 22 L80 46 L72 42 L72 98 L68 98 L68 42 L60 46 Z" fill="var(--ec-wind)" opacity="${(speed ?? 0) < 1 ? 0.35 : 1}"/></g>`
      : "";
    return `<svg viewBox="0 0 140 140">${ticks}${lab}${arrow}<circle cx="70" cy="70" r="5" fill="var(--primary-text-color)"/></svg>`;
  }

  // ---- Graphs --------------------------------------------------------------------------------------------------
  async _paintGraphs(force) {
    const key = `${this._station}|${this._range}`;
    if (!force && this._hist?.key === key) return;
    this.$.body.innerHTML = `<div class="ranges">${RANGES.map(([k, n]) => `<button data-r="${k}" class="${k === this._range ? "on" : ""}">${n}</button>`).join("")}</div>
      <div id="charts"><div class="msg">Loading…</div></div>`;
    this.$.body.querySelector(".ranges").addEventListener("click", (e) => {
      const b = e.target.closest("[data-r]");
      if (!b) return;
      this._range = b.dataset.r;
      store.set("range", this._range);
      this._paintGraphs(true);
    });
    clearInterval(this._histTimer);
    this._histTimer = setInterval(() => this._tab === "graphs" && this._loadHist(true), 300000);
    await this._loadHist(false);
  }

  async _loadHist(quiet) {
    const box = this.shadowRoot.getElementById("charts");
    try {
      const st = this._station, range = this._range;
      const h = await this._fetch(`/api/history?station=${encodeURIComponent(st)}&range=${range}`, { timeout: 60000 });
      if (st !== this._station || range !== this._range || this._tab !== "graphs") return;
      this._hist = { key: `${st}|${range}`, h };
      this._drawCharts(this.shadowRoot.getElementById("charts"), h);
    } catch (e) {
      if (!quiet && box) box.innerHTML = `<div class="msg bad">Couldn't load the history: ${esc(e.message)}</div>`;
    }
  }

  _drawCharts(box, h) {
    if (!box) return;
    if (!h.t.length) {
      box.innerHTML = `<div class="msg">No history for this period yet.</div>`;
      return;
    }
    const S = h.series, long = h.period !== "5minute";
    const t = h.t.map((x) => x + (h.period === "5minute" ? 150e3 : h.period === "hour" ? 1800e3 : 43200e3)); // bucket middles
    const defs = [];
    if (S.outT || S.inT)
      defs.push({
        title: "Temperature", unit: "°C", d: 1,
        lines: [
          S.outT && { name: "Outside", color: "var(--ec-warm)", y: S.outT.mean, band: long ? [S.outT.min, S.outT.max] : null },
          S.inT && { name: "Inside", color: "var(--ec-in)", y: S.inT.mean },
        ].filter(Boolean),
        summary: S.outT ? `▲ ${f1(max(S.outT.max.length ? S.outT.max : S.outT.mean))}° ▼ ${f1(min(S.outT.min.length ? S.outT.min : S.outT.mean))}°` : "",
      });
    if (S.outH || S.inH)
      defs.push({ title: "Humidity", unit: "%", d: 0, fixed: [0, 100], lines: [S.outH && { name: "Outside", color: "var(--ec-hum)", y: S.outH.mean }, S.inH && { name: "Inside", color: "var(--ec-in)", y: S.inH.mean }].filter(Boolean) });
    if (S.wind || S.gust)
      defs.push({
        title: "Wind", unit: "km/h", d: 0, zero: true,
        lines: [S.wind && { name: "Average", color: "var(--ec-wind)", y: S.wind.mean, fill: true }, S.gust && { name: "Gusts", color: "var(--ec-gust)", y: S.gust.max, thin: true }].filter(Boolean),
        summary: S.gust ? `highest gust ${f0(max(S.gust.max))} km/h` : "",
      });
    if (S.rainMonth) {
      const bars = this._rainBars(h);
      defs.push({ title: "Rain", unit: "mm", d: 1, zero: true, bars, summary: `${f1(bars.total)} mm in all` });
    }
    if (S.lightning && S.lightning.change.some((x) => x > 0)) {
      const bars = this._rainBars(h, "lightning");
      defs.push({ title: "Lightning", unit: "strikes", d: 0, zero: true, bars, color: "#ffca28", summary: `${f0(bars.total)} strikes within 100 km` });
    }
    if (S.press) defs.push({ title: "Pressure", unit: "hPa", d: 1, lines: [{ name: "Sea level", color: "var(--ec-press)", y: S.press.mean }] });
    box.innerHTML = `<div class="charts">${defs.map((c, i) => `<div class="chart" data-i="${i}"><h4>${esc(c.title)}
        ${(c.lines || []).map((l) => `<span class="lg"><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join("")}
        ${c.summary ? `<span class="lg">${esc(c.summary)}</span>` : ""}</h4><svg></svg><div class="tip"></div></div>`).join("")}</div>`;
    defs.forEach((c, i) => this._chart(box.querySelector(`.chart[data-i="${i}"]`), c, c.bars ? c.bars.t : t, h));
  }

  // Rain as bars of a sensible size for the range: 30 min for 6 h, hourly for 24 h, 6-hourly for 7 d, daily for
  // 30 d, weekly for a year (from the monthly total's change per bucket).
  _rainBars(h, key = "rainMonth") {
    const step = { "6h": 1800e3, "24h": 3600e3, "7d": 6 * 3600e3, "30d": 864e5, "1y": 7 * 864e5 }[h.range];
    const off = new Date().getTimezoneOffset() * 60e3; // buckets on local boundaries
    const map = new Map();
    h.t.forEach((x, i) => {
      const c = h.series[key].change[i];
      if (!fin(c)) return;
      const b = Math.floor((x - off) / step) * step + off;
      map.set(b, (map.get(b) || 0) + c);
    });
    const first = Math.floor((h.start - off) / step) * step + off;
    const t = [], y = [];
    for (let b = first; b <= h.end; b += step) {
      t.push(b + step / 2);
      y.push(map.has(b) ? Math.round(map.get(b) * 10) / 10 : null);
    }
    return { t, y, step, total: y.reduce((s, x) => s + (x || 0), 0) };
  }

  _chart(el, c, t, h) {
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip");
    const W = Math.max(280, el.clientWidth - 24), H = 170, L = 38, R = 8, T = 8, B = 20;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const all = [];
    for (const l of c.lines || []) {
      for (const v of l.y) if (fin(v)) all.push(v);
      if (l.band) for (const a of l.band) for (const v of a) if (fin(v)) all.push(v);
    }
    if (c.bars) for (const v of c.bars.y) if (fin(v)) all.push(v);
    if (!all.length) {
      svg.outerHTML = `<div class="msg">No data.</div>`;
      return;
    }
    let lo = c.fixed ? c.fixed[0] : Math.min(...all), hi = c.fixed ? c.fixed[1] : Math.max(...all);
    if (c.zero || c.bars) lo = Math.min(0, lo);
    if (hi - lo < (c.bars ? 1 : c.unit === "hPa" ? 4 : 2)) {
      const m = (hi + lo) / 2, half = (c.bars ? 1 : c.unit === "hPa" ? 4 : 2) / 2;
      (lo = c.zero || c.bars ? 0 : m - half), (hi = c.zero || c.bars ? Math.max(hi, 1) : m + half);
    }
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const x0 = h.start, x1 = h.end;
    const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let s = "";
    for (const v of ticks) s += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${fmtTick(v)}</text>`;
    for (const [x, label] of timeTicks(x0, x1, h.range)) s += `<line class="gridl" x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${H - B}" stroke-dasharray="2 3"/><text class="axis" x="${X(x)}" y="${H - 5}" text-anchor="middle">${label}</text>`;
    if (c.bars) {
      const bw = Math.max(1, ((c.bars.step / (x1 - x0)) * (W - L - R)) * 0.75);
      c.bars.y.forEach((v, i) => {
        if (fin(v) && v > 0) s += `<rect x="${X(c.bars.t[i]) - bw / 2}" y="${Y(v)}" width="${bw}" height="${Math.max(1, Y(0) - Y(v))}" rx="${Math.min(3, bw / 3)}" fill="${c.color || "var(--ec-rain)"}"/>`;
      });
    }
    for (const l of c.lines || []) {
      if (l.band) s += `<path d="${bandPath(t, l.band[0], l.band[1], X, Y)}" fill="${l.color}" opacity=".18"/>`;
      const d = linePath(t, l.y, X, Y, h);
      if (l.fill) s += `<path d="${areaPath(t, l.y, X, Y, Y(Math.max(lo, 0)), h)}" fill="${l.color}" opacity=".2"/>`;
      s += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.thin ? 1.2 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    s += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--primary-text-color)" stroke-opacity=".5" style="display:none"/>`;
    svg.innerHTML = s;
    const cross = svg.querySelector(".cross");
    const fmtT = (x) => new Date(x).toLocaleString(undefined, h.range === "1y" ? { month: "short", day: "numeric", year: "numeric" } : h.range === "30d" || h.range === "7d" ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      if (px < L || px > W - R) return hide();
      const xt = x0 + ((px - L) / (W - L - R)) * (x1 - x0);
      const tt = c.bars ? c.bars.t : t;
      let i = 0, best = Infinity;
      for (let k = 0; k < tt.length; k++) {
        const dd = Math.abs(tt[k] - xt);
        if (dd < best) (best = dd), (i = k);
      }
      cross.setAttribute("x1", X(tt[i]));
      cross.setAttribute("x2", X(tt[i]));
      cross.style.display = "";
      let rows = "";
      if (c.bars) {
        const a = tt[i] - c.bars.step / 2;
        rows = `<b>${f1(c.bars.y[i] ?? 0, c.d)} ${c.unit}</b> <span style="opacity:.7">${fmtRange(a, a + c.bars.step, h.range)}</span>`;
      } else {
        rows = `<div style="opacity:.7">${fmtT(tt[i])}</div>` + c.lines.map((l) => `<div><span style="color:${l.color}">●</span> ${esc(l.name)} <b>${f1(l.y[i], c.d)} ${c.unit}</b>${l.band && fin(l.band[0][i]) ? ` <span style="opacity:.7">(${f1(l.band[0][i], c.d)} – ${f1(l.band[1][i], c.d)})</span>` : ""}</div>`).join("");
      }
      tip.innerHTML = rows;
      tip.style.display = "block";
      const left = (X(tt[i]) / W) * r.width;
      tip.style.left = Math.min(Math.max(4, left + 14), el.clientWidth - tip.offsetWidth - 4) + "px";
      tip.style.top = "30px";
    };
    const hide = () => {
      cross.style.display = "none";
      tip.style.display = "none";
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", hide);
  }

  // ---- Alerts --------------------------------------------------------------------------------------------------
  async _paintAlerts() {
    this.$.body.innerHTML = `<div class="msg">Loading…</div>`;
    let set, auth, log;
    try {
      [set, auth, log] = await Promise.all([this._fetch("/api/settings"), this._fetch("/api/auth"), this._fetch("/api/alerts")]);
    } catch (e) {
      this.$.body.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
      return;
    }
    if (this._tab !== "alerts") return;
    const can = auth.admin;
    const dis = can ? "" : "disabled";
    const where = [set.webhook && "Home Assistant", set.ntfy && "ntfy"].filter(Boolean).join(" and ");
    const stations = this._stations || [];
    this.$.body.innerHTML = `
      ${can ? "" : `<div class="panel" style="margin-bottom:10px"><div class="login"><span>Sign in to change alerts:</span><input type="password" id="pw" placeholder="Password" autocomplete="current-password"><button class="btn pri" id="signin">Sign in</button><span class="note" id="lmsg"></span></div></div>`}
      ${stations.length > 1 ? `<div class="bar2"><span class="note">Alerts for:</span>${stations.map((s) => `<label class="sw" title="${esc(s.name)}"><input type="checkbox" data-st="${esc(s.id)}" ${set.stations?.[s.id] === false ? "" : "checked"} ${dis}><span></span></label><span>${esc(s.name)}</span>`).join("")}</div>` : ""}
      <div class="al">${ALERT_ROWS.map(([k, name, icon, fields]) => `<div class="row">
          <label class="sw"><input type="checkbox" data-on="${k}" ${set[k]?.on ? "checked" : ""} ${dis}><span></span></label>
          <div class="n"><ha-icon icon="${icon}"></ha-icon>${esc(name)}</div>
          <div class="thr">${fields.map(([f, label, mn, mx, stp]) => `<input type="number" data-k="${k}" data-f="${f}" value="${set[k]?.[f] ?? ""}" min="${mn}" max="${mx}" step="${stp}" ${dis}><span>${esc(label)}</span>`).join("")}</div></div>`).join("")}
        <div class="row"><span></span><div class="n"><ha-icon icon="mdi:timer-sand"></ha-icon>Repeat the same alert at most every</div>
          <div class="thr"><input type="number" data-k="cooldownHours" value="${set.cooldownHours}" min="1" max="168" step="1" ${dis}><span>hours</span></div></div></div>
      <div class="bar2"><button class="btn" id="test" ${dis}>Send a test alert</button>
        <span class="note" id="tmsg">${where ? `Alerts go to ${where}.` : "No HA_WEBHOOK or NTFY_URL set in the monitor's .env: alerts are only listed here."}</span></div>
      <div class="ph" style="margin-top:14px"><ha-icon icon="mdi:history"></ha-icon>Recent alerts</div>
      <div class="log">${log.length ? log.slice(0, 30).map((a) => `<div class="e"><div>${esc(a.title)}</div><div class="t">${new Date(a.t).toLocaleString()}${stations.length > 1 && a.stationName ? ` · ${esc(a.stationName)}` : ""} · ${esc(a.message || "")}</div></div>`).join("") : `<div class="note">None yet.</div>`}</div>`;
    const B = this.$.body;
    const save = async (patch) => {
      try {
        await this._fetch("/api/settings", { method: "PUT", body: patch });
      } catch (e) {
        B.querySelector("#tmsg").textContent = "Couldn't save: " + e.message;
      }
    };
    B.querySelectorAll("[data-on]").forEach((el) => el.addEventListener("change", () => save({ [el.dataset.on]: { on: el.checked } })));
    B.querySelectorAll("[data-st]").forEach((el) => el.addEventListener("change", () => save({ stations: { [el.dataset.st]: el.checked } })));
    B.querySelectorAll("input[data-k]").forEach((el) =>
      el.addEventListener("change", () => (el.dataset.k === "cooldownHours" ? save({ cooldownHours: Number(el.value) }) : save({ [el.dataset.k]: { [el.dataset.f]: Number(el.value) } }))));
    B.querySelector("#test")?.addEventListener("click", async () => {
      const m = B.querySelector("#tmsg");
      m.textContent = "Sending…";
      try {
        const r = await this._fetch(`/api/test-alert?station=${encodeURIComponent(this._station)}`, { method: "POST", body: {} });
        m.textContent = r.sent ? "Sent." : r.webhook || r.ntfy ? "Couldn't deliver it: see the monitor's log." : "Logged (no HA_WEBHOOK or NTFY_URL set).";
        setTimeout(() => this._tab === "alerts" && this._paintAlerts(), 1500);
      } catch (e) {
        m.textContent = e.message;
      }
    });
    const signin = async () => {
      const m = B.querySelector("#lmsg");
      try {
        const r = await this._fetch("/api/login", { method: "POST", body: { password: B.querySelector("#pw").value } });
        store.set("token:" + this._base, r.token);
        this._paintAlerts();
      } catch (e) {
        m.textContent = e.message;
      }
    };
    B.querySelector("#signin")?.addEventListener("click", signin);
    B.querySelector("#pw")?.addEventListener("keydown", (e) => e.key === "Enter" && signin());
  }
}

// ---- satellite map ---------------------------------------------------------------------------------------------
// Esri World Imagery with place names (free, no key), centred on a point, sized so a chosen range (km) fills it, with
// range rings and N drawn over it, and an onDraw(view) hook for more (strikes, radar). Tiles come from the nearest whole
// zoom, scaled to a fractional one.
class SatMap {
  constructor({ ranges, key, def, rings, onDraw, attr }) {
    this.ranges = ranges;
    this.key = key;
    this.rings = rings;
    this.onDraw = onDraw;
    this.km = Number(store.get(key, def)) || def;
    this.tiles = new Map();
    this.el = document.createElement("div");
    this.el.style.cssText = "position:absolute;inset:0";
    this.el.innerHTML = `<div class="tiles"></div><div class="wms"></div><svg class="ov"></svg><div class="zoom">${ranges.map((k) => `<button data-km="${k}">${k} km</button>`).join("")}</div>
      <div class="ctl"></div><div class="attr">Imagery © Esri, Maxar, Earthstar Geographics${attr ? `<br>${attr}` : ""}</div>`;
    this.el.querySelector(".zoom").addEventListener("click", (e) => {
      const b = e.target.closest("[data-km]");
      if (!b) return;
      this.km = Number(b.dataset.km);
      store.set(this.key, this.km);
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  mount(slot, center, id) {
    slot.appendChild(this.el);
    this.center = center;
    this.id = id;
    requestAnimationFrame(() => this.draw());
  }

  view() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H || !this.center) return null;
    const { lat, lon } = this.center;
    const wx = (lo, z) => ((lo + 180) / 360) * 256 * 2 ** z;
    const wy = (la, z) => ((1 - Math.log(Math.tan((la * Math.PI) / 180) + 1 / Math.cos((la * Math.PI) / 180)) / Math.PI) / 2) * 256 * 2 ** z;
    const mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
    const zf = Math.max(3, Math.min(14, Math.log2(((Math.min(W, H) / 2) * 0.94 * mpp0) / (this.km * 1000))));
    const cx = wx(lon, zf), cy = wy(lat, zf), world = 256 * 2 ** zf, E = 20037508.342789244;
    const m = (px, py) => [(px / world) * 2 * E - E, E - (py / world) * 2 * E]; // EPSG:3857 metres
    const [x0, y1] = m(cx - W / 2, cy - H / 2), [x1, y0] = m(cx + W / 2, cy + H / 2);
    return { W, H, zf, z: Math.round(zf), cx, cy, mpp: mpp0 / 2 ** zf, P: (la, lo) => [wx(lo, zf) - cx + W / 2, wy(la, zf) - cy + H / 2], bbox: [x0, y0, x1, y1] };
  }

  draw() {
    if (!this.el.isConnected) return;
    const v = this.view();
    if (!v) return;
    const { W, H, zf, z, cx, cy } = v;
    const box = this.el.querySelector(".tiles"), keep = new Set(), n = 2 ** z, T = (256 * 2 ** zf) / n;
    const tx0 = Math.floor((cx - W / 2) / T), tx1 = Math.floor((cx + W / 2) / T);
    const ty0 = Math.max(0, Math.floor((cy - H / 2) / T)), ty1 = Math.min(n - 1, Math.floor((cy + H / 2) / T));
    for (const layer of ["World_Imagery", "Reference/World_Boundaries_and_Places"])
      for (let tx = tx0; tx <= tx1; tx++)
        for (let ty = ty0; ty <= ty1; ty++) {
          const k = `${layer}/${z}/${tx}/${ty}`;
          keep.add(k);
          let img = this.tiles.get(k);
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.style.zIndex = layer === "World_Imagery" ? 0 : 2; // place names above the radar (1)
            img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/${layer}/MapServer/tile/${z}/${ty}/${((tx % n) + n) % n}`;
            this.tiles.set(k, img);
            box.appendChild(img);
          }
          const left = Math.round(tx * T - cx + W / 2), top = Math.round(ty * T - cy + H / 2);
          img.style.transform = `translate(${left}px, ${top}px)`;
          img.style.width = `${Math.round((tx + 1) * T - cx + W / 2) - left + 1}px`; // +1: no hairline seams
          img.style.height = `${Math.round((ty + 1) * T - cy + H / 2) - top + 1}px`;
        }
    for (const [k, img] of this.tiles) if (!keep.has(k)) (img.remove(), this.tiles.delete(k));
    for (const b of this.el.querySelectorAll(".zoom button")) b.classList.toggle("on", Number(b.dataset.km) === this.km);
    const C = [W / 2, H / 2];
    let s = `<defs><filter id="mh"><feDropShadow dx="0" dy="0" stdDeviation="1.2" flood-color="#000" flood-opacity=".9"/></filter></defs>`;
    for (const km of this.rings) {
      const r = (km * 1000) / v.mpp;
      if (r < 12 || r > Math.hypot(W, H)) continue;
      s += `<circle cx="${C[0]}" cy="${C[1]}" r="${r.toFixed(1)}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.3" stroke-dasharray="${km === this.rings[this.rings.length - 1] ? "" : "5 4"}" filter="url(#mh)"/>
            <text x="${C[0] + 4}" y="${(C[1] - r + 13).toFixed(1)}" filter="url(#mh)" style="font-size:11px;font-weight:600;fill:#fff">${km} km</text>`;
    }
    s += `<text x="${C[0]}" y="16" text-anchor="middle" filter="url(#mh)" style="font-size:13px;font-weight:700;fill:#ff5252">N</text>`;
    s += this.onDraw?.(v) || "";
    s += `<circle cx="${C[0]}" cy="${C[1]}" r="6" fill="var(--primary-color)" stroke="#fff" stroke-width="2"/>`;
    this.el.querySelector("svg.ov").innerHTML = s;
  }
}

// Environment Canada radar on a SatMap: rain and snow rate (MSC GeoMet WMS, 6-minute frames, kept 3 h), the last hour
// looped. One image per frame and layer, cut to the map's exact view, so a loop is ~22 requests; frames are kept
// while the view stays the same.
const GEOMET = "https://geo.weather.gc.ca/geomet";
const RADAR_LAYERS = ["RADAR_1KM_RRAI", "RADAR_1KM_RSNO"];
class Radar {
  constructor(map) {
    this.map = map;
    this.times = [];
    this.i = 0;
    this.playing = store.get("radarplay", "1") !== "0";
    this.frames = new Map(); // `${viewKey}|${time}|${layer}` -> img
    const ctl = map.el.querySelector(".ctl");
    ctl.className = "play";
    ctl.innerHTML = `<button class="pp"></button><b class="when">Loading radar…</b>`;
    ctl.querySelector(".pp").addEventListener("click", () => {
      this.playing = !this.playing;
      store.set("radarplay", this.playing ? "1" : "0");
      if (!this.playing) this.i = this.times.length - 1;
      this.show();
    });
  }

  async start(note) {
    this.note = note;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 550);
      this.timesTimer = setInterval(() => this.loadTimes(), 180000);
    }
    if (!this.times.length || Date.now() - (this.loadedAt || 0) > 180000) await this.loadTimes();
    this.show();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.timesTimer);
    this.timer = this.timesTimer = null;
  }

  // The available times, from the rain layer's capabilities: "start/end/PT6M". The last hour (11 frames).
  async loadTimes() {
    try {
      const r = await fetch(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${RADAR_LAYERS[0]}`);
      const x = await r.text();
      const m = /<Dimension name="time"[^>]*>([^/<]+)\/([^/<]+)\/PT(\d+)M</.exec(x);
      if (!m) throw new Error("no time dimension");
      const end = Date.parse(m[2]), step = Number(m[3]) * 60e3, start = Date.parse(m[1]);
      const times = [];
      for (let t = end - 10 * step; t <= end; t += step) if (t >= start) times.push(new Date(t).toISOString().replace(".000Z", "Z"));
      const changed = times.join() !== this.times.join();
      this.times = times;
      this.loadedAt = Date.now();
      if (changed) this.i = this.playing ? 0 : times.length - 1;
      if (this.note) this.note.textContent = "";
    } catch (e) {
      if (this.note) this.note.textContent = "Radar unavailable: " + e.message;
    }
    this.draw(this.map.view());
  }

  // Called by the map on every redraw: (re)build the frames for this view. Returns no SVG.
  draw(v) {
    if (!v || !this.times.length) return "";
    const W = Math.round(v.W), H = Math.round(v.H);
    const key = `${v.bbox.map((x) => Math.round(x)).join(",")},${W}x${H}`;
    const box = this.map.el.querySelector(".wms");
    const keep = new Set();
    for (const t of this.times)
      for (const layer of RADAR_LAYERS) {
        const k = `${key}|${t}|${layer}`;
        keep.add(k);
        if (this.frames.has(k)) continue;
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.dataset.t = t;
        img.src = `${GEOMET}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&BBOX=${v.bbox.join(",")}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${t}`;
        this.frames.set(k, img);
        box.appendChild(img);
      }
    for (const [k, img] of this.frames) if (!keep.has(k)) (img.remove(), this.frames.delete(k));
    this.key = key;
    this.show();
    return "";
  }

  tick() {
    if (!this.map.el.isConnected) return this.stop();
    if (!this.playing || this.times.length < 2) return;
    // Hold the newest frame a little longer.
    if (this.i === this.times.length - 1 && (this.hold = (this.hold || 0) + 1) < 4) return;
    this.hold = 0;
    this.i = (this.i + 1) % this.times.length;
    this.show();
  }

  show() {
    const t = this.times[this.i];
    for (const img of this.map.el.querySelectorAll(".wms img")) img.classList.toggle("on", img.dataset.t === t);
    const when = this.map.el.querySelector(".when"), pp = this.map.el.querySelector(".pp");
    if (pp) pp.innerHTML = `<svg viewBox="0 0 24 24"><path d="${this.playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M8 5v14l11-7z"}"/></svg>`;
    if (when && t) {
      const d = new Date(t), mins = Math.round((Date.now() - d) / 60e3);
      when.textContent = `${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${mins} min ago`;
    }
  }
}

// ---- chart helpers ---------------------------------------------------------------------------------------------
function max(a) {
  const v = a.filter(fin);
  return v.length ? Math.max(...v) : null;
}
function min(a) {
  const v = a.filter(fin);
  return v.length ? Math.min(...v) : null;
}
function niceTicks(lo, hi, n) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) || mag * 10;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
const fmtTick = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toString() : String(Math.round(v * 100) / 100));
// Gaps longer than ~3 buckets break the line.
function gapMs(h) {
  return h.period === "5minute" ? 20 * 60e3 : h.period === "hour" ? 4 * 3600e3 : 4 * 864e5;
}
function linePath(t, y, X, Y, h) {
  let d = "", prev = null;
  for (let i = 0; i < t.length; i++) {
    if (!fin(y[i])) continue;
    d += `${prev === null || t[i] - prev > gapMs(h) ? "M" : "L"}${X(t[i]).toFixed(1)},${Y(y[i]).toFixed(1)}`;
    prev = t[i];
  }
  return d;
}
function areaPath(t, y, X, Y, base, h) {
  let d = "", seg = [];
  const flush = () => {
    if (seg.length > 1) d += `M${X(seg[0][0]).toFixed(1)},${base}` + seg.map(([a, b]) => `L${X(a).toFixed(1)},${Y(b).toFixed(1)}`).join("") + `L${X(seg[seg.length - 1][0]).toFixed(1)},${base}Z`;
    seg = [];
  };
  for (let i = 0; i < t.length; i++) {
    if (!fin(y[i])) continue;
    if (seg.length && t[i] - seg[seg.length - 1][0] > gapMs(h)) flush();
    seg.push([t[i], y[i]]);
  }
  flush();
  return d;
}
function bandPath(t, lo, hi, X, Y) {
  const pts = t.map((x, i) => [x, lo[i], hi[i]]).filter((p) => fin(p[1]) && fin(p[2]));
  if (pts.length < 2) return "";
  return "M" + pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join("L") + "L" + pts.reverse().map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L") + "Z";
}
// Time-axis labels at round local times for the range.
function timeTicks(x0, x1, range) {
  const out = [];
  const d = new Date(x0);
  if (range === "6h" || range === "24h") {
    const stepH = range === "6h" ? 1 : 4;
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / stepH) * stepH);
    for (; d.getTime() <= x1; d.setHours(d.getHours() + stepH))
      if (d.getTime() >= x0) out.push([d.getTime(), d.getHours() === 0 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.toLocaleTimeString(undefined, { hour: "numeric" })]);
  } else if (range === "7d" || range === "30d") {
    const stepD = range === "7d" ? 1 : 5;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    for (; d.getTime() <= x1; d.setDate(d.getDate() + stepD)) out.push([d.getTime(), d.toLocaleDateString(undefined, range === "7d" ? { weekday: "short" } : { month: "short", day: "numeric" })]);
  } else {
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= x1; d.setMonth(d.getMonth() + 2)) out.push([d.getTime(), d.toLocaleDateString(undefined, { month: "short" })]);
  }
  return out;
}
function fmtRange(a, b, range) {
  const o = range === "1y" || range === "30d" ? { month: "short", day: "numeric" } : { weekday: "short", hour: "numeric", minute: "2-digit" };
  if (range === "30d") return new Date(a).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${new Date(a).toLocaleString(undefined, o)} – ${new Date(b - 1).toLocaleString(undefined, range === "1y" ? o : { hour: "numeric", minute: "2-digit" })}`;
}

customElements.define("ecowitt-card", EcowittCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ecowitt-card", name: "Ecowitt weather", description: "Ecowitt weather station(s) from ecowitt-monitor: now, graphs up to a year, alerts." });
