/** Minimal world-atlas types (TopoJSON topology for countries-110m). */
declare module 'world-atlas/countries-110m.json' {
  interface Topology {
    arcs: [number, number][][];
    transform: { scale: [number, number]; translate: [number, number] };
    objects: {
      countries: {
        geometries: ({
          type: 'Polygon' | 'MultiPolygon';
          arcs: number[][] | number[][][];
          properties: { name: string };
        })[];
      };
    };
  }
  const data: Topology;
  export default data;
}
