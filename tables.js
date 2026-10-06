/*
 * tables.js
 *
 * Table 1 row filter: the shading key above the table doubles as a filter.
 * Click a key to show only that group's rows; click it again to show all.
 * Shift+click adds or removes a group, so several can be shown at once.
 * Section headings with no visible rows are hidden along with them.
 */
"use strict";

(function () {
  const legend = document.querySelector(".stage-legend");
  const table = document.querySelector("table.t1");
  if (!legend || !table || !table.tBodies.length) return;

  const STAGES = ["stage-s2", "stage-s1", "stage-rem"];
  const keys = Array.from(legend.querySelectorAll("button[data-stage]"));
  const active = new Set();

  function apply() {
    keys.forEach((b) => b.setAttribute("aria-pressed", String(active.has(b.dataset.stage))));
    legend.classList.toggle("is-filtered", active.size > 0);

    let section = null;
    let sectionHasRows = false;
    const closeSection = () => { if (section) section.hidden = !sectionHasRows; };
    Array.from(table.tBodies[0].rows).forEach((tr) => {
      if (tr.classList.contains("section")) {
        closeSection();
        section = tr;
        sectionHasRows = false;
        return;
      }
      const stage = STAGES.find((c) => tr.classList.contains(c));
      const show = active.size === 0 || active.has(stage);
      tr.hidden = !show;
      if (show && !tr.classList.contains("subhdr")) sectionHasRows = true;
    });
    closeSection();
  }

  keys.forEach((b) => {
    b.addEventListener("click", (e) => {
      const k = b.dataset.stage;
      if (e.shiftKey) {
        if (active.has(k)) active.delete(k); else active.add(k);
      } else if (active.has(k) && active.size === 1) {
        active.clear();
      } else {
        active.clear();
        active.add(k);
      }
      apply();
    });
  });
})();
