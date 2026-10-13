// Built-in models. Coordinates: x right, y up, z = nose direction. Faces list
// vertex indices (3 or 4); style "dark" = solid black glass, otherwise shaded.
const q = (v, style) => ({ v, style: style || 'shaded' });

export const LIBRARY = {
  spinner: {
    name: 'Spinner',
    mesh: {
      verts: [[0, 0.2, 2.3], [-0.8, 0.5, 1.2], [0.8, 0.5, 1.2], [-0.8, -0.2, 1], [0.8, -0.2, 1], [-0.85, 0.7, -1.9], [0.85, 0.7, -1.9],
        [-0.85, -0.2, -1.9], [0.85, -0.2, -1.9], [-0.55, 1.15, 0.1], [0.55, 1.15, 0.1], [-0.5, 1.1, -1], [0.5, 1.1, -1]],
      faces: [q([0, 1, 2]), q([0, 4, 3]), q([0, 3, 1]), q([0, 2, 4]), q([1, 3, 7, 5]), q([2, 6, 8, 4]), q([5, 7, 8, 6]), q([3, 4, 8, 7]),
        q([1, 2, 10, 9], 'dark'), q([9, 10, 12, 11]), q([1, 9, 11, 5], 'dark'), q([2, 6, 12, 10], 'dark'), q([11, 12, 6, 5])],
    },
    lights: [{ p: [-0.35, 1.3, -0.45], mode: 'alt', rate: 6, phase: 0 }, { p: [0.35, 1.3, -0.45], mode: 'alt', rate: 6, phase: 1 }],
    headlights: true, thrusters: true, autoOrient: true, bob: 0.25, scale: 1.5,
  },
  blimp: {
    name: 'Advertising blimp',
    mesh: (() => {
      // an 8-sided hull with pointed ends, plus a gondola
      const verts = [[0, 0, 4], [0, 0, -4]], faces = [];
      const ring = (z, r) => { const s = verts.length; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; verts.push([Math.cos(a) * r, Math.sin(a) * r * 0.8, z]); } return s; };
      const r1 = ring(2.5, 1.1), r2 = ring(-2.5, 1.1);
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        faces.push(q([0, r1 + j, r1 + i]), q([r1 + i, r1 + j, r2 + j, r2 + i]), q([1, r2 + i, r2 + j]));
      }
      const g = verts.length;
      verts.push([-0.3, -0.9, 0.8], [0.3, -0.9, 0.8], [0.3, -0.9, -0.8], [-0.3, -0.9, -0.8], [-0.3, -1.4, 0.6], [0.3, -1.4, 0.6], [0.3, -1.4, -0.6], [-0.3, -1.4, -0.6]);
      faces.push(q([g, g + 1, g + 5, g + 4], 'dark'), q([g + 1, g + 2, g + 6, g + 5], 'dark'), q([g + 2, g + 3, g + 7, g + 6], 'dark'), q([g + 3, g, g + 4, g + 7], 'dark'), q([g + 4, g + 5, g + 6, g + 7]));
      return { verts, faces };
    })(),
    lights: [{ p: [0, -1.5, 0], mode: 'strobe', rate: 1, phase: 0 }, { p: [0, 0.95, 3.6], mode: 'blink', rate: 2, phase: 0 }],
    headlights: false, thrusters: false, autoOrient: true, bob: 0.15, scale: 3,
  },
  pyramid: {
    name: 'Stepped pyramid',
    mesh: (() => {
      const verts = [], faces = [];
      const tier = (y0, y1, r0, r1) => {
        const s = verts.length;
        for (const [y, r] of [[y0, r0], [y1, r1]]) verts.push([-r, y, -r], [r, y, -r], [r, y, r], [-r, y, r]);
        for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; faces.push(q([s + i, s + j, s + 4 + j, s + 4 + i])); }
        faces.push(q([s + 4, s + 5, s + 6, s + 7]));
      };
      tier(0, 1, 4, 3.4); tier(1, 2, 3, 2.4); tier(2, 3, 2, 1.4); tier(3, 3.6, 1, 0.6);
      return { verts, faces };
    })(),
    lights: [{ p: [0, 3.7, 0], mode: 'blink', rate: 0.8, phase: 0 }],
    headlights: false, thrusters: false, autoOrient: false, bob: 0, scale: 8,
  },
  cube: {
    name: 'Cube',
    mesh: { verts: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      faces: [q([0, 1, 2, 3]), q([5, 4, 7, 6]), q([4, 0, 3, 7]), q([1, 5, 6, 2]), q([3, 2, 6, 7]), q([4, 5, 1, 0])] },
    lights: [], headlights: false, thrusters: false, autoOrient: false, bob: 0, scale: 1,
  },
};
