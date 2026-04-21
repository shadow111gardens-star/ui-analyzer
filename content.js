(() => {
  const MAX_COLOR_RESULTS = 8;
  const MAX_TYPOGRAPHY_RESULTS = 3;
  const MAX_COMPONENT_RESULTS = 3;
  const HIGHLIGHT_ATTR = "data-ui-analyzer-highlight";
  let highlightEnabled = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ANALYZE_UI") {
      try {
        sendResponse({ ok: true, report: analyzePage() });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown analysis error."
        });
      }
      return true;
    }

    if (message?.type === "TOGGLE_UX_HIGHLIGHTS") {
      highlightEnabled = Boolean(message.enabled);
      applyHighlightState(highlightEnabled);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function analyzePage() {
    const elements = Array.from(document.body?.querySelectorAll("*") ?? []);
    const visibleElements = elements.filter(isRelevantElement);

    const colorMap = new Map();
    const typographyMap = new Map();
    const fontMap = new Map();
    const fontSizeMap = new Map();
    const fontWeightMap = new Map();
    const spacingSamples = [];
    const componentBuckets = {
      buttons: new Map(),
      inputs: new Map(),
      images: new Map(),
      cards: new Map()
    };
    const ux = createUxCollector();

    let scannedElements = 0;

    for (const element of visibleElements) {
      if (scannedElements > 2200) {
        break;
      }

      const style = getComputedStyle(element);
      scannedElements += 1;

      collectColor(colorMap, style.color, "Text");
      collectColor(colorMap, style.backgroundColor, "Background");
      collectTypography(typographyMap, fontMap, fontSizeMap, fontWeightMap, element, style);
      collectSpacing(spacingSamples, style);
      collectComponent(componentBuckets, element, style);
      collectUxSignals(ux, element, style);
    }

    const uxSummary = finalizeUxAudit(ux);
    markHighlightTargets(uxSummary.highlights);
    applyHighlightState(highlightEnabled);

    return {
      page: {
        title: document.title || "Untitled page",
        url: location.href
      },
      colors: summarizeColors(colorMap),
      typography: summarizeTypography(typographyMap),
      processed: {
        fonts: summarizeSimpleCounts(fontMap, "font"),
        fontSizes: summarizeSimpleCounts(fontSizeMap, "size"),
        fontWeights: summarizeSimpleCounts(fontWeightMap, "weight"),
        spacing: summarizeSpacing(spacingSamples)
      },
      components: summarizeComponents(componentBuckets),
      ux: uxSummary,
      meta: {
        scannedElements
      }
    };
  }

  function isRelevantElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tag = element.tagName.toLowerCase();
    if (["script", "style", "link", "meta", "noscript", "svg", "path"].includes(tag)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || element.offsetWidth <= 0 || element.offsetHeight <= 0) {
      return false;
    }

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    return true;
  }

  function createUxCollector() {
    return {
      textSamples: [],
      interactive: [],
      headings: [],
      bodyTextSizes: [],
      sectionBlocks: []
    };
  }

  function collectColor(map, rawColor, category) {
    const normalized = normalizeColor(rawColor);
    if (!normalized) {
      return;
    }

    const existing = map.get(normalized.hex);
    if (existing) {
      existing.count += 1;
      existing.categories.add(category);
      return;
    }

    map.set(normalized.hex, {
      hex: normalized.hex,
      count: 1,
      categories: new Set([category])
    });
  }

  function collectTypography(map, fontMap, fontSizeMap, fontWeightMap, element, style) {
    const fontFamily = normalizeFontFamily(style.fontFamily);
    const fontSize = parseFloat(style.fontSize);
    const fontWeight = normalizeFontWeight(style.fontWeight);

    if (!fontFamily || Number.isNaN(fontSize)) {
      return;
    }

    incrementCount(fontMap, fontFamily.toLowerCase());
    incrementCount(fontSizeMap, `${Math.round(fontSize)}px`);
    incrementCount(fontWeightMap, fontWeight);

    const role = inferTextRole(element, fontSize, fontWeight);
    const key = [role, fontFamily, Math.round(fontSize), fontWeight].join("|");
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    map.set(key, {
      role,
      fontFamily,
      fontSize: Math.round(fontSize),
      fontWeight,
      count: 1
    });
  }

  function collectSpacing(samples, style) {
    [
      style.marginTop,
      style.marginBottom,
      style.marginLeft,
      style.marginRight,
      style.paddingTop,
      style.paddingBottom,
      style.paddingLeft,
      style.paddingRight,
      style.gap
    ]
      .map((value) => parseFloat(value))
      .filter((value) => !Number.isNaN(value) && value > 0)
      .forEach((value) => samples.push(value));
  }

  function collectComponent(buckets, element, style) {
    const tag = element.tagName.toLowerCase();
    const type = resolveComponentType(element, tag);

    if (type) {
      const payload = buildComponentPayload(type, element, style);
      if (payload) {
        storeComponentPayload(buckets[type], payload);
      }
    }

    if (looksLikeCard(element, tag, style)) {
      storeComponentPayload(buckets.cards, buildCardPayload(element, style));
    }
  }

  function collectUxSignals(ux, element, style) {
    const text = getElementText(element);
    const rect = element.getBoundingClientRect();
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = normalizeLineHeight(style.lineHeight, fontSize);
    const background = resolveBackgroundColor(element);
    const foreground = normalizeColor(style.color)?.hex;
    const contrastRatio = foreground && background ? getContrastRatio(foreground, background.hex) : null;

    if (text && fontSize) {
      ux.textSamples.push({ element, fontSize, lineHeight, contrastRatio });
      if (/^h[1-6]$/i.test(element.tagName)) {
        ux.headings.push(fontSize);
      } else {
        ux.bodyTextSizes.push(fontSize);
      }
    }

    if (rect.width > 240 && rect.height > 80) {
      ux.sectionBlocks.push({ top: rect.top, bottom: rect.bottom, height: rect.height });
    }

    if (isClickable(element)) {
      ux.interactive.push({
        element,
        label: buildInteractiveLabel(element),
        rect,
        background: normalizeColor(style.backgroundColor)?.hex,
        textColor: foreground,
        focusVisible: hasVisibleFocusStyle(style),
        isTopHalf: rect.top < window.innerHeight * 0.6
      });
    }
  }

  function finalizeUxAudit(ux) {
    const smallText = ux.textSamples.filter((item) => item.fontSize < 14);
    const tightText = ux.textSamples.filter((item) => item.lineHeight < 1.4);
    const lowContrastText = ux.textSamples.filter((item) => item.contrastRatio !== null && item.contrastRatio < 4.5);
    const smallTargets = ux.interactive.filter((item) => item.rect.width < 40 || item.rect.height < 40);
    const closeTargets = detectCloseTargets(ux.interactive);
    const weakFocus = ux.interactive.filter((item) => !item.focusVisible);
    const headingGap = computeHeadingGap(ux.headings, ux.bodyTextSizes);
    const busyTypeScale = new Set(ux.bodyTextSizes.map((value) => Math.round(value))).size >= 5;
    const cta = detectPrimaryCta(ux.interactive);
    const responsive = buildResponsiveAudit(ux, smallText, smallTargets);

    const readability = [
      buildAuditItem("Small text detected", smallText.length ? "critical" : "good", smallText.length ? "Text is too small to read comfortably." : "Body text generally stays readable."),
      buildAuditItem("Line spacing", tightText.length ? "warning" : "good", tightText.length ? "Some copy blocks feel tight and harder to scan." : "Line spacing looks comfortable."),
      buildAuditItem("Text contrast", lowContrastText.length ? "warning" : "good", lowContrastText.length ? "Some text is hard to read against its background." : "Important text contrast looks solid.")
    ];

    const interaction = [
      buildAuditItem("Touch targets", smallTargets.length ? "critical" : "good", smallTargets.length ? "Some buttons or links are too small for comfortable tapping." : "Touch targets look comfortable."),
      buildAuditItem("Tap spacing", closeTargets.length ? "warning" : "good", closeTargets.length ? "Clickable elements sit too close together in places." : "Clickable elements have enough breathing room.")
    ];

    const accessibility = [
      buildAuditItem("Focus visibility", weakFocus.length ? "critical" : "good", weakFocus.length ? "Keyboard focus is not clearly visible on some interactive elements." : "Interactive elements appear to keep a visible focus treatment."),
      buildAuditItem("Keyboard clarity", weakFocus.length > Math.max(2, Math.floor(ux.interactive.length * 0.5)) ? "warning" : "good", weakFocus.length > Math.max(2, Math.floor(ux.interactive.length * 0.5)) ? "Keyboard navigation cues feel unclear." : "Keyboard navigation cues look reasonably clear.")
    ];

    const hierarchy = [
      buildAuditItem("Heading distinction", headingGap < 6 || busyTypeScale ? "warning" : "good", headingGap < 6 || busyTypeScale ? "Heading styles do not stand apart strongly enough from body text." : "Heading hierarchy reads clearly."),
      buildAuditItem("Content grouping", ux.sectionBlocks.length >= 2 ? "good" : "warning", ux.sectionBlocks.length >= 2 ? "Sections appear to have consistent spacing." : "Section spacing feels uneven, which can hurt scannability.")
    ];

    const ctaAnalysis = buildCtaAudit(cta);
    const issues = buildUxSummary([readability, interaction, accessibility, hierarchy, ctaAnalysis]);
    const score = buildUxScore({ readability, interaction, accessibility, hierarchy, ctaAnalysis });
    const highlights = {
      critical: [...smallText, ...smallTargets, ...weakFocus].map((item) => ensureHighlightId(item.element)),
      warning: [...tightText, ...lowContrastText, ...closeTargets].map((item) => ensureHighlightId(item.element)),
      good: cta?.element ? [ensureHighlightId(cta.element)] : []
    };

    return {
      readability,
      interaction,
      accessibility,
      hierarchy,
      cta: ctaAnalysis,
      issues,
      score,
      responsive,
      highlights
    };
  }

  function buildUxSummary(groups) {
    const allItems = groups.flat().filter(Boolean);
    const good = allItems.filter((item) => item.tone === "good").slice(0, 2);
    const warnings = allItems.filter((item) => item.tone === "warning").slice(0, 3);
    const critical = allItems.filter((item) => item.tone === "critical").slice(0, 2);

    return {
      critical,
      warnings: warnings.length ? warnings : [buildAuditItem("Minor improvements possible", "warning", "The interface looks stable overall, but there is still room to polish spacing, hierarchy, or accessibility.")],
      good: good.length ? good : [buildAuditItem("No critical issues detected", "good", "The page avoids obvious UX breakdowns in the sampled view.")]
    };
  }

  function buildUxScore(groups) {
    let score = 100;
    [
      ...groups.readability,
      ...groups.interaction,
      ...groups.accessibility,
      ...groups.hierarchy,
      ...groups.ctaAnalysis
    ].forEach((item) => {
      if (item.tone === "critical") {
        score -= 12;
      } else if (item.tone === "warning") {
        score -= 7;
      }
    });

    score = Math.max(32, score);
    const needs = [];
    if (groups.readability.some((item) => item.tone !== "good")) {
      needs.push("readability");
    }
    if (groups.interaction.some((item) => item.tone !== "good")) {
      needs.push("touch targets");
    }
    if (groups.accessibility.some((item) => item.tone !== "good")) {
      needs.push("accessibility");
    }

    return {
      value: score,
      summary: needs.length ? `Needs improvement in ${needs.slice(0, 2).join(" and ")}.` : "Overall UX looks healthy."
    };
  }

  function buildResponsiveAudit(ux, smallText, smallTargets) {
    const averageText = ux.textSamples.length
      ? ux.textSamples.reduce((sum, item) => sum + item.fontSize, 0) / ux.textSamples.length
      : 16;
    const averageSectionHeight = ux.sectionBlocks.length
      ? ux.sectionBlocks.reduce((sum, item) => sum + item.height, 0) / ux.sectionBlocks.length
      : 0;

    const mobile = [
      smallTargets.length
        ? buildAuditItem("Buttons too small for touch", "critical", "Some buttons are too small for comfortable touch use.")
        : buildAuditItem("Touch targets hold up well", "good", "Buttons look large enough for touch interactions."),
      smallText.length || averageText < 14.5
        ? buildAuditItem("Text slightly small on mobile", smallText.length ? "critical" : "warning", "Some text may feel too small on a mobile screen.")
        : buildAuditItem("Text stays readable on mobile", "good", "Text sizing looks comfortable for smaller screens.")
    ];

    const desktop = [
      averageSectionHeight > window.innerHeight * 0.7
        ? buildAuditItem("Too much empty space", "warning", "Some sections feel overly stretched on desktop.")
        : buildAuditItem("Good layout balance", "good", "The page uses desktop space with a healthy amount of structure."),
      ux.interactive.length > 18
        ? buildAuditItem("Layout feels crowded", "critical", "Too many interactive elements compete for attention at once.")
        : buildAuditItem("Desktop density stays manageable", "good", "Interactive elements do not feel overly crowded.")
    ];

    return { mobile, desktop };
  }

  function buildCtaAudit(cta) {
    if (!cta) {
      return [buildAuditItem("Primary CTA", "warning", "A strong primary action was not clearly visible.")];
    }

    const ratio = cta.background && cta.textColor ? getContrastRatio(cta.textColor, cta.background) : 0;
    return [
      buildAuditItem("Primary CTA detected", "good", `Primary CTA detected: ${cta.label || "Primary action"}.`),
      buildAuditItem("CTA visibility", ratio >= 4.5 ? "good" : "warning", ratio >= 4.5 ? "CTA has strong visibility." : "CTA lacks visual prominence.")
    ];
  }

  function detectPrimaryCta(items) {
    return [...items]
      .map((item) => {
        const saturation = item.background ? getColorSaturation(item.background) : 0;
        const prominence = item.rect.width * item.rect.height * (1 + saturation) * (item.isTopHalf ? 1.15 : 1);
        return { ...item, prominence };
      })
      .sort((a, b) => b.prominence - a.prominence)[0] || null;
  }

  function detectCloseTargets(items) {
    const matches = [];
    for (let i = 0; i < items.length; i += 1) {
      const current = items[i];
      const tooClose = items.some((other, index) => {
        if (i === index) {
          return false;
        }
        const verticalGap = current.rect.top > other.rect.bottom
          ? current.rect.top - other.rect.bottom
          : other.rect.top > current.rect.bottom
            ? other.rect.top - current.rect.bottom
            : 0;
        const horizontalOverlap = Math.min(current.rect.right, other.rect.right) - Math.max(current.rect.left, other.rect.left);
        return verticalGap < 8 && horizontalOverlap > 0;
      });
      if (tooClose) {
        matches.push(current);
      }
    }
    return matches.slice(0, 6);
  }

  function buildComponentPayload(type, element, style) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 32 || rect.width <= 32) {
      return null;
    }

    const padding = simplifyPadding(style);
    return {
      type,
      label: buildInteractiveLabel(element),
      backgroundColor: normalizeColor(style.backgroundColor)?.hex ?? "#FFFFFF",
      textColor: normalizeColor(style.color)?.hex ?? "#111827",
      borderRadius: simplifySpacing(style.borderRadius),
      padding,
      borderColor: normalizeColor(style.borderColor)?.hex ?? "transparent",
      shadow: simplifyShadow(style.boxShadow),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      count: 1
    };
  }

  function buildCardPayload(element, style) {
    return {
      type: "cards",
      label: buildCardLabel(element),
      backgroundColor: normalizeColor(style.backgroundColor)?.hex ?? "#FFFFFF",
      borderRadius: simplifySpacing(style.borderRadius),
      borderColor: normalizeColor(style.borderColor)?.hex ?? "transparent",
      padding: simplifyPadding(style),
      shadow: simplifyShadow(style.boxShadow),
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
      count: 1
    };
  }

  function storeComponentPayload(bucket, payload) {
    const key = [
      payload.backgroundColor,
      payload.textColor || "",
      payload.borderRadius,
      payload.padding || "",
      payload.borderColor,
      payload.shadow || ""
    ].join("|");

    const existing = bucket.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    bucket.set(key, payload);
  }

  function summarizeColors(colorMap) {
    return Array.from(colorMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_COLOR_RESULTS)
      .map((entry, index) => ({
        hex: entry.hex,
        count: entry.count,
        usage: assignColorUsage(entry.categories, index, entry.hex)
      }));
  }

  function summarizeTypography(typographyMap) {
    const grouped = { heading: [], body: [] };
    Array.from(typographyMap.values())
      .sort((a, b) => b.count - a.count)
      .forEach((entry) => {
        const target = entry.role === "Heading" ? grouped.heading : grouped.body;
        if (target.length < MAX_TYPOGRAPHY_RESULTS) {
          target.push(entry);
        }
      });
    return grouped;
  }

  function summarizeSpacing(samples) {
    const groups = new Map();
    samples.forEach((value) => {
      const normalized = Math.max(4, Math.round(value / 4) * 4);
      groups.set(normalized, (groups.get(normalized) || 0) + 1);
    });

    return Array.from(groups.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .sort((a, b) => a[0] - b[0])
      .map(([value, count]) => ({
        value: `${value}px`,
        count
      }));
  }

  function summarizeComponents(buckets) {
    return {
      buttons: summarizeBucket(buckets.buttons),
      inputs: summarizeBucket(buckets.inputs),
      images: summarizeBucket(buckets.images),
      cards: summarizeBucket(buckets.cards)
    };
  }

  function summarizeBucket(bucket) {
    return Array.from(bucket.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_COMPONENT_RESULTS);
  }

  function resolveComponentType(element, tag) {
    if (tag === "button" || element.getAttribute("role") === "button") {
      return "buttons";
    }
    if (tag === "a") {
      return "buttons";
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return "inputs";
    }
    if (tag === "img") {
      return "images";
    }
    return null;
  }

  function looksLikeCard(element, tag, style) {
    if (!["div", "section", "article", "aside", "li"].includes(tag)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 48) {
      return false;
    }

    const background = normalizeColor(style.backgroundColor);
    const hasSurface = background && background.hex !== "#FFFFFF";
    const hasBorder = style.borderStyle !== "none" && parseFloat(style.borderWidth) > 0;
    const hasShadow = style.boxShadow && style.boxShadow !== "none";
    const hasRadius = parseFloat(style.borderRadius) >= 8;
    const hasText = getElementText(element).length > 0;

    return hasText && (hasSurface || hasBorder || hasShadow) && hasRadius;
  }

  function buildInteractiveLabel(element) {
    return (element.innerText || element.textContent || element.getAttribute("aria-label") || "Action")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 28) || "Action";
  }

  function buildCardLabel(element) {
    return ((element.getAttribute("aria-label") || element.textContent || "Card").trim().replace(/\s+/g, " ").slice(0, 24)) || "Card";
  }

  function normalizeColor(value) {
    if (!value || value === "transparent" || value === "inherit") {
      return null;
    }

    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(",").map((part) => part.trim());
    const [r, g, b, a] = parts.map(Number);
    if ([r, g, b].some((channel) => Number.isNaN(channel))) {
      return null;
    }
    if (typeof a === "number" && !Number.isNaN(a) && a < 0.08) {
      return null;
    }

    return {
      hex: `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`
    };
  }

  function normalizeFontFamily(fontFamily) {
    return fontFamily ? fontFamily.split(",")[0]?.trim().replace(/["']/g, "") || "" : "";
  }

  function normalizeFontWeight(weight) {
    if (!weight) {
      return "400";
    }
    if (weight === "normal") {
      return "400";
    }
    if (weight === "bold") {
      return "700";
    }
    return weight;
  }

  function inferTextRole(element, fontSize, fontWeight) {
    const numericWeight = parseInt(fontWeight, 10) || 400;
    return /^h[1-6]$/.test(element.tagName.toLowerCase()) || fontSize >= 20 || numericWeight >= 600 ? "Heading" : "Body";
  }

  function assignColorUsage(categories, index, hex) {
    const values = Array.from(categories);
    if (values.includes("Text") && !values.includes("Background")) {
      return index === 0 ? "Primary text" : "Text";
    }
    if (values.includes("Background") && !values.includes("Text")) {
      return index === 0 ? "Primary background" : "Background";
    }
    if (hex === "#FFFFFF") {
      return "Canvas";
    }
    return index < 2 ? "Accent" : "Support";
  }

  function getElementText(element) {
    return (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
  }

  function isClickable(element) {
    const tag = element.tagName.toLowerCase();
    return tag === "button" || tag === "a" || element.getAttribute("role") === "button";
  }

  function normalizeLineHeight(lineHeight, fontSize) {
    if (!fontSize) {
      return 1.4;
    }
    if (!lineHeight || lineHeight === "normal") {
      return 1.2;
    }
    return parseFloat(lineHeight) / fontSize;
  }

  function resolveBackgroundColor(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      const background = normalizeColor(getComputedStyle(current).backgroundColor);
      if (background) {
        return background;
      }
      current = current.parentElement;
    }
    return { hex: "#FFFFFF" };
  }

  function hasVisibleFocusStyle(style) {
    const outlineWidth = parseFloat(style.outlineWidth || "0");
    return outlineWidth > 0 || style.outlineStyle !== "none" || style.boxShadow !== "none";
  }

  function computeHeadingGap(headings, bodySizes) {
    const maxHeading = headings.length ? Math.max(...headings) : 0;
    const avgBody = bodySizes.length ? bodySizes.reduce((sum, value) => sum + value, 0) / bodySizes.length : 16;
    return maxHeading - avgBody;
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

  function getColorSaturation(hex) {
    const { r, g, b } = hexToRgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }

  function hexToRgb(hex) {
    const safe = hex.replace("#", "");
    return {
      r: parseInt(safe.slice(0, 2), 16),
      g: parseInt(safe.slice(2, 4), 16),
      b: parseInt(safe.slice(4, 6), 16)
    };
  }

  function simplifySpacing(value) {
    return value.replace(/\s+/g, " ").replace(/0px/g, "0").trim();
  }

  function simplifyPadding(style) {
    const values = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .map((value) => Math.round(parseFloat(value) || 0));
    if (!values.some((value) => value > 0)) {
      return null;
    }
    return values.map((value) => `${value}px`).join(" ");
  }

  function simplifyShadow(value) {
    return !value || value === "none" ? "none" : "shadow";
  }

  function incrementCount(map, key) {
    if (!key) {
      return;
    }
    map.set(key, (map.get(key) || 0) + 1);
  }

  function summarizeSimpleCounts(map, keyName) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({
        [keyName]: value,
        count
      }));
  }

  function buildAuditItem(title, tone, detail) {
    return { title, tone, detail };
  }

  function ensureHighlightId(element) {
    if (!element.dataset.uiAnalyzerId) {
      element.dataset.uiAnalyzerId = `uia-${Math.random().toString(36).slice(2, 9)}`;
    }
    return element.dataset.uiAnalyzerId;
  }

  function markHighlightTargets(groups) {
    clearHighlightMarkers();
    Object.entries(groups).forEach(([tone, ids]) => {
      ids.filter(Boolean).forEach((id) => {
        const element = document.querySelector(`[data-ui-analyzer-id="${id}"]`);
        if (element) {
          element.setAttribute(HIGHLIGHT_ATTR, tone);
        }
      });
    });
  }

  function clearHighlightMarkers() {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((element) => {
      element.removeAttribute(HIGHLIGHT_ATTR);
      element.style.outline = "";
      element.style.outlineOffset = "";
      element.style.boxShadow = "";
    });
  }

  function applyHighlightState(enabled) {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((element) => {
      if (!enabled) {
        element.style.outline = "";
        element.style.outlineOffset = "";
        element.style.boxShadow = "";
        return;
      }

      const tone = element.getAttribute(HIGHLIGHT_ATTR);
      const color = tone === "critical" ? "#DC2626" : tone === "warning" ? "#D97706" : "#16A34A";
      element.style.outline = `2px solid ${color}`;
      element.style.outlineOffset = "2px";
      element.style.boxShadow = `0 0 0 4px ${color}22`;
    });
  }
})();
