import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoadScript, GoogleMap, Marker } from "@react-google-maps/api";
import { useQuery } from "@tanstack/react-query";

export default function MapPage() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: apiKey });

  const mapRef = useRef<google.maps.Map | null>(null);
  const [center, setCenter] = useState<{ lat: number; lng: number }>(() => {
    try {
      const raw = localStorage.getItem("shelter:lastCenter");
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* ignore */
    }
    return { lat: 50.06465, lng: 19.94498 };
  });
  const [zoom, setZoom] = useState<number>(13);
  const [envelope, setEnvelope] = useState<{ xmin: number; ymin: number; xmax: number; ymax: number } | null>(null);

  // Mercator conversions
  const R = 6378137.0;
  const latLngToMercator = useCallback((lat: number, lng: number) => {
    const x = (lng * Math.PI / 180) * R;
    const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R;
    return { x, y };
  }, []);
  const mercatorToLatLng = useCallback((x: number, y: number) => {
    const lon = (x / R) * (180 / Math.PI);
    const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
    return { lat, lng: lon };
  }, []);

  // Save last center
  useEffect(() => {
    try {
      localStorage.setItem("shelter:lastCenter", JSON.stringify(center));
    } catch (e) {
      /* ignore */
    }
  }, [center]);

  // try to get user's location to improve default center
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCenter(c);
        if (mapRef.current) {
          mapRef.current.panTo(c);
          mapRef.current.setZoom(15);
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 600000 }
    );
  }, []);

  const onLoad = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    const b = map.getBounds();
    if (b) {
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const s = latLngToMercator(sw.lat(), sw.lng());
      const n = latLngToMercator(ne.lat(), ne.lng());
      setEnvelope({ xmin: s.x, ymin: s.y, xmax: n.x, ymax: n.y });
      setZoom(map.getZoom() ?? 13);
    }
  }, [latLngToMercator]);

  const onIdle = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const s = latLngToMercator(sw.lat(), sw.lng());
    const n = latLngToMercator(ne.lat(), ne.lng());
    setEnvelope({ xmin: s.x, ymin: s.y, xmax: n.x, ymax: n.y });
    setZoom(map.getZoom() ?? zoom);
    const c = map.getCenter();
    if (c) setCenter({ lat: c.lat(), lng: c.lng() });
  }, [latLngToMercator, zoom]);

  // Helper: find capacity field in attributes
  function extractCapacity(attrs: Record<string, any>) {
    if (!attrs) return 0;
    const keys = Object.keys(attrs);
    const capacityKey = keys.find((k) => /pojem|capacity|pojemnosc|poj/i.test(k));
    if (capacityKey) {
      const n = Number(attrs[capacityKey]);
      return Number.isFinite(n) ? n : 0;
    }
    // fallback numeric fields
    for (const k of keys) {
      const v = attrs[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
    }
    return 0;
  }

  // Query ArcGIS for features in envelope; server-side ordering by Pojemnoś_ desc and resultRecordCount=10
  const arcgisQuery = useQuery({
    queryKey: ["arcgis-bunkers", envelope, zoom],
    queryFn: async () => {
      if (!envelope) return null;
      const geometry = `${envelope.xmin},${envelope.ymin},${envelope.xmax},${envelope.ymax}`;
      const base =
        "https://services-eu1.arcgis.com/HE4WRthd9CIPj0R8/arcgis/rest/services/schrony_csv/FeatureServer/0/query";
      const params = new URLSearchParams({
        f: "json",
        geometry,
        geometryType: "esriGeometryEnvelope",
        inSR: "3857",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*,x,y",
        outSR: "3857",
        resultRecordCount: "10",
        where: "1=1",
        orderByFields: "Pojemnoś_ DESC",
        returnGeometry: "true",
      });
      const url = `${base}?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ArcGIS fetch failed: ${res.status}`);
      return res.json();
    },
  enabled: !!envelope,
  staleTime: 1000 * 60 * 5,
  });

  const CACHE_KEY_MARKERS = "shelter:cachedMarkers";

  const markers = useMemo(() => {
    const data = arcgisQuery.data as any;
    if (!data || !data.features) {
      // return cached markers when offline or no recent data
      try {
        const raw = localStorage.getItem(CACHE_KEY_MARKERS);
        if (raw) return JSON.parse(raw);
      } catch (e) {
        return [];
      }
      return [];
    }
    const feats = data.features
      .map((f: any) => {
        const attrs = f.attributes || {};
        let coords: { x: number; y: number } | null = null;
        if (f.geometry && typeof f.geometry.x === "number") coords = { x: f.geometry.x, y: f.geometry.y };
        // fallback to attribute fields
        if (!coords) {
          const xk = Object.keys(attrs).find((k) => /(^x$|lon|long|longitude|point_x)/i.test(k));
          const yk = Object.keys(attrs).find((k) => /(^y$|lat|latitude|point_y)/i.test(k));
          if (xk && yk) {
            const x = Number(attrs[xk]);
            const y = Number(attrs[yk]);
            if (!Number.isNaN(x) && !Number.isNaN(y)) coords = { x, y };
          }
        }
        const cap = extractCapacity(attrs);
        return { attrs, coords, capacity: cap };
      })
      .filter((f: any) => f.coords !== null);

    // map to lat/lng
    const mapped = feats.map((f: any) => ({
      id: f.attrs.ObjectId ?? f.attrs.OBJECTID ?? f.attrs.ObjectId2 ?? Math.random(),
      position: mercatorToLatLng(f.coords.x, f.coords.y),
      capacity: f.capacity,
      raw: f.attrs,
    }));

    // Quality scoring heuristic: combine explicit type, capacity, and hints (basement/underground)
    function scoreFeature(item: any) {
      const attrs = item.raw || {};
      const capacity = Number(item.capacity) || 0;
      // typeScore: prefer explicit 'schron' (code 1) > 'ukrycie' (code 2) > 'mds' (code 3) > others
      const kind = (attrs.Rodzaj_obi || "").toString();
      const kindLower = kind.toLowerCase();
      let typeScore = 0.5;
      const codeMatch = kind.match(/\[\s*(\d+)\s*\]/);
      if (codeMatch) {
        const code = codeMatch[1];
        if (code === "1") typeScore = 1.0;
        else if (code === "2") typeScore = 0.85;
        else if (code === "3") typeScore = 0.7;
      } else if (/schron|\(s\)/i.test(kindLower)) typeScore = 1.0;
      else if (/ukry|\(u\)/i.test(kindLower)) typeScore = 0.85;
      else if (/mds/i.test(kindLower)) typeScore = 0.7;

      const basementKeywords = /\b(piwn|podziem|podziemny|podziemie|parking|gara[żz])\b/i;
      const basementBonus = basementKeywords.test((attrs.Adres || "") + " " + (attrs.Rodzaj_inw || "")) ? 0.08 : 0;

      const capScore = Math.min(capacity / 200, 1);
      const score = 0.6 * typeScore + 0.35 * capScore + basementBonus;
      return score;
    }

    const scored = mapped.map((it: any) => ({ ...it, qualityScore: scoreFeature(it) }));
    const byQuality = scored.sort((a: any, b: any) => (b.qualityScore || 0) - (a.qualityScore || 0)).slice(0, 10);

    try {
      localStorage.setItem(CACHE_KEY_MARKERS, JSON.stringify(byQuality));
    } catch (e) {
    }

    return byQuality;
  }, [arcgisQuery.data, mercatorToLatLng]);

  const [visibleMarkers, setVisibleMarkers] = useState<any[]>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY_MARKERS);
      if (raw) return JSON.parse(raw);
    } catch (e) {
    }
    return [];
  });

  useEffect(() => {
    if (markers && markers.length > 0) setVisibleMarkers(markers);
  }, [markers]);

  useEffect(() => {
    let t = 0 as unknown as number;
    t = window.setTimeout(() => {
      try {
        const raw: any = arcgisQuery.data;
        if (raw && Array.isArray(raw.features) && raw.features.length > 0) {
          void raw.features.map((f: any) => f?.attributes?.Rodzaj_obi ?? null);
        } else if (visibleMarkers && visibleMarkers.length > 0) {
          void visibleMarkers.map((m: any) => m.raw?.Rodzaj_obi ?? null);
        } 
      } catch (e) {
      }
    }, 2000);
    return () => window.clearTimeout(t);
  }, [arcgisQuery.data, visibleMarkers]);

  const loadErrorFlag = !!loadError;
  const loadingFlag = !isLoaded;

  function haversineDistance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const toRad = (v: number) => (v * Math.PI) / 180;
    const R = 6371000; // meters
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const x = sinDLat * sinDLat + sinDLon * sinDLon * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    return R * c;
  }

  function fmtDistance(meters: number) {
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
    return `${Math.round(meters)} m`;
  }

  function estimateTimes(meters: number) {
    // walking ~5 km/h, driving ~50 km/h
    const walkSpeed = 5000 / 3600; // m/s
    const driveSpeed = 50000 / 3600; // m/s
    const walkSec = meters / walkSpeed;
    const driveSec = meters / driveSpeed;
    const toMin = (s: number) => Math.max(1, Math.round(s / 60));
    return { walkMin: toMin(walkSec), driveMin: toMin(driveSec) };
  }
  const currentPeopleMap = useMemo(() => {
    const map: Record<string | number, number> = {};
    visibleMarkers.forEach((m) => {
      const cap = Number(m.capacity) || 0;
      const id = m.id ?? Math.random();
      if (cap > 0) {
        map[id] = Math.floor(Math.random() * (cap + 1));
      } else {
        map[id] = 0;
      }
    });
    return map;
  }, [visibleMarkers]);

  function badgeInfo(current: number, capacity: number) {
    if (capacity <= 0) return { text: "Unknown", color: "gray" };
    const p = current / capacity;
    if (p >= 0.98) return { text: "Full", color: "#e02424" }; // red
    if (p >= 0.75) return { text: "Almost full", color: "#ff8c00" }; // orange
    return { text: "Suitable", color: "#22c55e" }; // green
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ width: "100%", height: "60vh" }}>
        {loadErrorFlag ? (
          <div style={{ padding: 20 }}>Map load error</div>
        ) : loadingFlag ? (
          <div style={{ padding: 20 }}>Loading map…</div>
        ) : (
          <GoogleMap
            mapContainerStyle={{ width: "100%", height: "100%" }}
            center={center}
            zoom={zoom}
            onLoad={onLoad}
            onIdle={onIdle}
            options={{
              styles: [
                { featureType: "poi", elementType: "all", stylers: [{ visibility: "off" }] },
                { featureType: "transit", elementType: "labels", stylers: [{ visibility: "on" }] },
              ],
              streetViewControl: false,
              mapTypeControl: false,
            }}
          >
            {visibleMarkers.map((m) => {
              const rodzajRaw = (m.raw?.Rodzaj_obi ?? "").toString();
              const rodzaj = rodzajRaw.toLowerCase();
              const codeMatch = rodzajRaw.match(/\[\s*(\d+)\s*\]/);
              let icon = "/blue-marker.png";
              if (codeMatch) {
                const code = codeMatch[1];
                if (code === "1") icon = "/red-marker.png";
                else if (code === "2") icon = "/yellow-marker.png";
                else if (code === "3") icon = "/blue-marker.png";
              } else if (/schron|\(s\)/i.test(rodzaj)) {
                icon = "/red-marker.png";
              } else if (/ukry|\(u\)/i.test(rodzaj)) {
                icon = "/yellow-marker.png";
              } else if (/mds/i.test(rodzaj)) {
                icon = "/blue-marker.png";
              }

              return <Marker key={m.id} position={m.position} icon={icon} />;
            })}
          </GoogleMap>
        )}
      </div>

      <div style={{ height: "40vh", overflowY: "auto", padding: 12, borderTop: "1px solid #eee" }}>
        {visibleMarkers.length === 0 ? (
          <div>No markers available</div>
        ) : (
          visibleMarkers.map((m) => {
            const title = m.raw?.Nazwa || m.raw?.Name || m.raw?.NAZWA || m.raw?.Adres || "Unnamed";
            const street = m.raw?.Adres || m.raw?.Ulica || "";
            const dist = haversineDistance(center, m.position);
            const { walkMin, driveMin } = estimateTimes(dist);
            const capacity = Number(m.capacity) || (m.raw && Number(m.raw['Pojemnoś_'] ?? m.raw.Pojemnosc ?? m.raw.POJEMNOSC)) || 0;
            const current = currentPeopleMap[m.id] ?? 0;
            const badge = badgeInfo(current, capacity);

            return (
              <div key={m.id} style={{ display: "flex", gap: 12, padding: 12, borderBottom: "1px solid #f0f0f0" }}>
                <div style={{ flex: "1 1 0" }}>
                  <div style={{ fontWeight: 600 }}>{title}</div>
                  <div style={{ color: "#666", fontSize: 13 }}>{street}</div>
                  <div style={{ marginTop: 8, fontSize: 13 }}>
                    Distance: {fmtDistance(dist)} — Walk: {walkMin} min • Drive: {driveMin} min
                  </div>
                </div>
                <div style={{ width: 140, textAlign: "right" }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{current}/{capacity}</div>
                  <div style={{ marginTop: 8 }}>
                    <span style={{ background: badge.color, color: "white", padding: "4px 8px", borderRadius: 12, fontSize: 12 }}>
                      {badge.text}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
