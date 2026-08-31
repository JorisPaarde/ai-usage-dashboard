const STATUS_CLASS = {
  measured: "badge-measured",
  estimated: "badge-estimated",
  unknown: "badge-unknown",
};

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(n);
}

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

function usageLabel(src) {
  if (src.usage == null && src.limit == null) return "Usage unknown";
  const u = src.usage == null ? "—" : fmtNum(src.usage);
  const lim = src.limit == null ? "—" : fmtNum(src.limit);
  const unit = src.unit ? ` ${src.unit}` : "";
  return `${u} / ${lim}${unit}`;
}

function pct(src) {
  if (src.usage == null || src.limit == null || src.limit <= 0) return null;
  return Math.min(100, Math.round((src.usage / src.limit) * 1000) / 10);
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
        return `<span class="empty" title="${h.date}: unknown"></span>`;
      }
      const hPct = Math.max(8, Math.round((h.usage / max) * 100));
      return `<span style="height:${hPct}%" title="${h.date}: ${h.usage}"></span>`;
    })
    .join("");
  return `<div class="spark" role="img" aria-label="Daily usage history">${bars}</div>`;
}

function renderCard(src) {
  const status = src.status || "unknown";
  const p = pct(src);
  const barWidth = p == null ? 0 : p;
  const budget =
    src.budget?.monthly != null
      ? `<p class="budget-note">Budget ${fmtNum(src.budget.monthly)}/mo · pace ≤ ${fmtNum(src.budget.weeklyPaceMax)}/wk</p>`
      : "";

  return `
    <article class="source-card" data-id="${src.id}">
      <div class="card-top">
        <h2>${escapeHtml(src.name || src.id)}</h2>
        <span class="badge ${STATUS_CLASS[status] || STATUS_CLASS.unknown}">${escapeHtml(status)}</span>
      </div>
      <p class="reason">${escapeHtml(src.reason || "")}</p>
      ${budget}
      <div class="usage-row">
        <span>Usage vs limit</span>
        <strong>${escapeHtml(usageLabel(src))}</strong>
      </div>
      <div class="bar ${p == null ? "is-unknown" : ""}" aria-hidden="true"><span style="width:${barWidth}%"></span></div>
      <dl class="facts">
        <div><dt>Reset</dt><dd>${escapeHtml(src.resetDate ? fmtDate(src.resetDate) : "—")}</dd></div>
        <div><dt>Last update</dt><dd>${escapeHtml(fmtDate(src.lastUpdate))}</dd></div>
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

    meta.textContent = `Snapshot ${snapshot.generatedAt ? fmtDate(snapshot.generatedAt) : "—"} · ${snapshot.timezone || "Europe/Amsterdam"} · v${snapshot.version || "?"}`;
    if (build?.version) {
      buildMeta.textContent = `Site build v${build.version}${build.builtAt ? ` · ${fmtDate(build.builtAt)}` : ""}`;
    }

    const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
    root.innerHTML = sources.map(renderCard).join("") ||
      `<p class="error-banner">No sources in snapshot.</p>`;

    // Trigger bar animation after paint
    requestAnimationFrame(() => {
      root.querySelectorAll(".bar > span").forEach((el) => {
        const w = el.style.width;
        el.style.width = "0";
        requestAnimationFrame(() => {
          el.style.width = w;
        });
      });
    });
  } catch (err) {
    meta.textContent = "Could not load snapshot.";
    root.innerHTML = `<p class="error-banner">${escapeHtml(err.message || "Load failed")}</p>`;
  }
}

main();
