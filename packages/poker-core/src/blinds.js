// Blindstrukturer. Lagres som JSON og kan gjenbrukes av en hjemmespill-klokke.

export const STRUCTURES = Object.freeze({
  // Sit-and-go: 1 500 i start, nytt nivå hvert 5. minutt.
  sng: {
    name: 'Sit-and-go (turbo)',
    startingStack: 1500,
    levelMinutes: 5,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 25, bb: 50, ante: 0 },
      { sb: 50, bb: 100, ante: 0 },
      { sb: 75, bb: 150, ante: 0 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 25 },
      { sb: 200, bb: 400, ante: 50 },
      { sb: 300, bb: 600, ante: 75 },
      { sb: 400, bb: 800, ante: 100 },
      { sb: 600, bb: 1200, ante: 150 },
      { sb: 800, bb: 1600, ante: 200 },
      { sb: 1000, bb: 2000, ante: 250 },
    ],
  },
  // Planlagt turnering / klubbkveld: nytt nivå hvert 10. minutt.
  turnering: {
    name: 'Turnering (standard)',
    startingStack: 1500,
    levelMinutes: 10,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 20, bb: 40, ante: 0 },
      { sb: 25, bb: 50, ante: 0 },
      { sb: 50, bb: 100, ante: 10 },
      { sb: 75, bb: 150, ante: 15 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 25 },
      { sb: 200, bb: 400, ante: 50 },
      { sb: 300, bb: 600, ante: 75 },
      { sb: 400, bb: 800, ante: 100 },
      { sb: 600, bb: 1200, ante: 150 },
      { sb: 1000, bb: 2000, ante: 250 },
    ],
  },
});

/** Nivåindeks ut fra medgått tid. Siste nivå gjelder resten av spillet. */
export function levelIndexAt(structure, elapsedMs) {
  const idx = Math.floor(elapsedMs / (structure.levelMinutes * 60_000));
  return Math.min(Math.max(idx, 0), structure.levels.length - 1);
}

/** Nivåindeks ut fra antall spilte hender (brukes i tester og treningsbord). */
export function levelIndexByHands(structure, handsPlayed, handsPerLevel) {
  const idx = Math.floor(handsPlayed / handsPerLevel);
  return Math.min(idx, structure.levels.length - 1);
}
