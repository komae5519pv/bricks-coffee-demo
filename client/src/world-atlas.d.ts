/** Minimal world-atlas types (TopoJSON topology for countries-50m and the
 * extracted store-country 10m asset). */
interface WorldAtlasTopology {
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

declare module 'world-atlas/countries-50m.json' {
  const data: WorldAtlasTopology;
  export default data;
}

declare module '*/assets/countries-10m-stores.json' {
  const data: WorldAtlasTopology;
  export default data;
}
