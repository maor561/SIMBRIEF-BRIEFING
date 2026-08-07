/**
 * Card-wall layout, measured rather than guessed.
 *
 * A CSS row-grid sets each row's height to its tallest card, leaving dead
 * space under every shorter neighbour. CSS multi-column "solves" that by
 * letting the browser choose its own column breaks -- which is exactly what
 * produced a phantom empty-card-sized gap (a known multicol + break-inside
 * interaction). This measures each card's real rendered height and bin-packs
 * it into balanced columns instead, so no card is ever split and no gap is
 * bigger than the height difference the cards themselves force.
 *
 * `.grid` children arrive as a flat, ordered list. `.col-12` items are
 * full-width section breaks; everything between two breaks is one "run"
 * that gets laid out as one or more balanced two-column blocks (or left
 * single-column on a screen too narrow for two).
 */

const TWO_COL_MIN_WIDTH = 640;

export function layoutMasonry(scope) {
  scope.querySelectorAll('.grid').forEach(applyMasonry);
}

function applyMasonry(grid) {
  const items = Array.from(grid.children);
  if (!items.length) return;

  const twoCol = grid.clientWidth >= TWO_COL_MIN_WIDTH;
  grid.textContent = '';

  let run = [];
  const commitRun = () => {
    if (!run.length) return;
    if (!twoCol || run.length < 2) {
      run.forEach((el) => grid.appendChild(el));
      run = [];
      return;
    }
    packRun(run, grid);
    run = [];
  };

  for (const el of items) {
    if (el.classList.contains('col-12')) {
      commitRun();
      grid.appendChild(el);
    } else {
      run.push(el);
    }
  }
  commitRun();
}

/** A throwaway two-column row, used only to get real column-width measurements. */
function measureAtColumnWidth(grid, elements) {
  const probeRow = document.createElement('div');
  probeRow.className = 'grid-row';
  const probe = document.createElement('div');
  const spacer = document.createElement('div');
  probe.className = 'grid-col';
  spacer.className = 'grid-col';
  probeRow.append(probe, spacer);
  grid.appendChild(probeRow);

  const measured = elements.map((el) => {
    probe.appendChild(el);
    return { el, height: el.getBoundingClientRect().height };
  });

  probeRow.remove(); // scaffolding only; el nodes live on in `measured`
  return measured;
}

function packRun(run, grid) {
  const measured = measureAtColumnWidth(grid, run);

  // Pull out any card taller than the rest of the run combined. Pairing a
  // dominant card -- a long NOTAM list, say -- with much smaller neighbours
  // just strands the other column far behind it with nothing to fill the
  // difference. It gets the full row width on its own instead; whatever's
  // left packs into two columns among itself. Re-checked after each pull,
  // since removing the biggest card can make a new one dominant.
  const remaining = [...measured];
  const fullWidth = new Set();
  let again = true;
  while (again && remaining.length >= 2) {
    again = false;
    const total = remaining.reduce((sum, m) => sum + m.height, 0);
    let dominant = null;
    for (const m of remaining) {
      if (m.height > total - m.height && (!dominant || m.height > dominant.height)) dominant = m;
    }
    if (dominant) {
      fullWidth.add(dominant);
      remaining.splice(remaining.indexOf(dominant), 1);
      again = true;
    }
  }
  if (remaining.length === 1) fullWidth.add(remaining[0]);

  // LPT bin-packing (largest-first) for whatever's left: assigning the
  // biggest remaining item first is what keeps a merely-large card from
  // repeating the same problem on a smaller scale. Greedy in source order
  // doesn't have that property.
  const target = new Map();
  if (remaining.length >= 2) {
    let heightA = 0;
    let heightB = 0;
    for (const m of [...remaining].sort((a, b) => b.height - a.height)) {
      if (heightA <= heightB) {
        target.set(m.el, 'A');
        heightA += m.height;
      } else {
        target.set(m.el, 'B');
        heightB += m.height;
      }
    }
  }

  // Rebuild in original reading order. A full-width card closes whatever
  // two-column block was open and starts a fresh one after it, so a
  // dominant card in the middle of a run still splits cleanly.
  let colA = null;
  let colB = null;
  const openRow = () => {
    const row = document.createElement('div');
    row.className = 'grid-row';
    colA = document.createElement('div');
    colB = document.createElement('div');
    colA.className = 'grid-col';
    colB.className = 'grid-col';
    row.append(colA, colB);
    grid.appendChild(row);
  };

  for (const m of measured) {
    if (fullWidth.has(m)) {
      colA = null;
      colB = null;
      grid.appendChild(m.el);
    } else {
      if (!colA) openRow();
      (target.get(m.el) === 'A' ? colA : colB).appendChild(m.el);
    }
  }
}
