const STATUS_CLASS = {
  measured: "badge-measured",
  estimated: "badge-estimated",
  unknown: "badge-unknown",
};

const STATUS_LABEL = {
  measured: "measured",
  estimated: "estimated",
  unknown: "unavailable",
};

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(n);
}

/** Hours after which a hand-entered reading is visually marked stale. */
const MANUAL_STALE_HOURS = 12;

/**
 * LaunchAgent publishes about every 15 minutes while the Mac is awake.
 * A snapshot older than this is treated as Mac offline / asleep.
 */
const MAC_ONLINE_MINUTES = 20;

const STATUS_LABEL_NL = {
  measured: "gemeten",
  estimated: "schatting",
  unknown: "n.v.t.",
};

function fmtDate(isoOrDay) {
  if (!isoOrDay) return "—";
  const d = new Date(isoOrDay);
  if (Number.isNaN(d.getTime())) return String(isoOrDay);
  // Date-only (YYYY-MM-DD) → calendar day; timestamps → Amsterdam wall clock.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(isoOrDay))) {
    return new Intl.DateTimeFormat("nl-NL", {
      timeZone: "Europe/Amsterdam",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d);
  }
  return fmtAmsterdamDateTime(isoOrDay);
}

/** Short collection-mode label for the card badge row. */
function collectionLabel(mode) {
  if (mode === "automatic") return "live";
  if (mode === "manual") return "handmatig";
  return "n.v.t.";
}

function collectionBadgeClass(mode) {
  if (mode === "automatic") return "badge-live";
  if (mode === "manual") return "badge-manual";
  return "badge-na";
}

/**
 * Honest Mac presence from snapshot age (no separate heartbeat).
 * @param {string|null|undefined} generatedAt
 * @param {Date} [now]
 * @returns {{ online: boolean, label: string, title: string, minutes: number|null }}
 */
function macPresence(generatedAt, now = new Date()) {
  if (!generatedAt) {
    return {
      online: false,
      label: "Mac offline",
      title: "Geen snapshot-tijd beschikbaar",
      minutes: null,
    };
  }
  const observed = new Date(generatedAt);
  if (Number.isNaN(observed.getTime())) {
    return {
      online: false,
      label: "Mac offline",
      title: "Snapshot-tijd onleesbaar",
      minutes: null,
    };
  }
  const minutes = Math.max(0, (now.getTime() - observed.getTime()) / 60000);
  const stamp = fmtAmsterdamDateTime(generatedAt);
  if (minutes <= MAC_ONLINE_MINUTES) {
    return {
      online: true,
      label: "Mac online",
      title: `Laatste collect ${stamp} (Europe/Amsterdam) · ${Math.round(minutes)} min geleden`,
      minutes,
    };
  }
  return {
    online: false,
    label: "Mac offline / in slaap",
    title: `Laatste collect ${stamp} (Europe/Amsterdam) · ${
      minutes < 120
        ? `${Math.round(minutes)} min`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} u`
          : `${Math.round(minutes / 1440)} d`
    } geleden`,
    minutes,
  };
}

function updateMacBadge(generatedAt, now = new Date()) {
  const el = document.getElementById("mac-badge");
  if (!el) return;
  const presence = macPresence(generatedAt, now);
  el.textContent = presence.label;
  el.dataset.state = generatedAt
    ? presence.online
      ? "online"
      : "offline"
    : "unknown";
  el.title = presence.title;
}

export { MAC_ONLINE_MINUTES, macPresence, updateMacBadge, glanceMeter };

/** Amsterdam wall-clock for the prominent global stamp (Dutch numerals). */
function fmtAmsterdamDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * Age of a source reading relative to now. Used so a fresh snapshot
 * `generatedAt` cannot make a stale manual seed look current.
 * @returns {{ hours: number, label: string, stale: boolean }|null}
 */
function readingAge(lastUpdate, now = new Date()) {
  if (!lastUpdate) return null;
  const observed = new Date(lastUpdate);
  if (Number.isNaN(observed.getTime())) return null;
  const hours = Math.max(0, (now.getTime() - observed.getTime()) / 3600000);
  const label =
    hours < 1
      ? `${Math.max(1, Math.round(hours * 60))} min`
      : hours < 48
        ? `${Math.round(hours)} u`
        : `${Math.round(hours / 24)} d`;
  return { hours, label, stale: hours >= MANUAL_STALE_HOURS };
}

/** Home freshness: one short line. Long “not re-measured” copy stays in Meer. */
function renderSourceFreshness(src) {
  const mode = src.collectionMode || "unavailable";
  if (mode === "automatic") {
    const age = readingAge(src.lastUpdate);
    if (!age && !src.lastUpdate) return "";
    return `
    <p class="source-freshness is-live" data-mode="automatic">
      <span class="source-freshness-main">live${age ? ` · ${escapeHtml(age.label)}` : ""}</span>
    </p>`;
  }
  if (mode !== "manual") return "";
  const age = readingAge(src.lastUpdate);
  const staleClass = age?.stale ? " is-stale" : "";
  return `
    <p class="source-freshness${staleClass}" data-mode="manual">
      <span class="source-freshness-main">handmatig${age ? ` · ${escapeHtml(age.label)}` : ""}</span>
    </p>`;
}

function formatLastUpdateFact(src) {
  const base = fmtDate(src.lastUpdate);
  if ((src.collectionMode || "") !== "manual") return base;
  const age = readingAge(src.lastUpdate);
  if (!age) return base;
  return `${base} (${age.label} oud)`;
}

function usageLabel(src) {
  if (src.status === "unknown" && src.usage == null) {
    return "Niet beschikbaar";
  }
  if (src.usage == null && src.limit == null) return "Geen limiet";
  if (src.usage != null && src.limit == null) {
    const unit = src.unit ? ` ${src.unit}` : "";
    return `${fmtNum(src.usage)}${unit} · geen limiet`;
  }
  const u = src.usage == null ? "—" : fmtNum(src.usage);
  const lim = src.limit == null ? "—" : fmtNum(src.limit);
  const unit = src.unit ? ` ${src.unit}` : "";
  return `${u} / ${lim}${unit}`;
}

/**
 * One home-screen meter. Prefer the hottest capped meter (what bites first),
 * else hottest capacity, else first readable component.
 */
function glanceMeter(src) {
  const comps = Array.isArray(src.components) ? src.components : [];
  if (!comps.length) return null;
  const ranked = (list) =>
    list
      .map((c) => ({ c, p: pct(c) }))
      .filter((x) => x.p != null)
      .sort((a, b) => b.p - a.p);
  const capped = ranked(comps.filter((c) => c.role === "capped"));
  if (capped.length) return capped[0].c;
  const capacity = ranked(comps.filter((c) => c.role === "capacity"));
  if (capacity.length) return capacity[0].c;
  const any = ranked(comps);
  if (any.length) return any[0].c;
  return comps.find((c) => c.usage != null) || comps[0] || null;
}

/** Home glance: one large number + tiny label / reset. */
function renderGlancePrimary(src) {
  const meter = glanceMeter(src);
  if (meter) {
    const metric = primaryDisplay(meter);
    const name = meter.label || meter.id || "";
    const reset = meter.resetDate
      ? ` · reset ${fmtDate(meter.resetDate)}`
      : "";
    return renderPrimary({
      ...metric,
      sub: `${name}${name && metric.sub ? " · " : ""}${metric.sub || ""}${reset}`,
    });
  }
  const metric = primaryDisplay(src);
  const reset = src.resetDate ? ` · reset ${fmtDate(src.resetDate)}` : "";
  return renderPrimary({
    ...metric,
    sub: `${metric.sub || ""}${reset}`,
  });
}

function pct(src) {
  if (src.usage == null || src.limit == null || src.limit <= 0) return null;
  return Math.min(100, Math.round((src.usage / src.limit) * 1000) / 10);
}

function primaryDisplay(src) {
  const p = pct(src);
  if (p != null) {
    return {
      value: `${fmtNum(p)}%`,
      empty: false,
      sub: usageLabel(src),
      bar: p,
    };
  }
  if (src.usage != null) {
    const unit = src.unit ? ` ${src.unit}` : "";
    return {
      value: fmtNum(src.usage),
      empty: false,
      sub: src.limit == null ? `${unit.trim()} · geen limiet` : usageLabel(src),
      bar: null,
    };
  }
  return {
    value: "—",
    empty: true,
    sub: usageLabel(src),
    bar: null,
  };
}

function sparkBars(history) {
  if (!history?.length) {
    return '<div class="spark" aria-hidden="true"><span class="empty"></span><span class="empty"></span><span class="empty"></span></div>';
  }
  const values = history.map((h) => (h.usage == null ? 0 : h.usage));
  const max = Math.max(1, ...values);
  const bars = history
    .map((h) => {
      if (h.usage == null) {
        return `<span class="empty" title="${h.date}: unavailable"></span>`;
      }
      const hPct = Math.max(8, Math.round((h.usage / max) * 100));
      return `<span style="height:${hPct}%" title="${h.date}: ${h.usage}"></span>`;
    })
    .join("");
  return `<div class="spark" role="img" aria-label="Daily usage history">${bars}</div>`;
}

function renderTitle(src) {
  const name = escapeHtml(src.name || src.id);
  if (typeof src.usageUrl === "string" && src.usageUrl.startsWith("https://")) {
    return `<h2><a class="source-link" href="${escapeHtml(src.usageUrl)}" target="_blank" rel="noopener noreferrer">${name}</a></h2>`;
  }
  return `<h2>${name}</h2>`;
}

function renderBar(barWidth, toneClass = "") {
  if (barWidth == null) {
    return `<div class="bar is-unknown" aria-hidden="true"><span></span></div>`;
  }
  const tone = toneClass ? ` ${toneClass}` : "";
  return `<div class="bar${tone}" aria-hidden="true"><span style="--bar-width:${barWidth}%"></span></div>`;
}

function renderPrimary(metric) {
  const emptyClass = metric.empty ? " is-empty" : "";
  return `
    <div class="primary-metric">
      <p class="primary-value${emptyClass}">${escapeHtml(metric.value)}</p>
      ${renderBar(metric.bar)}
      <p class="primary-sub">${escapeHtml(metric.sub)}</p>
    </div>`;
}

function barToneForComponent(c, metric) {
  if (c.role === "capped" && metric.bar != null && metric.bar >= 90) {
    return "is-capped-hot";
  }
  if (c.role === "capacity") return "is-capacity";
  return "";
}

function renderComponentRow(c) {
  const metric = primaryDisplay(c);
  const reset = c.resetDate
    ? `<span class="component-reset">Reset ${escapeHtml(fmtDate(c.resetDate))}</span>`
    : "";
  const roleAttr = c.role ? ` data-role="${escapeHtml(c.role)}"` : "";
  return `
    <li class="component-row"${roleAttr}>
      <span class="component-label">${escapeHtml(c.label || c.id)}</span>
      <div class="component-metric">
        <p class="primary-value${metric.empty ? " is-empty" : ""}">${escapeHtml(metric.value)}</p>
        <p class="primary-sub">${escapeHtml(metric.sub)}</p>
      </div>
      ${renderBar(metric.bar, barToneForComponent(c, metric))}
      ${reset}
    </li>`;
}

function capacityCallout(components) {
  const capacity = components.filter((c) => c.role === "capacity");
  if (!capacity.length) return { html: "", tone: null };
  const pcts = capacity.map((c) => pct(c)).filter((p) => p != null);
  if (!pcts.length) return { html: "", tone: null };
  const max = Math.max(...pcts);
  const tone = max < 50 ? "ample" : max < 80 ? "moderate" : "tight";
  const headline =
    tone === "ample"
      ? "Planruimte ruim"
      : tone === "moderate"
        ? "Planruimte matig"
        : "Planruimte krap";
  const detail = capacity
    .map((c) => {
      const p = pct(c);
      return `${c.label || c.id} ${p == null ? "—" : `${fmtNum(p)}%`}`;
    })
    .join(" · ");
  return {
    tone,
    html: `
    <div class="capacity-callout" data-tone="${tone}">
      <p class="capacity-headline">${escapeHtml(headline)}</p>
      <p class="capacity-detail">${escapeHtml(detail)}</p>
    </div>`,
  };
}

function renderComponentGroup(title, items, ariaLabel) {
  if (!items.length) return "";
  return `
    <section class="component-group">
      <h3 class="component-group-title">${escapeHtml(title)}</h3>
      <ul class="component-list" aria-label="${escapeHtml(ariaLabel)}">
        ${items.map(renderComponentRow).join("")}
      </ul>
    </section>`;
}

/** Full meter breakdown — only inside Meer, never on the home glance. */
function renderComponents(components) {
  if (!Array.isArray(components) || components.length === 0) return "";
  const capacity = components.filter((c) => c.role === "capacity");
  const capped = components.filter((c) => c.role === "capped");
  const plain = components.filter(
    (c) => c.role !== "capacity" && c.role !== "capped",
  );

  if (!capacity.length && !capped.length) {
    return `
    <ul class="component-list" aria-label="Meters">
      ${components.map(renderComponentRow).join("")}
    </ul>`;
  }

  const callout = capacityCallout(components);
  return `
    ${callout.html}
    ${renderComponentGroup("Planruimte", capacity, "Planruimte")}
    ${renderComponentGroup("Losse limieten", capped, "Losse limieten")}
    ${
      plain.length
        ? renderComponentGroup("Overige meters", plain, "Overige meters")
        : ""
    }`;
}

function renderReason(reason) {
  const text = (reason || "").trim();
  if (!text) return "";
  return `
    <details class="reason">
      <summary>Details</summary>
      <p class="reason-body">${escapeHtml(text)}</p>
    </details>`;
}

function cardCapacityTone(src) {
  if (!Array.isArray(src.components)) return null;
  return capacityCallout(src.components).tone;
}

/** Only show fact rows that carry a real value (no jargon wall of em dashes). */
function renderFacts(src) {
  const mode = src.collectionMode || "unavailable";
  /** @type {Array<[string, string]>} */
  const rows = [];
  if (src.resetDate) rows.push(["Reset", fmtDate(src.resetDate)]);
  if (src.lastUpdate) rows.push(["Gemeten", formatLastUpdateFact(src)]);
  rows.push(["Bron", collectionLabel(mode)]);
  if (src.coverageStart) rows.push(["Dekking vanaf", fmtDate(src.coverageStart)]);
  // Daily/monthly pace projections intentionally omitted from the product.
  if (!rows.length) return "";
  return `
      <dl class="facts">
        ${rows
          .map(
            ([dt, dd]) =>
              `<div><dt>${escapeHtml(dt)}</dt><dd>${escapeHtml(dd)}</dd></div>`,
          )
          .join("")}
      </dl>`;
}

function renderCard(src) {
  const status = src.status || "unknown";
  const mode = src.collectionMode || "unavailable";
  const capacityTone = cardCapacityTone(src);
  const capacityAttr = capacityTone
    ? ` data-capacity="${escapeHtml(capacityTone)}"`
    : "";
  const manualStale =
    mode === "manual" && readingAge(src.lastUpdate)?.stale === true;
  const staleAttr = manualStale ? ' data-freshness="stale"' : "";

  const moreBits = [];
  const componentsHtml = renderComponents(src.components);
  if (componentsHtml) moreBits.push(componentsHtml);
  if (src.budget?.monthly != null) {
    moreBits.push(
      `<p class="budget-note">Budget ${fmtNum(src.budget.monthly)} / maand${
        src.budget.weeklyPaceMax != null
          ? ` · max ${fmtNum(src.budget.weeklyPaceMax)} / week`
          : ""
      }</p>`,
    );
  }
  if (src.breakdown) {
    moreBits.push(
      `<p class="budget-note">Prompt ${fmtNum(src.breakdown.promptTokens)} · output ${fmtNum(src.breakdown.outputTokens)} · ${fmtNum(src.breakdown.generations)} generations</p>`,
    );
  }
  const facts = renderFacts(src);
  if (facts) moreBits.push(facts);
  if (mode === "manual") {
    moreBits.push(
      `<p class="budget-note">Handmatige waarde — niet opnieuw gemeten bij deze snapshot.</p>`,
    );
  }
  if (Array.isArray(src.history) && src.history.length > 0) {
    moreBits.push(`
      <div class="history">
        <p class="history-label">Dagelijks</p>
        ${sparkBars(src.history)}
      </div>`);
  }
  const reason = renderReason(src.reason);
  if (reason) moreBits.push(reason);

  const more =
    moreBits.length > 0
      ? `<details class="card-more"><summary>Meer</summary>${moreBits.join("")}</details>`
      : "";

  // Home glance: name · live/stale · one number · reset. Everything else after tap.
  return `
    <article class="source-card" data-id="${src.id}" data-status="${escapeHtml(status)}" data-mode="${escapeHtml(mode)}"${capacityAttr}${staleAttr}>
      <div class="card-top">
        ${renderTitle(src)}
        <div class="badge-stack">
          <span class="badge ${collectionBadgeClass(mode)}">${escapeHtml(collectionLabel(mode))}</span>
          ${
            manualStale
              ? `<span class="badge badge-manual">verouderd</span>`
              : status === "unknown"
                ? `<span class="badge ${STATUS_CLASS.unknown}">${escapeHtml(STATUS_LABEL_NL.unknown)}</span>`
                : ""
          }
        </div>
      </div>
      ${renderSourceFreshness(src)}
      ${renderGlancePrimary(src)}
      ${more}
    </article>
  `;
}

function routingBucketMetric(bucket) {
  if (!bucket || typeof bucket !== "object") {
    return { value: "—", empty: true, sub: "no data", bar: null, count: "—" };
  }
  const local = bucket.local;
  const total = bucket.total;
  const percent = bucket.percent;
  const count =
    typeof local === "number" && typeof total === "number"
      ? `${fmtNum(local)} / ${fmtNum(total)} tasks`
      : "—";
  if (total === 0 || percent == null) {
    return {
      value: "—",
      empty: true,
      sub: total === 0 ? "0 tasks · not 0% local" : count,
      bar: null,
      count,
    };
  }
  return {
    value: `${fmtNum(percent)}%`,
    empty: false,
    sub: count,
    bar: Math.min(100, percent),
    count,
  };
}

function renderRoutingRow(label, bucket) {
  const metric = routingBucketMetric(bucket);
  return `
    <li class="component-row" data-role="routing">
      <span class="component-label">${escapeHtml(label)}</span>
      <div class="component-metric">
        <p class="primary-value${metric.empty ? " is-empty" : ""}">${escapeHtml(metric.value)}</p>
        <p class="primary-sub">${escapeHtml(metric.sub)}</p>
      </div>
      ${renderBar(metric.bar, metric.empty ? "" : "is-capacity")}
    </li>`;
}

/**
 * Top-level local-share card. Null / unproven routing ⇒ unavailable,
 * never fake zeros. Keep held state compact (no docs dump in the primary).
 */
function renderRoutingCard(routing) {
  if (routing == null) {
    return `
    <article class="source-card routing-card" data-id="local-share" data-status="unknown">
      <div class="card-top">
        <h2>Local share</h2>
        <span class="badge ${STATUS_CLASS.unknown}">${STATUS_LABEL_NL.unknown}</span>
      </div>
      <div class="primary-metric">
        <p class="primary-value is-empty">—</p>
        <p class="primary-sub">Geen routing-log</p>
      </div>
    </article>`;
  }

  // No percentage in either window ⇒ unavailable-with-reason, never a "measured"
  // badge over em dashes. `reason` is required by validateRouting in that case.
  const measured = routing.today?.percent != null || routing.rolling7d?.percent != null;
  if (!measured) {
    return `
    <article class="source-card routing-card" data-id="local-share" data-status="unknown">
      <div class="card-top">
        <h2>Local share</h2>
        <span class="badge ${STATUS_CLASS.unknown}">${STATUS_LABEL_NL.unknown}</span>
      </div>
      <div class="primary-metric">
        <p class="primary-value is-empty">—</p>
        <p class="primary-sub">Aangehouden — geen runtime-bewijs</p>
      </div>
      <details class="card-more"><summary>Meer</summary>${renderReason(routing.reason)}</details>
    </article>`;
  }

  const skipped =
    typeof routing.skipped === "number" && routing.skipped > 0
      ? `<p class="budget-note">${fmtNum(routing.skipped)} malformed log line(s) skipped</p>`
      : "";

  const today = routingBucketMetric(routing.today);
  return `
    <article class="source-card routing-card" data-id="local-share" data-status="measured">
      <div class="card-top">
        <h2>Local share</h2>
        <span class="badge ${STATUS_CLASS.measured}">${STATUS_LABEL_NL.measured}</span>
      </div>
      <div class="primary-metric">
        <p class="primary-value${today.empty ? " is-empty" : ""}">${escapeHtml(today.value)}</p>
        ${renderBar(today.bar, today.empty ? "" : "is-capacity")}
        <p class="primary-sub">Vandaag · ${escapeHtml(today.count)}</p>
      </div>
      <details class="card-more"><summary>Meer</summary>
        <ul class="component-list" aria-label="Local share vensters">
          ${renderRoutingRow("Vandaag", routing.today)}
          ${renderRoutingRow("Rolling 7 dagen", routing.rolling7d)}
        </ul>
        ${skipped}
        <dl class="facts">
          <div><dt>Laatste entry</dt><dd>${escapeHtml(fmtDate(routing.lastEntry))}</dd></div>
        </dl>
      </details>
    </article>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function isLocalAppHost() {
  const host = location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function setActionStatus(text, tone = "") {
  const el = document.getElementById("action-status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function setUpdateBusy(busy) {
  const btn = document.getElementById("btn-update");
  if (!btn) return;
  btn.disabled = busy;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
}

/**
 * Render snapshot into the page. Does not re-measure vendors — only paints JSON.
 * @param {{ snapshotUrl?: string }} [opts]
 */
async function renderDashboard(opts = {}) {
  const root = document.getElementById("dashboard");
  const meta = document.getElementById("snapshot-meta");
  const buildMeta = document.getElementById("build-meta");
  const bust = `t=${Date.now()}`;
  const snapshotUrl = opts.snapshotUrl || `./data/latest.json?${bust}`;

  const [snapshot, build] = await Promise.all([
    loadJson(snapshotUrl),
    loadJson(`./data/build-meta.json?${bust}`).catch(() => null),
  ]);

  const tz = snapshot.timezone || "Europe/Amsterdam";
  const stamp = snapshot.generatedAt
    ? fmtAmsterdamDateTime(snapshot.generatedAt)
    : "—";
  meta.textContent = `Laatst bijgewerkt: ${stamp} ${tz}`;
  meta.dataset.generatedAt = snapshot.generatedAt || "";
  updateMacBadge(snapshot.generatedAt);
  if (build?.version) {
    buildMeta.textContent = `Site v${build.version}${build.builtAt ? ` · ${fmtDate(build.builtAt)}` : ""} · snapshot v${snapshot.version || "?"}`;
  } else if (snapshot.version) {
    buildMeta.textContent = `Build v${snapshot.version}`;
  }

  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const routingCard = renderRoutingCard(
    "routing" in snapshot ? snapshot.routing : null,
  );
  const body =
    sources.map(renderCard).join("") + routingCard ||
    `<p class="error-banner">Geen bronnen in snapshot.</p>`;
  root.innerHTML = body
    ? `<div class="settings-group">${body}</div>`
    : body;

  return snapshot;
}

/**
 * Same-origin local collect only (Mac app server). Never called from github.io.
 * Never invokes Codex, Grok, or any AI agent — only LaunchAgent / local-snapshot.
 */
async function triggerLocalCollect() {
  const healthRes = await fetch("/api/health", { cache: "no-store" });
  if (!healthRes.ok) {
    throw new Error("Lokale collect-API niet bereikbaar.");
  }
  const health = await healthRes.json();
  if (!health?.collect) {
    throw new Error("Deze host biedt geen collect aan.");
  }
  const res = await fetch("/api/collect", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: "{}",
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body?.ok) {
    throw new Error(body?.message || `Collect mislukt (HTTP ${res.status}).`);
  }
  return body;
}

async function waitForNewerSnapshot(previousGeneratedAt, attempts = 24) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const snap = await loadJson(`./data/latest.json?t=${Date.now()}`);
      if (
        snap?.generatedAt &&
        snap.generatedAt !== previousGeneratedAt
      ) {
        return snap;
      }
    } catch {
      /* keep polling */
    }
  }
  return null;
}

/**
 * "Alles updaten"
 * - On GitHub Pages: re-fetch published latest.json only (no vendor re-measure).
 * - On local Mac app (127.0.0.1): also POST /api/collect → LaunchAgent/local-snapshot.
 * Never uses Codex, Grok, cloud agents, or browser bots.
 */
async function handleUpdateClick() {
  setUpdateBusy(true);
  setActionStatus("Bezig…", "busy");
  const previous = document.getElementById("snapshot-meta")?.dataset.generatedAt || "";

  try {
    if (isLocalAppHost()) {
      try {
        const result = await triggerLocalCollect();
        setActionStatus(
          `${result.message || "Collect gestart."} Wacht op nieuwe snapshot…`,
          "busy",
        );
        const newer = await waitForNewerSnapshot(previous);
        await renderDashboard();
        if (newer) {
          setActionStatus("Alles bijgewerkt (lokale collect).", "ok");
        } else {
          setActionStatus(
            "Collect gestart; snapshot nog niet vernieuwd — probeer zo opnieuw of wacht op de LaunchAgent.",
            "warn",
          );
        }
        return;
      } catch (err) {
        // Fall through to Pages-style refresh if local API is down.
        setActionStatus(
          `${err.message || "Lokale collect mislukt."} Ververs snapshot…`,
          "warn",
        );
      }
    }

    await renderDashboard();
    if (isLocalAppHost()) {
      setActionStatus("Snapshot ververst (geen lokale collect).", "ok");
    } else {
      setActionStatus(
        "Snapshot ververst. Meters meet de Mac elke 15 min — deze knop meet niet opnieuw vanaf Pages.",
        "ok",
      );
    }
  } catch (err) {
    setActionStatus(err.message || "Updaten mislukt.", "err");
  } finally {
    setUpdateBusy(false);
  }
}

async function main() {
  const btn = document.getElementById("btn-update");
  if (btn) {
    btn.addEventListener("click", () => {
      handleUpdateClick();
    });
  }

  try {
    await renderDashboard({ snapshotUrl: "./data/latest.json" });
  } catch (err) {
    const meta = document.getElementById("snapshot-meta");
    const root = document.getElementById("dashboard");
    if (meta) meta.textContent = "Kon snapshot niet laden.";
    if (root) {
      root.innerHTML = `<p class="error-banner">${escapeHtml(err.message || "Load failed")}</p>`;
    }
  }
}

// Browser-only boot. Node tests import macPresence without starting the app.
if (typeof document !== "undefined") {
  main();

  // Soft refresh of the published snapshot between LaunchAgent runs.
  setInterval(() => {
    renderDashboard().catch(() => {});
  }, 5 * 60 * 1000);
}
