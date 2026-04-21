const STORAGE_KEYS = {
  cache: "analysisCache",
  history: "analysisHistory",
  saved: "savedSnapshots"
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 3;
const MAX_SAVED = 12;

const analyzeButton = document.getElementById("analyzeButton");
const saveButton = document.getElementById("saveButton");
const exportJsonButton = document.getElementById("exportJsonButton");
const copyCssButton = document.getElementById("copyCssButton");
const highlightButton = document.getElementById("highlightButton");
const statusCard = document.getElementById("statusCard");
const loader = document.getElementById("loader");
const results = document.getElementById("results");
const sectionTemplate = document.getElementById("sectionTemplate");
const heroStatus = document.getElementById("heroStatus");
const toast = document.getElementById("toast");
const statInsights = document.getElementById("statInsights");
const statContrast = document.getElementById("statContrast");
const statSaved = document.getElementById("statSaved");

const state = {
  current: null,
  saved: [],
  history: [],
  highlightsEnabled: false
};

init();

bindClick(analyzeButton, () => {
  analyzeActiveTab().catch((error) => {
    showError(error instanceof Error ? error.message : "Something went wrong during analysis.");
  });
});

bindClick(saveButton, () => {
  saveCurrentSnapshot().catch((error) => {
    showToast(error instanceof Error ? error.message : "Unable to save snapshot.", true);
  });
});

bindClick(exportJsonButton, () => exportCurrentSnapshot("json"));
bindClick(copyCssButton, () => exportCurrentSnapshot("css"));
bindClick(highlightButton, () => {
  toggleHighlights().catch((error) => {
    showToast(error instanceof Error ? error.message : "Unable to toggle highlights.", true);
  });
});

async function init() {
  try {
    const stored = await storageGet([STORAGE_KEYS.saved, STORAGE_KEYS.history]);
    state.saved = stored[STORAGE_KEYS.saved] || [];
    state.history = stored[STORAGE_KEYS.history] || [];
  } catch (_error) {
    state.saved = [];
    state.history = [];
    showToast("Storage unavailable, running in temporary mode.", true);
  }

  animateStat(statSaved, state.saved.length);
  renderPersistentSections();
}

async function analyzeActiveTab() {
  setLoadingState(true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab available.");
  }

  if (!/^https?:/.test(tab.url)) {
    throw new Error("Open a regular website page to analyze its UI.");
  }

  const cacheData = await storageGet(STORAGE_KEYS.cache);
  const cache = cacheData[STORAGE_KEYS.cache] || {};
  const cachedEntry = cache[tab.url];

  let report;
  let source = "live";
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL_MS) {
    report = cachedEntry.report;
    source = "cache";
  } else {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "ANALYZE_UI" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Receiving end does not exist")) {
        throw new Error("Refresh this page once, then run the analysis again.");
      }
      throw error;
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to inspect this page.");
    }

    report = response.report;
  }

  const snapshot = buildAuditSnapshot(report, tab.url);
  state.current = {
    url: tab.url,
    report,
    snapshot,
    createdAt: Date.now()
  };

  await persistAnalysis(state.current, source === "live");
  setLoadingState(false, true);
  renderReport();
  showToast(source === "cache" ? "Loaded cached analysis." : "Analysis complete.");
}

async function persistAnalysis(current, updateCache) {
  const storageUpdate = {};

  if (updateCache) {
    const cacheData = await storageGet(STORAGE_KEYS.cache);
    const cache = cacheData[STORAGE_KEYS.cache] || {};
    cache[current.url] = {
      timestamp: current.createdAt,
      report: current.report
    };
    storageUpdate[STORAGE_KEYS.cache] = cache;
  }

  const nextHistory = [historyEntryFromCurrent(current), ...state.history.filter((entry) => entry.url !== current.url)]
    .slice(0, MAX_HISTORY);

  state.history = nextHistory;
  storageUpdate[STORAGE_KEYS.history] = nextHistory;
  await storageSet(storageUpdate);
}

function renderReport() {
  if (!state.current) {
    renderPersistentSections();
    return;
  }

  const { snapshot } = state.current;
  results.innerHTML = "";

  animateStat(statInsights, snapshot.insights.length);
  animateStat(statContrast, snapshot.contrast.length);
  animateStat(statSaved, state.saved.length);

  setActionState(true);
  highlightButton.textContent = state.highlightsEnabled ? "Hide highlights" : "Highlight issues";
  heroStatus.lastElementChild.textContent = "Analysis ready";

  results.append(renderOverviewSection(snapshot));
  results.append(renderUxScoreSection(snapshot.ux));
  results.append(renderUxIssuesSection(snapshot.ux));
  results.append(renderInsightsSection(snapshot.insights));
  results.append(renderContrastSection(snapshot.contrast));
  results.append(renderColorsSection(snapshot.colors));
  results.append(renderTypographySection(snapshot.typography));
  results.append(renderComponentsSection(snapshot.components));
  results.append(renderResponsiveSection(snapshot.ux.responsive));
  results.append(renderSpacingSection(snapshot.spacing));
  results.append(renderComparisonSection(snapshot.comparison));
  results.append(renderSavedSection(state.saved));
  results.append(renderExportSection(snapshot.exports));
  results.classList.remove("hidden");
}

function renderPersistentSections() {
  results.innerHTML = "";
  animateStat(statInsights, 0);
  animateStat(statContrast, 0);
  animateStat(statSaved, state.saved.length);
  heroStatus.lastElementChild.textContent = "Ready to audit";
  setActionState(false);
  highlightButton.textContent = "Highlight issues";

  results.append(renderSavedSection(state.saved));
  results.append(renderComparisonSection(buildEmptyComparison()));
  results.classList.remove("hidden");
}

function renderOverviewSection(snapshot) {
  const section = createSection("Overview", "Audit summary", "A quick product-level read of the interface.");
  section.querySelector(".section-body").innerHTML = `
    <div class="snapshot-grid">
      <article class="snapshot-card snapshot-card--primary">
        <span class="snapshot-card__label">Page</span>
        <strong>${escapeHtml(snapshot.page.title)}</strong>
        <p>${escapeHtml(snapshot.summary.headline)}</p>
      </article>
      <article class="snapshot-card">
        <span class="snapshot-card__label">Most useful takeaway</span>
        <strong>${escapeHtml(snapshot.summary.focus)}</strong>
        <p>${escapeHtml(snapshot.summary.detail)}</p>
      </article>
      <article class="snapshot-card">
        <span class="snapshot-card__label">Audit health</span>
        <strong>${snapshot.insights.length} insights</strong>
        <p>${snapshot.contrast.some((item) => item.tone === "warning") ? "Contrast needs review in at least one area." : "Core contrast checks look healthy."}</p>
      </article>
    </div>
  `;
  return section;
}

function renderInsightsSection(insights) {
  const section = createSection("Signals", "Insights", "Short, practical observations from the extracted design data.");
  const body = section.querySelector(".section-body");
  if (!insights.length) {
    body.innerHTML = `<p class="muted">No strong quality signals stood out.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="insight-list">
      ${insights.map((insight) => `
        <article class="insight-card tone-${escapeHtml(insight.tone)}">
          <strong>${escapeHtml(insight.title)}</strong>
          <p>${escapeHtml(insight.detail)}</p>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderUxScoreSection(ux) {
  const section = createSection("UX", "Score", "A lightweight score based on readability, interaction, accessibility, and hierarchy.");
  section.querySelector(".section-body").innerHTML = `
    <div class="snapshot-grid">
      <article class="snapshot-card snapshot-card--primary">
        <span class="snapshot-card__label">UX score</span>
        <strong>${ux.score.value} / 100</strong>
        <p>${escapeHtml(ux.score.summary)}</p>
      </article>
    </div>
  `;
  return section;
}

function renderUxIssuesSection(ux) {
  const section = createSection("Audit", "UX issues", "Top findings grouped by severity so the next fix is obvious.");
  const rows = [
    ...ux.issues.critical.map((item) => renderIssueRow("critical", item)),
    ...ux.issues.warnings.map((item) => renderIssueRow("warning", item)),
    ...ux.issues.good.map((item) => renderIssueRow("good", item))
  ].slice(0, 7);

  section.querySelector(".section-body").innerHTML = rows.length
    ? `<div class="insight-list">${rows.join("")}</div>`
    : `<p class="muted">No meaningful UX issues were detected.</p>`;
  return section;
}

function renderIssueRow(tone, item) {
  const icon = tone === "critical" ? "x" : tone === "warning" ? "!" : "ok";
  return `
    <article class="insight-card tone-${escapeHtml(tone === "good" ? "positive" : tone)}">
      <strong>${escapeHtml(item.title)}</strong>
      <p>${escapeHtml(item.detail)}</p>
      <small>${escapeHtml(icon.toUpperCase())}</small>
    </article>
  `;
}

function renderContrastSection(contrast) {
  const section = createSection("Access", "Contrast", "Quick WCAG-style checks for the most important text and action colors.");
  const body = section.querySelector(".section-body");
  if (!contrast.length) {
    body.innerHTML = `<p class="muted">Not enough color data was available for contrast checks.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="contrast-list">
      ${contrast.map((item) => `
        <article class="contrast-card tone-${escapeHtml(item.tone)}">
          <div class="contrast-card__head">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.status)}</span>
          </div>
          <p>${escapeHtml(item.detail)}</p>
          <small>Ratio ${item.ratio.toFixed(2)}:1</small>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderColorsSection(colors) {
  const section = createSection("Palette", "Colors", "Role-based palette summary with confidence labels.");
  const entries = Object.entries(colors).filter(([, value]) => value);
  const body = section.querySelector(".section-body");
  if (!entries.length) {
    body.innerHTML = `<p class="muted">No strong color roles were detected.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="color-palette-grid">
      ${entries.map(([role, color]) => `
        <article class="palette-card">
          <div class="palette-card__swatch" style="--swatch:${escapeHtml(color.hex)}"></div>
          <strong>${escapeHtml(role)}</strong>
          <span>${escapeHtml(color.hex)}</span>
          <small>${escapeHtml(color.confidence)}</small>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderTypographySection(typography) {
  const section = createSection("Type", "Typography", "Core text styles distilled into reusable roles.");
  const entries = [typography.heading, typography.body].filter(Boolean);
  const body = section.querySelector(".section-body");
  if (!entries.length) {
    body.innerHTML = `<p class="muted">Typography roles were not detected clearly.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="type-grid">
      ${entries.map((item) => `
        <article class="type-card dynamic-card">
          <div class="type-card__top">
            <span class="pill">${escapeHtml(item.label)}</span>
            <small>${escapeHtml(item.confidence)}</small>
          </div>
          <div class="type-card__meta">
            <strong>${escapeHtml(item.fontFamily)}</strong>
            <p>${escapeHtml(item.fontSize)} / ${escapeHtml(item.fontWeight)}</p>
          </div>
          <div class="type-preview" style="font-family:${escapeAttribute(item.fontFamily)};font-size:${escapeAttribute(item.fontSize)};font-weight:${escapeAttribute(item.fontWeight)}">
            ${escapeHtml(item.preview)}
          </div>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderComponentsSection(components) {
  const section = createSection("Components", "Preview blocks", "Visual previews of the most reusable patterns on the page.");
  const groups = [
    { title: "Button", item: components.button, type: "button" },
    { title: "Input", item: components.input, type: "input" },
    { title: "Card", item: components.card, type: "card" }
  ].filter((entry) => entry.item);
  const body = section.querySelector(".section-body");

  if (!groups.length) {
    body.innerHTML = `<p class="muted">No strong reusable component patterns were detected.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="component-layout">
      ${groups.map((group) => `
        <section class="component-group dynamic-card">
          <div class="component-group__head">
            <h3>${escapeHtml(group.title)}</h3>
            <span>${escapeHtml(group.item.confidence)}</span>
          </div>
          <article class="component-card">
            <div class="component-card__preview">${buildComponentPreview(group.item, group.type)}</div>
            <div class="component-card__meta">
              <strong>${escapeHtml(group.item.label)}</strong>
              <div class="component-tags">
                ${group.item.backgroundColor ? renderTag(`Background ${group.item.backgroundColor}`) : ""}
                ${group.item.borderRadius ? renderTag(`Radius ${group.item.borderRadius}`) : ""}
                ${group.item.padding ? renderTag(`Padding ${group.item.padding}`) : ""}
                ${group.item.borderStyle ? renderTag(`Border ${group.item.borderStyle}`) : ""}
                ${group.item.surface ? renderTag(group.item.surface) : ""}
              </div>
            </div>
          </article>
        </section>
      `).join("")}
    </div>
  `;
  return section;
}

function renderSpacingSection(spacing) {
  const section = createSection("Spacing", "Scale", "Most repeated spacing values normalized into a working rhythm.");
  const body = section.querySelector(".section-body");
  if (!spacing.length) {
    body.innerHTML = `<p class="muted">Spacing pattern is somewhat consistent, but not strong enough to call a clear scale.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="spacing-scale">
      ${spacing.map((item) => `
        <article class="spacing-chip">
          <strong>${escapeHtml(item.value)}</strong>
          <span>${escapeHtml(item.label)}</span>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderResponsiveSection(responsive) {
  const safeResponsive = responsive || buildFallbackResponsive();
  const section = createSection("Responsive", "Responsive UX", "Quick desktop and mobile usability checks from the sampled viewport.");
  section.querySelector(".section-body").innerHTML = `
    <div class="snapshot-grid">
      <article class="snapshot-card">
        <span class="snapshot-card__label">Desktop</span>
        <strong>${escapeHtml(safeResponsive.desktop[0]?.title || "Desktop review")}</strong>
        <p>${escapeHtml(safeResponsive.desktop[0]?.detail || "Desktop layout looks stable.")}</p>
      </article>
      <article class="snapshot-card">
        <span class="snapshot-card__label">Mobile</span>
        <strong>${escapeHtml(safeResponsive.mobile[0]?.title || "Mobile review")}</strong>
        <p>${escapeHtml(safeResponsive.mobile[0]?.detail || "Mobile sizing looks reasonable.")}</p>
      </article>
    </div>
  `;
  return section;
}

function renderComparisonSection(comparison) {
  const section = createSection("Compare", "Recent pages", "A lightweight comparison against your most recent analyses.");
  const body = section.querySelector(".section-body");
  if (!comparison.reference) {
    body.innerHTML = `<p class="muted">Analyze at least two pages to unlock page-to-page comparison.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="comparison-card">
      <strong>${escapeHtml(comparison.title)}</strong>
      <p>${escapeHtml(comparison.reference)}</p>
      <ul class="flat-list">
        ${comparison.points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}
      </ul>
    </div>
  `;
  return section;
}

function renderSavedSection(saved) {
  const section = createSection("Saved", "Design library", "Keep a short list of saved audits for later reference.");
  const body = section.querySelector(".section-body");
  if (!saved.length) {
    body.innerHTML = `<p class="muted">Saved snapshots will appear here.</p>`;
    return section;
  }

  body.innerHTML = `
    <div class="saved-list">
      ${saved.slice(0, 5).map((item) => `
        <article class="saved-card">
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.url)}</p>
          <small>${escapeHtml(formatDate(item.savedAt))}</small>
        </article>
      `).join("")}
    </div>
  `;
  return section;
}

function renderExportSection(exportsData) {
  const section = createSection("Export", "Shareable output", "Useful developer exports for handoff and reuse.");
  section.querySelector(".section-body").innerHTML = `
    <div class="export-grid">
      <article class="export-card">
        <span class="snapshot-card__label">JSON preview</span>
        <pre class="token-block">${escapeHtml(exportsData.jsonPreview)}</pre>
      </article>
      <article class="export-card">
        <span class="snapshot-card__label">CSS variables</span>
        <pre class="token-block token-block--light">${escapeHtml(exportsData.cssVariables)}</pre>
      </article>
    </div>
  `;
  return section;
}

async function saveCurrentSnapshot() {
  if (!state.current) {
    return;
  }

  const entry = {
    id: String(Date.now()),
    title: state.current.snapshot.page.title,
    url: state.current.url,
    savedAt: Date.now(),
    snapshot: state.current.snapshot
  };

  state.saved = [entry, ...state.saved].slice(0, MAX_SAVED);
  await storageSet({ [STORAGE_KEYS.saved]: state.saved });
  animateStat(statSaved, state.saved.length);
  renderReport();
  showToast("Snapshot saved.");
}

async function exportCurrentSnapshot(type) {
  if (!state.current) {
    return;
  }

  const payload = type === "json"
    ? state.current.snapshot.exports.json
    : state.current.snapshot.exports.cssVariables;

  if (type === "json") {
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "ui-analyzer-snapshot.json";
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("JSON export ready.");
    return;
  }

  await navigator.clipboard.writeText(payload);
  showToast("CSS variables copied.");
}

function setLoadingState(isLoading, hasResults = false) {
  analyzeButton.disabled = isLoading;
  analyzeButton.firstElementChild.textContent = isLoading ? "Analyzing..." : "Analyze current page";
  loader.classList.toggle("hidden", !isLoading);
  statusCard.classList.toggle("hidden", isLoading || hasResults);
  results.classList.toggle("hidden", isLoading || !hasResults);
  heroStatus.lastElementChild.textContent = isLoading ? "Running audit" : "Ready to audit";
}

function setActionState(hasCurrent) {
  saveButton.disabled = !hasCurrent;
  exportJsonButton.disabled = !hasCurrent;
  copyCssButton.disabled = !hasCurrent;
  highlightButton.disabled = !hasCurrent;
}

function showError(message) {
  setLoadingState(false, false);
  heroStatus.lastElementChild.textContent = "Needs attention";
  statusCard.className = "status-card error-state";
  statusCard.innerHTML = `
    <div class="status-icon">!</div>
    <h2>Analysis unavailable</h2>
    <p>${escapeHtml(message)}</p>
  `;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast ${isError ? "toast--error" : ""}`;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 2200);
}

function buildAuditSnapshot(report, url) {
  const processed = report.processed || {};
  const colors = detectColorRoles(report.colors || []);
  const typography = buildTypographySystem(
    processed.fonts || [],
    processed.fontSizes || [],
    processed.fontWeights || [],
    report.typography || { heading: [], body: [] }
  );
  const components = summarizeComponentPatterns(report.components || {});
  const spacing = buildSpacingScale(processed.spacing || []);
  const contrast = buildContrastChecks(colors);
  const insights = buildInsights({ colors, typography, components, spacing, processed, contrast, ux: report.ux || buildFallbackUx() });
  const comparison = buildComparison(url, colors, typography);
  const tokens = buildDesignTokens(colors, typography, components, spacing);
  const exportsData = buildExports(tokens, { colors, typography, components, spacing, insights, contrast });

  return {
    page: {
      title: report.page?.title || "Untitled page",
      url
    },
    colors,
    typography,
    components,
    spacing,
    contrast,
    insights,
    comparison,
    tokens,
    exports: exportsData,
    summary: buildSummary(colors, typography, insights),
    ux: report.ux || buildFallbackUx()
  };
}

function detectColorRoles(colors) {
  const enriched = colors.map((color) => {
    const rgb = hexToRgb(color.hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    return {
      ...color,
      rgb,
      hsl,
      brightness: getBrightness(rgb.r, rgb.g, rgb.b),
      isNeutral: hsl.s < 0.12
    };
  });

  const assigned = new Set();
  const background = selectRole(enriched, (color) => color.brightness > 0.9, assigned);
  const text = selectRole(enriched, (color) => color.brightness < 0.32, assigned);
  const primary = selectRole(
    enriched,
    (color) => !color.isNeutral && color.brightness > 0.18 && color.brightness < 0.82,
    assigned,
    (color) => color.count * (0.7 + color.hsl.s),
    true
  );
  const accent = selectRole(
    enriched,
    (color) => !color.isNeutral && color.brightness > 0.22 && color.brightness < 0.86,
    assigned,
    (color) => color.hsl.s * 120 + color.count * 0.35,
    true
  );

  return {
    Primary: formatRole(primary, "dominant brand-like color", colors),
    Background: formatRole(background, "most likely canvas color", colors),
    Text: formatRole(text, "strongest readable text tone", colors),
    Accent: formatRole(accent, "supporting highlight color", colors)
  };
}

function buildTypographySystem(fonts, fontSizes, fontWeights, fallbackTypography) {
  const primaryFont = titleCaseValue(
    fonts[0]?.font ||
    fallbackTypography.body?.[0]?.fontFamily ||
    fallbackTypography.heading?.[0]?.fontFamily ||
    "System"
  );
  const sortedSizes = [...fontSizes].sort((a, b) => parseInt(b.size, 10) - parseInt(a.size, 10));
  const commonSize = [...fontSizes].sort((a, b) => b.count - a.count)[0];
  const heavyWeight = [...fontWeights].sort((a, b) => parseInt(b.weight, 10) - parseInt(a.weight, 10))[0];
  const commonWeight = [...fontWeights].sort((a, b) => b.count - a.count)[0];
  const sizeConfidence = getPatternConfidence(commonSize?.count || 0, fontSizes);
  const headingConfidence = getPatternConfidence(sortedSizes[0]?.count || 0, fontSizes, true);

  return {
    heading: {
      label: "Heading",
      fontFamily: primaryFont,
      fontSize: sortedSizes[0]?.size || `${fallbackTypography.heading?.[0]?.fontSize || 24}px`,
      fontWeight: heavyWeight?.weight || fallbackTypography.heading?.[0]?.fontWeight || "600",
      preview: "Hero headline",
      confidence: headingConfidence
    },
    body: {
      label: "Body",
      fontFamily: primaryFont,
      fontSize: commonSize?.size || `${fallbackTypography.body?.[0]?.fontSize || 16}px`,
      fontWeight: commonWeight?.weight || fallbackTypography.body?.[0]?.fontWeight || "400",
      preview: "Body copy that supports reading",
      confidence: sizeConfidence
    }
  };
}

function summarizeComponentPatterns(components) {
  return {
    button: summarizePattern(components.buttons, "Button"),
    input: summarizePattern(components.inputs, "Input"),
    card: summarizeCardPattern(components.cards)
  };
}

function summarizePattern(items = [], label) {
  if (!items?.length) {
    return null;
  }

  const top = [...items].sort((a, b) => b.count - a.count)[0];
  return {
    label,
    backgroundColor: top.backgroundColor,
    borderColor: top.borderColor,
    textColor: top.textColor,
    borderRadius: top.borderRadius,
    padding: top.padding,
    borderStyle: top.borderColor && top.borderColor !== "transparent" ? `1px solid ${top.borderColor}` : null,
    confidence: getPatternConfidence(top.count, items)
  };
}

function summarizeCardPattern(items = []) {
  if (!items?.length) {
    return null;
  }

  const top = [...items].sort((a, b) => b.count - a.count)[0];
  return {
    label: "Card",
    backgroundColor: top.backgroundColor,
    borderRadius: top.borderRadius,
    borderStyle: top.borderColor && top.borderColor !== "transparent" ? `1px solid ${top.borderColor}` : "Subtle border",
    shadowCss: top.shadow === "shadow" ? "0 18px 36px rgba(15, 23, 42, 0.12)" : "none",
    surface: top.shadow === "shadow" ? "Soft shadow" : "Outlined surface",
    confidence: getPatternConfidence(top.count, items)
  };
}

function buildSpacingScale(spacing = []) {
  return spacing
    .filter((item) => parseInt(item.value, 10) > 0)
    .slice(0, 4)
    .sort((a, b) => parseInt(a.value, 10) - parseInt(b.value, 10))
    .map((item, index) => ({
      value: item.value,
      label: ["Tight", "Base", "Roomy", "Wide"][index] || "Scale",
      confidence: getPatternConfidence(item.count || 0, spacing)
    }));
}

function buildContrastChecks(colors) {
  const checks = [];
  const text = colors.Text?.hex;
  const background = colors.Background?.hex;
  const primary = colors.Primary?.hex;

  if (text && background) {
    checks.push(formatContrastCheck("Primary text", text, background));
  }

  if (primary && background) {
    checks.push(formatContrastCheck("Primary action", primary, background));
  }

  if (colors.Accent?.hex && background) {
    checks.push(formatContrastCheck("Accent color", colors.Accent.hex, background));
  }

  return checks.slice(0, 3);
}

function buildInsights(context) {
  const insights = [];
  const spacingValues = context.spacing.map((item) => parseInt(item.value, 10)).filter(Boolean);
  const spacingPattern = detectSpacingPattern(spacingValues);
  if (spacingPattern) {
    insights.push({
      tone: "positive",
      title: "Spacing system detected",
      detail: `Consistent spacing rhythm around the ${spacingPattern}px scale.`
    });
  } else if (context.spacing.length >= 2) {
    insights.push({
      tone: "warning",
      title: "Spacing is mostly consistent",
      detail: `Spacing scale trends toward ${context.spacing.map((item) => item.value).join(" / ")}, but the pattern is not fully locked in.`
    });
  }

  if ((context.processed.fontSizes || []).length >= 5) {
    insights.push({
      tone: "warning",
      title: "Font sizing feels busy",
      detail: `${context.processed.fontSizes.length} font sizes appeared, which may reduce hierarchy clarity.`
    });
  } else {
    insights.push({
      tone: "positive",
      title: "Typography scale feels clear",
      detail: "The page keeps type sizes focused enough to stay readable and scannable."
    });
  }

  if (context.contrast.some((item) => item.tone === "warning")) {
    insights.push({
      tone: "warning",
      title: "Contrast needs attention",
      detail: "At least one key text or action color falls below a comfortable contrast threshold."
    });
  }

  if (context.colors.Primary?.confidence === "High confidence") {
    insights.push({
      tone: "positive",
      title: "Primary color is consistent",
      detail: "The interface appears to rely on one strong dominant brand color."
    });
  } else if (context.colors.Primary?.hex) {
    insights.push({
      tone: "positive",
      title: "Primary color is recognizable",
      detail: `A visible primary color (${context.colors.Primary.hex}) still anchors the interface.`
    });
  }

  if (context.components.button && context.components.input && context.components.button.borderRadius === context.components.input.borderRadius) {
    insights.push({
      tone: "neutral",
      title: "Component corners feel aligned",
      detail: `Buttons and inputs both cluster around ${context.components.button.borderRadius}, which helps consistency.`
    });
  }

  if (context.ux?.score?.value >= 80) {
    insights.push({
      tone: "positive",
      title: "Overall UX feels stable",
      detail: "The page avoids major usability breakdowns in the current viewport."
    });
  } else {
    insights.push({
      tone: "warning",
      title: "UX polish is still needed",
      detail: "A few usability details are holding the experience back from feeling fully refined."
    });
  }

  return prioritizeInsights(insights).slice(0, 5);
}

function buildComparison(url, colors, typography) {
  const reference = state.history.find((entry) => entry.url !== url);
  if (!reference) {
    return buildEmptyComparison();
  }

  const points = [];
  if (reference.primaryColor === colors.Primary?.hex) {
    points.push("Primary color stays consistent between the two pages.");
  } else {
    points.push(`Primary color shifts from ${reference.primaryColor || "unknown"} to ${colors.Primary?.hex || "unknown"}.`);
  }

  if (reference.bodyFont === typography.body?.fontFamily) {
    points.push("Body typography is consistent across pages.");
  } else {
    points.push(`Body typography changes from ${reference.bodyFont || "unknown"} to ${typography.body?.fontFamily || "unknown"}.`);
  }

  points.push(`Compared with ${reference.title}, this page uses ${reference.spacingCount === 0 ? "a newly visible" : "a similar"} spacing rhythm.`);

  return {
    title: `${state.current ? state.current.snapshot.page.title : "Current page"} vs recent page`,
    reference: reference.title,
    points
  };
}

function buildEmptyComparison() {
  return {
    title: "",
    reference: "",
    points: []
  };
}

function buildDesignTokens(colors, typography, components, spacing) {
  return {
    colors: {
      primary: colors.Primary?.hex || null,
      background: colors.Background?.hex || null,
      text: colors.Text?.hex || null,
      accent: colors.Accent?.hex || null
    },
    typography: {
      body: typography.body ? {
        family: typography.body.fontFamily,
        size: typography.body.fontSize,
        weight: typography.body.fontWeight
      } : null,
      heading: typography.heading ? {
        family: typography.heading.fontFamily,
        size: typography.heading.fontSize,
        weight: typography.heading.fontWeight
      } : null
    },
    components: {
      button: components.button ? {
        background: components.button.backgroundColor,
        radius: components.button.borderRadius,
        padding: components.button.padding
      } : null,
      input: components.input ? {
        radius: components.input.borderRadius,
        border: components.input.borderStyle
      } : null,
      card: components.card ? {
        radius: components.card.borderRadius,
        surface: components.card.surface
      } : null
    },
    spacing: spacing.map((item) => item.value)
  };
}

function buildExports(tokens, extras) {
  const jsonObject = {
    tokens,
    insights: extras.insights,
    contrast: extras.contrast
  };
  const json = JSON.stringify(jsonObject, null, 2);

  const cssVariables = [
    ":root {",
    tokens.colors.primary ? `  --color-primary: ${tokens.colors.primary};` : null,
    tokens.colors.background ? `  --color-background: ${tokens.colors.background};` : null,
    tokens.colors.text ? `  --color-text: ${tokens.colors.text};` : null,
    tokens.colors.accent ? `  --color-accent: ${tokens.colors.accent};` : null,
    tokens.typography.body?.family ? `  --font-body: "${tokens.typography.body.family}";` : null,
    tokens.typography.heading?.family ? `  --font-heading: "${tokens.typography.heading.family}";` : null,
    tokens.typography.body?.size ? `  --font-size-body: ${tokens.typography.body.size};` : null,
    tokens.components.button?.radius ? `  --radius-button: ${tokens.components.button.radius};` : null,
    tokens.spacing[0] ? `  --space-base: ${tokens.spacing[0]};` : null,
    "}"
  ].filter(Boolean).join("\n");

  return {
    json,
    jsonPreview: truncateMultiline(json, 18),
    cssVariables
  };
}

function buildSummary(colors, typography, insights) {
  return {
    headline: colors.Primary?.hex ? `Primary color anchored by ${colors.Primary.hex}` : "Visual system needs more clarity",
    focus: typography.body ? `Body text centers on ${typography.body.fontSize}` : "Typography system still unclear",
    detail: insights[0]?.detail || "Core colors, type, components, and accessibility checks were grouped into one snapshot."
  };
}

async function toggleHighlights() {
  if (!state.current) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab available.");
  }

  state.highlightsEnabled = !state.highlightsEnabled;
  await chrome.tabs.sendMessage(tab.id, {
    type: "TOGGLE_UX_HIGHLIGHTS",
    enabled: state.highlightsEnabled
  });
  highlightButton.textContent = state.highlightsEnabled ? "Hide highlights" : "Highlight issues";
  showToast(state.highlightsEnabled ? "Problem areas highlighted on the page." : "Highlights removed.");
}

function buildFallbackUx() {
  return {
    issues: { critical: [], warnings: [], good: [] },
    score: { value: 80, summary: "Basic UX audit unavailable." },
    responsive: buildFallbackResponsive()
  };
}

function buildFallbackResponsive() {
  return {
    desktop: [
      {
        title: "Desktop review unavailable",
        detail: "Desktop responsiveness could not be evaluated from the current analysis."
      }
    ],
    mobile: [
      {
        title: "Mobile review unavailable",
        detail: "Mobile responsiveness could not be evaluated from the current analysis."
      }
    ]
  };
}

function buildComponentPreview(item, type) {
  if (type === "button") {
    return `
      <button class="preview-button" style="background:${escapeHtml(item.backgroundColor || "#2563EB")};color:${escapeHtml(item.textColor || "#FFFFFF")};border-radius:${escapeHtml(item.borderRadius || "12px")};padding:${escapeHtml(item.padding || "12px 18px")};border:${escapeHtml(item.borderStyle || "none")}">
        Primary action
      </button>
    `;
  }

  if (type === "input") {
    return `
      <div class="preview-input" style="border-radius:${escapeHtml(item.borderRadius || "12px")};padding:${escapeHtml(item.padding || "12px 14px")};background:${escapeHtml(item.backgroundColor || "#FFFFFF")};border:${escapeHtml(item.borderStyle || "1px solid rgba(148,163,184,0.3)")};color:${escapeHtml(item.textColor || "#0F172A")}">
        Search products
      </div>
    `;
  }

  return `
    <div class="preview-image" style="border-radius:${escapeHtml(item.borderRadius || "16px")};background:${escapeHtml(item.backgroundColor || "#FFFFFF")};border:${escapeHtml(item.borderStyle || "1px solid rgba(148,163,184,0.3)")};box-shadow:${escapeHtml(item.shadowCss || "none")}">
      <span>CARD</span>
    </div>
  `;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      resolve({});
      return;
    }

    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    if (!chrome?.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.set(values, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function bindClick(element, handler) {
  if (!element) {
    return;
  }
  element.addEventListener("click", handler);
}

function createSection(kicker, title, description) {
  const section = sectionTemplate.content.firstElementChild.cloneNode(true);
  section.querySelector(".section-kicker").textContent = kicker;
  section.querySelector("h2").textContent = title;
  section.querySelector(".section-description").textContent = description;
  return section;
}

function renderTag(label) {
  return `<span class="component-tag">${escapeHtml(label)}</span>`;
}

function historyEntryFromCurrent(current) {
  return {
    title: current.snapshot.page.title,
    url: current.url,
    primaryColor: current.snapshot.colors.Primary?.hex || null,
    bodyFont: current.snapshot.typography.body?.fontFamily || null,
    spacingCount: current.snapshot.spacing.length
  };
}

function selectRole(colors, predicate, assigned, scorer = (color) => color.count, avoidExtremes = false) {
  const selected = colors
    .filter((color) => !assigned.has(color.hex))
    .filter((color) => !avoidExtremes || (color.hex !== "#000000" && color.hex !== "#FFFFFF"))
    .filter(predicate)
    .sort((a, b) => scorer(b) - scorer(a))[0] || null;

  if (selected) {
    assigned.add(selected.hex);
  }

  return selected;
}

function formatRole(color, reason, allColors) {
  if (!color) {
    return null;
  }
  return {
    hex: color.hex,
    reason,
    confidence: getPatternConfidence(color.count, allColors || [])
  };
}

function formatContrastCheck(label, foreground, background) {
  const ratio = getContrastRatio(foreground, background);
  const good = ratio >= 4.5;
  return {
    label,
    ratio,
    status: good ? "Good" : "Low",
    tone: good ? "positive" : "warning",
    detail: `${foreground} on ${background}`
  };
}

function getContrastRatio(foreground, background) {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  const l1 = getRelativeLuminance(fg.r, fg.g, fg.b);
  const l2 = getRelativeLuminance(bg.r, bg.g, bg.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function getRelativeLuminance(r, g, b) {
  const transform = (value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };

  const [rs, gs, bs] = [transform(r), transform(g), transform(b)];
  return rs * 0.2126 + gs * 0.7152 + bs * 0.0722;
}

function detectSpacingPattern(values) {
  if (values.length < 2) {
    return null;
  }
  const candidates = [4, 8, 12];
  return candidates.find((base) => values.every((value) => value % base === 0)) || null;
}

function getConfidenceLabel(count, thresholds) {
  if (count >= thresholds[0]) {
    return "High confidence";
  }
  if (count >= thresholds[1]) {
    return "Medium confidence";
  }
  return "Low confidence";
}

function getPatternConfidence(primaryCount, items, preferHigh = false) {
  const total = Array.isArray(items)
    ? items.reduce((sum, item) => sum + (item.count || 0), 0)
    : 0;
  if (!total) {
    return preferHigh ? "Medium confidence" : "Low confidence";
  }

  const ratio = primaryCount / total;
  if (ratio >= 0.4 || (preferHigh && ratio >= 0.3)) {
    return "High confidence";
  }
  if (ratio >= 0.22) {
    return "Medium confidence";
  }
  return "Low confidence";
}

function prioritizeInsights(insights) {
  const seen = new Set();
  const deduped = insights.filter((item) => {
    const key = `${item.title}|${item.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const positives = deduped.filter((item) => item.tone === "positive");
  const warnings = deduped.filter((item) => item.tone === "warning");
  const neutral = deduped.filter((item) => item.tone !== "positive" && item.tone !== "warning");
  return [...positives.slice(0, 2), ...warnings.slice(0, 2), ...neutral, ...positives.slice(2), ...warnings.slice(2)];
}

function titleCaseValue(value) {
  return String(value)
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateMultiline(value, maxLines) {
  const lines = value.split("\n");
  return lines.length <= maxLines ? value : `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function animateStat(node, target) {
  const duration = 420;
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / duration, 1);
    node.textContent = Math.round(target * (1 - Math.pow(1 - progress, 3)));
    if (progress < 1) {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
}

function hexToRgb(hex) {
  const safe = hex.replace("#", "");
  return {
    r: parseInt(safe.slice(0, 2), 16),
    g: parseInt(safe.slice(2, 4), 16),
    b: parseInt(safe.slice(4, 6), 16)
  };
}

function getBrightness(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 255000;
}

function rgbToHsl(r, g, b) {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    switch (max) {
      case nr:
        hue = ((ng - nb) / delta) % 6;
        break;
      case ng:
        hue = (nb - nr) / delta + 2;
        break;
      default:
        hue = (nr - ng) / delta + 4;
        break;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }

  return { h: hue, s: saturation, l: lightness };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "");
}
