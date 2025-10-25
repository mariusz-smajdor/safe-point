import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

const DEFAULT_QUERY_URL =
  "https://services-eu1.arcgis.com/HE4WRthd9CIPj0R8/arcgis/rest/services/schrony_csv/FeatureServer/0/query?f=json&geometry=2333469.599486269%2C6843865.76454274%2C2335915.584391393%2C6846311.749447865&maxRecordCountFactor=4&resultOffset=0&resultRecordCount=4000&where=1%3D1&orderByFields=ObjectId2%20ASC&outFields=*&quantizationParameters=%7B%22extent%22%3A%7B%22xmin%22%3A2333469.599486269%2C%22ymin%22%3A6843865.76454274%2C%22xmax%22%3A2335915.584391393%2C%22ymax%22%3A6846311.749447865%7D%2C%22mode%22%3A%22view%22%2C%22originPosition%22%3A%22upperLeft%22%2C%22tolerance%22%3A4.77731426782227%7D&resultType=tile&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope&defaultSR=102100";

type ArcgisFeature = any;
type Coords = { x: number; y: number };

export default function useArcgis(url: string = DEFAULT_QUERY_URL) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["arcgis-data", url],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const features: ArcgisFeature[] = Array.isArray(data?.features) ? data.features : [];

  const tryGetCoords = (f: any): Coords | null => {
    if (!f) return null;

    // geometry.x / geometry.y
    if (f.geometry && typeof f.geometry.x === "number" && typeof f.geometry.y === "number") {
      return { x: f.geometry.x, y: f.geometry.y };
    }

    // top-level x/y
    if (typeof f.x === "number" && typeof f.y === "number") {
      return { x: f.x, y: f.y };
    }

    // attributes with coordinate-like field names
    const attrs = f.attributes || {};
    const findKey = (keys: string[]) => {
      for (const k of keys) {
        for (const prop of Object.keys(attrs)) {
          if (prop.toLowerCase() === k) return prop;
        }
      }
      return null;
    };

    const xKey = findKey(["x", "lon", "long", "longitude", "point_x", "pointx"]);
    const yKey = findKey(["y", "lat", "latitude", "point_y", "pointy"]);
    if (xKey && yKey) {
      const x = Number(attrs[xKey]);
      const y = Number(attrs[yKey]);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return { x, y };
    }

    // GeoJSON-like geometry
    if (f.geometry && Array.isArray((f.geometry as any).coordinates)) {
      const coords = (f.geometry as any).coordinates;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        return { x: coords[0], y: coords[1] };
      }
    }

    // nested points / rings / paths
    if (f.geometry) {
      const g: any = f.geometry;
      if (Array.isArray(g.points) && Array.isArray(g.points[0]) && typeof g.points[0][0] === "number") {
        return { x: g.points[0][0], y: g.points[0][1] };
      }
      if (Array.isArray(g.rings) && Array.isArray(g.rings[0]) && Array.isArray(g.rings[0][0]) && typeof g.rings[0][0][0] === "number") {
        return { x: g.rings[0][0][0], y: g.rings[0][0][1] };
      }
    }

    return null;
  };

  const withCoords = features
    .map((f) => ({ feature: f, coords: tryGetCoords(f) }))
    .filter((x) => x.coords !== null)
    .map((x) => ({ ...x.feature, _coords: x.coords }));

  useEffect(() => {
    if (isLoading) return;
    if (error) {
      // eslint-disable-next-line no-console
      console.error("ArcGIS fetch error:", error);
      return;
    }

    // logging removed per request
  }, [withCoords, error, isLoading]);

  return { data, withCoords, isLoading, error } as const;
}
