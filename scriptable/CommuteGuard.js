// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: car;

/**
 * CommuteGuard – RM8 2YX ⇄ Asda Beckton traffic widget for Scriptable (iOS)
 *
 * Standalone: no server needed. It talks directly to
 *   - OSRM (router.project-osrm.org) for the driving route + base drive time
 *   - TfL Open Data (api.tfl.gov.uk) for live A13 / A406 disruptions
 * and adds an estimated rush-hour delay on top.
 *
 * Works as:
 *   - Lock Screen: rectangular, circular, inline
 *   - Home Screen: small, medium, large
 * Run it inside the Scriptable app to see a preview + a details menu.
 */

// ───────────────────────── SETTINGS ─────────────────────────

const HOME = { name: "Home", short: "RM8 2YX", lat: 51.5583, lng: 0.1332 };
const WORK = { name: "Asda Beckton", short: "Asda", lat: 51.5173, lng: 0.0571 };

const SCHEDULE = {
  morningStart: "07:30",
  morningEnd: "09:30",
  eveningStart: "16:30",
  eveningEnd: "18:30",
  // 0 = Sun, 1 = Mon … 6 = Sat.  Use [1, 2, 3, 4, 5] for weekdays only.
  activeDays: [0, 1, 2, 3, 4, 5, 6],
  // true = show a small "idle" message outside the commute windows
  hideOutsideSchedule: false,
  // true = in the evening window, show Asda ➔ Home instead
  autoReverseEvening: true,
};

// Roads to watch on TfL
const TFL_ROADS = "A13,A406";

// Only count TfL disruptions inside this box around the route
const AREA = { minLat: 51.5, maxLat: 51.575, minLng: 0.03, maxLng: 0.16 };

// Widget refresh (iOS treats this as a hint, not a guarantee)
const REFRESH_MINUTES = 10;

// ──────────────────────── TIME HELPERS ───────────────────────

function toMins(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minsNow(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function inWindow(d, start, end) {
  const n = minsNow(d);
  return n >= toMins(start) && n <= toMins(end);
}

function scheduleState(d) {
  const dayOk = SCHEDULE.activeDays.includes(d.getDay());
  const morning = dayOk && inWindow(d, SCHEDULE.morningStart, SCHEDULE.morningEnd);
  const evening = dayOk && inWindow(d, SCHEDULE.eveningStart, SCHEDULE.eveningEnd);
  return { active: morning || evening, morning, evening };
}

function fmtTime(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ───────────────────── TRAFFIC ESTIMATE ──────────────────────
// OSRM has no live traffic, so this adds a typical East London
// rush-hour delay based on day and time (same model as the web app).

function estimatedDelay(d) {
  const day = d.getDay();
  const t = d.getHours() + d.getMinutes() / 60;
  const weekend = day === 0 || day === 6;

  if (weekend) {
    if (t >= 11 && t <= 16.5) {
      // Weekend shopping traffic around Beckton retail park
      return Math.round(3 + Math.sin(((t - 11) / 5.5) * Math.PI) * 4);
    }
    return 1;
  }
  if (t >= 7.25 && t <= 9.5) {
    return Math.round(6 + Math.sin(((t - 7.25) / 2.25) * Math.PI) * 8); // +6…+14
  }
  if (t >= 11 && t < 15) return 3;
  if (t >= 16.25 && t <= 18.75) {
    return Math.round(5 + Math.sin(((t - 16.25) / 2.5) * Math.PI) * 9); // +5…+14
  }
  if (t >= 22 || t < 6) return 0;
  return 2;
}

// Extra minutes for serious TfL disruptions on the route
function disruptionPenalty(disruptions) {
  let extra = 0;
  for (const x of disruptions) {
    const s = (x.severity || "").toLowerCase();
    if (s.includes("severe") || s.includes("serious")) extra += 5;
    else if (s.includes("moderate")) extra += 2;
  }
  return Math.min(extra, 15);
}

function conditionFor(delay) {
  if (delay >= 15) return { label: "Severe", color: new Color("#DC2626") };
  if (delay >= 10) return { label: "Heavy", color: new Color("#EF4444") };
  if (delay >= 4) return { label: "Moderate", color: new Color("#F59E0B") };
  return { label: "Clear", color: new Color("#10B981") };
}

// ───────────────────────── DATA ──────────────────────────────

async function fetchRoute(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&steps=true`;
  try {
    const req = new Request(url);
    req.timeoutInterval = 8;
    const json = await req.loadJSON();
    const r = json.routes && json.routes[0];
    if (!r) throw new Error("no route");

    // Pick the longest named road as the "via"
    const roads = {};
    for (const s of r.legs[0].steps || []) {
      const name = s.ref || s.name;
      if (name) roads[name] = (roads[name] || 0) + s.distance;
    }
    const via = Object.keys(roads).sort((a, b) => roads[b] - roads[a])[0] || "A13";

    return {
      minutes: Math.round(r.duration / 60),
      miles: (r.distance / 1609.34).toFixed(1),
      via,
      live: true,
    };
  } catch (e) {
    return { minutes: 15, miles: "6.1", via: "A13", live: false };
  }
}

async function fetchDisruptions() {
  try {
    const req = new Request(`https://api.tfl.gov.uk/Road/${TFL_ROADS}/Disruption`);
    req.timeoutInterval = 8;
    const data = await req.loadJSON();
    if (!Array.isArray(data)) return [];
    return data
      .filter((x) => (x.status || "").toLowerCase() === "active")
      .filter((x) => {
        // TfL "point" looks like "[0.0571,51.5173]" (lng, lat)
        try {
          const [lng, lat] = JSON.parse(x.point);
          return lat >= AREA.minLat && lat <= AREA.maxLat && lng >= AREA.minLng && lng <= AREA.maxLng;
        } catch (e) {
          return false;
        }
      })
      .map((x) => ({
        severity: x.severity || "",
        location: x.location || "",
        comments: x.comments || "",
      }));
  } catch (e) {
    return [];
  }
}

async function getCommute() {
  const now = new Date();
  const sched = scheduleState(now);
  const reverse = SCHEDULE.autoReverseEvening && sched.evening;
  const from = reverse ? WORK : HOME;
  const to = reverse ? HOME : WORK;

  const [route, disruptions] = await Promise.all([fetchRoute(from, to), fetchDisruptions()]);

  const delay = estimatedDelay(now) + disruptionPenalty(disruptions);
  const total = route.minutes + delay;
  const eta = new Date(now.getTime() + total * 60000);

  return {
    now,
    sched,
    from,
    to,
    route,
    disruptions,
    delay,
    total,
    eta: fmtTime(eta),
    cond: conditionFor(delay),
    delayText: delay > 0 ? `+${delay}m` : "On time",
    disruptionText: disruptions.length
      ? `${disruptions[0].severity}: ${disruptions[0].location}`
      : "No TfL disruptions on A13/A406",
  };
}

// ──────────────────────── WIDGETS ────────────────────────────

function addText(stack, str, font, color) {
  const t = stack.addText(str);
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function buildIdle(widget, family) {
  if (family === "accessoryInline") {
    widget.addText("🚗 Commute idle");
  } else if (family === "accessoryCircular") {
    addText(widget, "🚗", Font.systemFont(16));
    addText(widget, "idle", Font.systemFont(10));
  } else {
    addText(widget, "🚗 Commute idle", Font.semiboldSystemFont(13), Color.gray());
    addText(
      widget,
      `Next: ${SCHEDULE.morningStart} / ${SCHEDULE.eveningStart}`,
      Font.systemFont(11),
      Color.gray()
    );
  }
}

function buildRectangular(widget, c) {
  const top = widget.addStack();
  top.layoutHorizontally();
  addText(top, `🚗 ${c.to.name}`, Font.boldSystemFont(12));
  top.addSpacer();
  addText(top, c.delayText, Font.boldSystemFont(11));

  const mid = widget.addStack();
  mid.layoutHorizontally();
  mid.bottomAlignContent();
  addText(mid, `${c.total} min`, Font.heavySystemFont(20));
  mid.addSpacer(6);
  addText(mid, `ETA ${c.eta}`, Font.mediumSystemFont(12));

  addText(
    widget,
    c.sched.active ? `via ${c.route.via} · ${c.cond.label}` : "Outside commute hours",
    Font.systemFont(10)
  );
}

function buildCircular(widget, c) {
  widget.addAccessoryWidgetBackground = true;
  const s = widget.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  const a = addText(s, `${c.total}`, Font.heavySystemFont(18));
  a.centerAlignText();
  const b = addText(s, "min", Font.systemFont(10));
  b.centerAlignText();
}

function buildInline(widget, c) {
  widget.addText(`🚗 ${c.to.short} ${c.total}m · ETA ${c.eta}`);
}

function buildHome(widget, c, family) {
  widget.backgroundColor = new Color("#0B1220");
  widget.setPadding(12, 14, 12, 14);
  const white = Color.white();
  const dim = new Color("#94A3B8");

  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  addText(
    header,
    family === "small" ? `➔ ${c.to.short}` : `${c.from.short} ➔ ${c.to.name}`,
    Font.boldSystemFont(13),
    white
  );
  header.addSpacer();
  addText(header, c.cond.label, Font.boldSystemFont(11), c.cond.color);

  widget.addSpacer(6);

  const main = widget.addStack();
  main.layoutHorizontally();
  main.bottomAlignContent();
  addText(main, `${c.total}`, Font.heavySystemFont(34), white);
  main.addSpacer(3);
  addText(main, "min", Font.semiboldSystemFont(14), dim);

  if (family !== "small") {
    main.addSpacer(14);
    const info = main.addStack();
    info.layoutVertically();
    addText(info, `ETA ${c.eta}`, Font.semiboldSystemFont(14), white);
    addText(info, `Delay ${c.delayText} · ${c.route.miles} mi`, Font.systemFont(11), c.cond.color);
  } else {
    addText(widget, `ETA ${c.eta}  ${c.delayText}`, Font.semiboldSystemFont(12), c.cond.color);
  }

  widget.addSpacer(6);
  addText(widget, `via ${c.route.via}`, Font.systemFont(11), dim);

  if (family !== "small") {
    const d = widget.addText(c.disruptionText);
    d.font = Font.systemFont(10);
    d.textColor = new Color("#64748B");
    d.lineLimit = family === "large" ? 4 : 1;
  }

  if (family === "large" && c.disruptions.length > 1) {
    widget.addSpacer(6);
    for (const x of c.disruptions.slice(1, 4)) {
      const t = widget.addText(`• ${x.severity}: ${x.location}`);
      t.font = Font.systemFont(10);
      t.textColor = new Color("#64748B");
      t.lineLimit = 2;
    }
  }

  widget.addSpacer();
  addText(
    widget,
    `Updated ${fmtTime(c.now)}${c.route.live ? "" : " · offline estimate"}`,
    Font.systemFont(9),
    new Color("#475569")
  );
}

async function createWidget(family) {
  const widget = new ListWidget();
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  // Tapping the widget opens Apple Maps directions
  widget.url = `http://maps.apple.com/?daddr=${WORK.lat},${WORK.lng}&dirflg=d`;

  const sched = scheduleState(new Date());
  if (!sched.active && SCHEDULE.hideOutsideSchedule) {
    buildIdle(widget, family);
    return widget;
  }

  const c = await getCommute();
  widget.url = `http://maps.apple.com/?saddr=${c.from.lat},${c.from.lng}&daddr=${c.to.lat},${c.to.lng}&dirflg=d`;

  if (family === "accessoryRectangular") buildRectangular(widget, c);
  else if (family === "accessoryCircular") buildCircular(widget, c);
  else if (family === "accessoryInline") buildInline(widget, c);
  else buildHome(widget, c, family);

  return widget;
}

// ─────────────────────────── RUN ─────────────────────────────

if (config.runsInWidget) {
  Script.setWidget(await createWidget(config.widgetFamily || "medium"));
} else {
  const menu = new Alert();
  menu.title = "CommuteGuard";
  menu.addAction("Preview Lock Screen (rectangular)");
  menu.addAction("Preview Lock Screen (circular)");
  menu.addAction("Preview Home Screen (medium)");
  menu.addAction("Preview Home Screen (large)");
  menu.addAction("Show details");
  menu.addCancelAction("Cancel");
  const pick = await menu.presentSheet();

  if (pick === 0) await (await createWidget("accessoryRectangular")).presentAccessoryRectangular();
  else if (pick === 1) await (await createWidget("accessoryCircular")).presentAccessoryCircular();
  else if (pick === 2) await (await createWidget("medium")).presentMedium();
  else if (pick === 3) await (await createWidget("large")).presentLarge();
  else if (pick === 4) {
    const c = await getCommute();
    const a = new Alert();
    a.title = `${c.from.short} ➔ ${c.to.name}`;
    a.message =
      `Drive time: ${c.total} min (${c.route.minutes} base ${c.delayText})\n` +
      `ETA: ${c.eta}\nTraffic: ${c.cond.label}\nVia: ${c.route.via} · ${c.route.miles} mi\n\n` +
      (c.disruptions.length
        ? c.disruptions.slice(0, 5).map((x) => `• ${x.severity}: ${x.location}`).join("\n")
        : "No active TfL disruptions on A13/A406");
    a.addAction("Open in Maps");
    a.addCancelAction("Close");
    if ((await a.presentAlert()) === 0) {
      Safari.open(`http://maps.apple.com/?saddr=${c.from.lat},${c.from.lng}&daddr=${c.to.lat},${c.to.lng}&dirflg=d`);
    }
  }
}

Script.complete();
