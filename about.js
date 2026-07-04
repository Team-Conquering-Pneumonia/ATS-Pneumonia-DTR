/*
 * about.js
 *
 * Renders the About page's "Visualizations" section from the shared VIZ_INFO
 * object (viz-info.js), so the descriptions here and the Info popovers beside
 * each visual are one source. Links each visualization to its page.
 *
 * Also loads the editable prose (caveat + overview) from about-content.html,
 * so Barb can edit that text on GitHub without touching this file.
 *
 * Plain script (no module syntax), matching app.js's convention.
 */
"use strict";

// Appends a small robot-icon marker to `el` flagging it as AI-drafted prose.
// Hovering the icon shows `source` (the file to edit) and the review status.
function appendProseFlag(el, status, source) {
  var flag = document.createElement("span");
  flag.className = "prose-flag";
  flag.setAttribute("data-status", status);
  flag.setAttribute("aria-hidden", "true");
  flag.textContent = "\u{1F916}"; // robot emoji
  flag.title =
    (status === "approved" ? "Approved" : "Pending human review") +
    " — AI-drafted text, edit in " + source;
  el.appendChild(flag);
}

// Scans a freshly-injected fragment for paragraphs carrying
// data-status/data-source (see about-content.html) and flags each one.
function flagInjectedProse(root) {
  var nodes = root.querySelectorAll("[data-status]");
  nodes.forEach(function (node) {
    appendProseFlag(
      node,
      node.getAttribute("data-status"),
      node.getAttribute("data-source") || "unknown file"
    );
  });
}

function loadAboutContent() {
  var container = document.getElementById("about-content");
  if (!container) return;

  fetch("about-content.html")
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    })
    .then(function (html) {
      container.innerHTML = html;
      flagInjectedProse(container);
    })
    .catch(function () {
      container.innerHTML = "<p>Unable to load page content.</p>";
    });
}

// Order + destination link for each visualization block.
var VIZ_ORDER = [
  { key: "tree", href: "trees.html", linkText: "Open the interactive tree" },
  { key: "contour", href: "trees.html", linkText: "Open the interactive tree" },
  { key: "table1", href: "tables.html", linkText: "Open the summary tables" },
  { key: "table2", href: "tables.html", linkText: "Open the summary tables" },
  { key: "report", href: "results_by_node.html", linkText: "Open the per-node results" },
];

function renderVizDescriptions() {
  var container = document.getElementById("viz-descriptions");
  var info = window.VIZ_INFO || {};
  if (!container) return;

  VIZ_ORDER.forEach(function (item) {
    var entry = info[item.key];
    if (!entry) return;

    var block = document.createElement("section");
    block.className = "viz-desc";

    var h3 = document.createElement("h3");
    h3.textContent = entry.title;
    block.appendChild(h3);

    (entry.detail || [{ text: entry.summary }]).forEach(function (para) {
      var p = document.createElement("p");
      p.innerHTML = para.text; // detail text carries inline <em> markup
      if (para.status) appendProseFlag(p, para.status, "site/viz-info.js");
      block.appendChild(p);
    });

    var link = document.createElement("a");
    link.className = "viz-desc-link";
    link.href = item.href;
    link.textContent = item.linkText + " →";
    block.appendChild(link);

    container.appendChild(block);
  });
}

function initAboutPage() {
  loadAboutContent();
  renderVizDescriptions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAboutPage);
} else {
  initAboutPage();
}
