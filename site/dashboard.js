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

function fmtDate(isoOrDay) {
  if (!isoOrDay) return "—";
  const d = new Date(isoOrDay);
  if (Number.isNaN(d.getTime())) return String(isoOrDay);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    dateStyle: "medium",
    timeStyle: isoOrDay.includes("T") ? "short" : undefined,
  }).format(d);
}

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

function renderSourceFreshness(src) {
  const mode = src.collectionMode || "unavailable";
  if (mode !== "manual") return "";
  const age = readingAge(src.lastUpdate);
  const observed = src.lastUpdate
    ? fmtAmsterdamDateTime(src.lastUpdate)
    : "onbekend";
  const ageText = age ? `${age.label} oud` : "leeftijd onbekend";
  const staleClass = age?.stale ? " is-stale" : "";
  return `
    <p class="source-freshness${staleClass}" data-mode="manual">
      <span class="source-freshness-main">Afgelezen ${escapeHtml(observed)} · ${escapeHtml(ageText)}</span>
      <span class="source-freshness-note">handmatige bron — niet opnieuw gemeten bij deze snapshot</span>
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
    return "Unavailable";
  }
  if (src.usage == null && src.limit == null) return "No limit available";
  if (src.usage != null && src.limit == null) {
    const unit = src.unit ? ` ${src.unit}` : "";
    return `${fmtNum(src.usage)}${unit} · no limit available`;
  }
  const u = src.usage == null ? "—" : fmtNum(src.usage);
  const lim = src.limit == null ? "—" : fmtNum(src.limit);
  const unit = src.unit ? ` ${src.unit}` : "";
  return `${u} / ${lim}${unit}`;
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
      sub: src.limit == null ? `${unit.trim()} · no limit` : usageLabel(src),
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
      ? "Plan capacity ample"
      : tone === "moderate"
        ? "Plan capacity moderate"
        : "Plan capacity tighter";
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

function renderComponents(components) {
  if (!Array.isArray(components) || components.length === 0) return "";
  const capacity = components.filter((c) => c.role === "capacity");
  const capped = components.filter((c) => c.role === "capped");
  const plain = components.filter(
    (c) => c.role !== "capacity" && c.role !== "capped",
  );

  if (!capacity.length && !capped.length) {
    return `
    <ul class="component-list" aria-label="Usage components">
      ${components.map(renderComponentRow).join("")}
    </ul>`;
  }

  const callout = capacityCallout(components);
  return `
    ${callout.html}
    ${renderComponentGroup("Plan capacity", capacity, "Plan capacity")}
    ${renderComponentGroup("Separate caps", capped, "Separate caps")}
    ${
      plain.length
        ? renderComponentGroup("Other meters", plain, "Other meters")
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

function renderCard(src) {
  const status = src.status || "unknown";
  const hasComponents =
    Array.isArray(src.components) && src.components.length > 0;
  const budget =
    src.budget?.monthly != null
      ? `<p class="budget-note">Budget ${fmtNum(src.budget.monthly)}/mo · pace ≤ ${fmtNum(src.budget.weeklyPaceMax)}/wk</p>`
      : "";
  const mode = src.collectionMode || "unavailable";
  const tokenBreakdown = src.breakdown
    ? `<p class="budget-note">Prompt ${fmtNum(src.breakdown.promptTokens)} · output ${fmtNum(src.breakdown.outputTokens)} · ${fmtNum(src.breakdown.generations)} generations</p>`
    : "";
  // Never promote a single aggregate % when components exist — that is how a
  // full on-demand/Grok meter incorrectly reads as the whole source being maxed.
  const aggregate = hasComponents ? "" : renderPrimary(primaryDisplay(src));
  const capacityTone = cardCapacityTone(src);
  const capacityAttr = capacityTone
    ? ` data-capacity="${escapeHtml(capacityTone)}"`
    : "";
  const manualStale =
    mode === "manual" && readingAge(src.lastUpdate)?.stale === true;
  const staleAttr = manualStale ? ' data-freshness="stale"' : "";

  return `
    <article class="source-card" data-id="${src.id}" data-status="${escapeHtml(status)}"${capacityAttr}${staleAttr}>
      <div class="card-top">
        ${renderTitle(src)}
        <span class="badge ${STATUS_CLASS[status] || STATUS_CLASS.unknown}">${escapeHtml(STATUS_LABEL[status] || STATUS_LABEL.unknown)}</span>
      </div>
      ${renderSourceFreshness(src)}
      ${aggregate}
      ${renderComponents(src.components)}
      ${budget}
      ${tokenBreakdown}
      ${renderReason(src.reason)}
      <dl class="facts">
        <div><dt>Reset</dt><dd>${escapeHtml(src.resetDate ? fmtDate(src.resetDate) : "—")}</dd></div>
        <div><dt>Last update</dt><dd>${escapeHtml(formatLastUpdateFact(src))}</dd></div>
        <div><dt>Collection</dt><dd>${escapeHtml(mode)}</dd></div>
        <div><dt>Coverage starts</dt><dd>${escapeHtml(fmtDate(src.coverageStart))}</dd></div>
        <div><dt>Daily pace</dt><dd>${escapeHtml(fmtNum(src.pace?.daily))}</dd></div>
        <div><dt>Monthly pace</dt><dd>${escapeHtml(fmtNum(src.pace?.monthly))}</dd></div>
        <div><dt>Weekly target</dt><dd>${escapeHtml(fmtNum(src.pace?.weeklyTarget))}</dd></div>
        <div><dt>Unit</dt><dd>${escapeHtml(src.unit || "—")}</dd></div>
      </dl>
      <div class="history">
        <p class="history-label">Daily history</p>
        ${sparkBars(src.history)}
      </div>
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
 * Top-level local-share card. Null routing ⇒ unavailable with reason
 * (missing/unreadable log), never fake zeros.
 */
function renderRoutingCard(routing) {
  if (routing == null) {
    return `
    <article class="source-card routing-card" data-id="local-share" data-status="unknown">
      <div class="card-top">
        <h2>Local share</h2>
        <span class="badge ${STATUS_CLASS.unknown}">${STATUS_LABEL.unknown}</span>
      </div>
      <div class="primary-metric">
        <p class="primary-value is-empty">—</p>
        <p class="primary-sub">Routing log missing or unreadable</p>
      </div>
      <p class="budget-note">Share of delegated tasks that went to LocalAI guy.</p>
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
        <span class="badge ${STATUS_CLASS.unknown}">${STATUS_LABEL.unknown}</span>
      </div>
      <div class="primary-metric">
        <p class="primary-value is-empty">—</p>
        <p class="primary-sub">${escapeHtml(routing.reason ?? "No verified routing data")}</p>
      </div>
      <p class="budget-note">Share of delegated tasks that went to LocalAI guy.</p>
    </article>`;
  }

  const skipped =
    typeof routing.skipped === "number" && routing.skipped > 0
      ? `<p class="budget-note">${fmtNum(routing.skipped)} malformed log line(s) skipped</p>`
      : "";

  return `
    <article class="source-card routing-card" data-id="local-share" data-status="measured">
      <div class="card-top">
        <h2>Local share</h2>
        <span class="badge ${STATUS_CLASS.measured}">${STATUS_LABEL.measured}</span>
      </div>
      <p class="budget-note">Share of delegated tasks that went to LocalAI guy.</p>
      <ul class="component-list" aria-label="Local share windows">
        ${renderRoutingRow("Today", routing.today)}
        ${renderRoutingRow("Rolling 7 days", routing.rolling7d)}
      </ul>
      ${skipped}
      <dl class="facts">
        <div><dt>Last entry</dt><dd>${escapeHtml(fmtDate(routing.lastEntry))}</dd></div>
        <div><dt>Today</dt><dd>${escapeHtml(routingBucketMetric(routing.today).count)}</dd></div>
        <div><dt>7-day</dt><dd>${escapeHtml(routingBucketMetric(routing.rolling7d).count)}</dd></div>
      </dl>
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

async function main() {
  const root = document.getElementById("dashboard");
  const meta = document.getElementById("snapshot-meta");
  const buildMeta = document.getElementById("build-meta");

  try {
    const [snapshot, build] = await Promise.all([
      loadJson("./data/latest.json"),
      loadJson("./data/build-meta.json").catch(() => null),
    ]);

    const tz = snapshot.timezone || "Europe/Amsterdam";
    const stamp = snapshot.generatedAt
      ? fmtAmsterdamDateTime(snapshot.generatedAt)
      : "—";
    meta.textContent = `Laatst bijgewerkt: ${stamp} ${tz}`;
    meta.dataset.generatedAt = snapshot.generatedAt || "";
    if (build?.version) {
      buildMeta.textContent = `Site build v${build.version}${build.builtAt ? ` · ${fmtDate(build.builtAt)}` : ""} · snapshot v${snapshot.version || "?"}`;
    } else if (snapshot.version) {
      buildMeta.textContent = `Build v${snapshot.version}`;
    }

    const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
    const routingCard = renderRoutingCard(
      "routing" in snapshot ? snapshot.routing : null,
    );
    root.innerHTML =
      sources.map(renderCard).join("") + routingCard ||
      `<p class="error-banner">No sources in snapshot.</p>`;
  } catch (err) {
    meta.textContent = "Could not load snapshot.";
    root.innerHTML = `<p class="error-banner">${escapeHtml(err.message || "Load failed")}</p>`;
  }
}

main();

// Keep an open dashboard current between the 15-minute local collector runs.
setInterval(main, 5 * 60 * 1000);
