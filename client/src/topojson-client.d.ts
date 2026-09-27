/** Minimal topojson-client types for the world-atlas GeoJSON conversion. */
declare module 'topojson-client' {
  export function feature(
    topology: unknown,
    object: unknown,
  ): { features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] };
}

declare module 'world-atlas/countries-110m.json' {
  const data: unknown;
  export default data;
}
