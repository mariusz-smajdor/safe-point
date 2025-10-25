import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoadScript, GoogleMap, Marker, DirectionsRenderer } from "@react-google-maps/api";
import { useQuery } from "@tanstack/react-query";

export default function MapPage() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: apiKey });

  // Do not early-return here — hooks below must run on every render to preserve hook order.

  // Map refs and state
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

      // basement bonus
      const basementKeywords = /\b(piwn|podziem|podziemny|podziemie|parking|gara[żz])\b/i;
      const basementBonus = basementKeywords.test((attrs.Adres || "") + " " + (attrs.Rodzaj_inw || "")) ? 0.08 : 0;

      // capacity normalized (assume 200 is large); capScore in [0,1]
      const capScore = Math.min(capacity / 200, 1);

      // final score (weights chosen to favor explicit types but still value capacity)
      const score = 0.6 * typeScore + 0.35 * capScore + basementBonus;
      return score;
    }

    const scored = mapped.map((it: any) => ({ ...it, qualityScore: scoreFeature(it) }));
    const byQuality = scored.sort((a: any, b: any) => (b.qualityScore || 0) - (a.qualityScore || 0)).slice(0, 10);

    try {
      localStorage.setItem(CACHE_KEY_MARKERS, JSON.stringify(byQuality));
    } catch (e) {
      /* ignore */
    }

    return byQuality;
  }, [arcgisQuery.data, mercatorToLatLng]);

  // If we don't have fresh data, load cached markers into state
  const [visibleMarkers, setVisibleMarkers] = useState<any[]>(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY_MARKERS);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* ignore */
    }
    return [];
  });

  useEffect(() => {
    if (markers && markers.length > 0) setVisibleMarkers(markers);
  }, [markers]);

  // Debounced logger: show Rodzaj_obi of every feature/marker
  useEffect(() => {
    let t = 0 as unknown as number;
    t = window.setTimeout(() => {
      try {
        const raw: any = arcgisQuery.data;
        if (raw && Array.isArray(raw.features) && raw.features.length > 0) {
          // extract Rodzaj_obi from each feature (include nulls for transparency)
          void raw.features.map((f: any) => f?.attributes?.Rodzaj_obi ?? null);
        } else if (visibleMarkers && visibleMarkers.length > 0) {
          // fallback: extract from visibleMarkers' raw attrs
          void visibleMarkers.map((m: any) => m.raw?.Rodzaj_obi ?? null);
        } else {
          // logging removed per request
        }
      } catch (e) {
        // ignore logging errors
      }
    }, 2000);
    return () => window.clearTimeout(t);
  }, [arcgisQuery.data, visibleMarkers]);

  // Do not early-return; render loading/error UI inside the JSX so hook order is stable
  const loadErrorFlag = !!loadError;
  const loadingFlag = !isLoaded;

  // If cached center exists and no network, center will be from localStorage initial state

  // distance helper (meters)
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

  // generate a stable-ish random currentPeople per marker id (memoized)
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

  // Routing & selection state
  const [selectedMode, setSelectedMode] = useState<"WALKING" | "DRIVING">("WALKING");
  const [bestMarker, setBestMarker] = useState<any | null>(null);
  const [directionsResults, setDirectionsResults] = useState<Record<string, google.maps.DirectionsResult | null>>({ WALKING: null, DRIVING: null });
  const [showDetails, setShowDetails] = useState(false);

  // badge helper
  function badgeInfo(current: number, capacity: number) {
    if (capacity <= 0) return { text: "Unknown", color: "gray" };
    const p = current / capacity;
    if (p >= 0.98) return { text: "Full", color: "#e02424" }; // red
    if (p >= 0.75) return { text: "Almost full", color: "#ff8c00" }; // orange
    return { text: "Suitable", color: "#22c55e" }; // green
  }

  // Helpers: protection level
  function protectionLevelCategory(raw: any) {
    const k = (raw?.Rodzaj_obi || "").toString().toLowerCase();
    if (/schron|\(s\)/i.test(k)) return { level: "L3", label: "High" };
    if (/ukry|\(u\)/i.test(k)) return { level: "L2", label: "Medium" };
    if (/mds/i.test(k)) return { level: "L1", label: "Low" };
    return { level: "L1", label: "Low" };
  }

  // Promise wrapper for DirectionsService.route
  function routePromise(origin: google.maps.LatLngLiteral, dest: google.maps.LatLngLiteral, travelMode: google.maps.TravelMode) {
    return new Promise<google.maps.DirectionsResult>((resolve, reject) => {
      const service = new google.maps.DirectionsService();
      service.route(
        {
          origin,
          destination: dest,
          travelMode,
        },
        (result, status) => {
          if (status === "OK" && result) resolve(result);
          else reject(new Error(`Directions request failed: ${status}`));
        }
      );
    });
  }

  // Find best shelter considering route time, availability and qualityScore
  const findBestShelter = useCallback(async () => {
    if (!visibleMarkers || visibleMarkers.length === 0) return;
    const origin = center;
    const candidates = visibleMarkers.filter((m) => {
      const cap = Number(m.capacity) || 0;
      const current = currentPeopleMap[m.id] ?? 0;
      return cap > 0 && current < cap; // exclude full
    });
    if (candidates.length === 0) {
      setBestMarker(null);
      return;
    }

    // compute directions for each candidate for both modes (best-effort, fall back to distance estimate)
    const entries: Array<{ marker: any; walkingSec: number | null; drivingSec: number | null; qualityScore?: number }>
      = [];
    for (const m of candidates) {
      let walkSec: number | null = null;
      let driveSec: number | null = null;
      try {
        const walkRes = await routePromise(origin, m.position, google.maps.TravelMode.WALKING);
        walkSec = walkRes.routes[0].legs.reduce((s, leg: any) => s + (leg.duration?.value || 0), 0);
        // cache walking result
        setDirectionsResults((prev) => ({ ...prev, WALKING: walkRes }));
      } catch (e) {
        walkSec = Math.round(haversineDistance(origin, m.position) / (5000 / 3600));
      }
      try {
        const driveRes = await routePromise(origin, m.position, google.maps.TravelMode.DRIVING);
        driveSec = driveRes.routes[0].legs.reduce((s, leg: any) => s + (leg.duration?.value || 0), 0);
        setDirectionsResults((prev) => ({ ...prev, DRIVING: driveRes }));
      } catch (e) {
        driveSec = Math.round(haversineDistance(origin, m.position) / (50000 / 3600));
      }
      entries.push({ marker: m, walkingSec: walkSec, drivingSec: driveSec, qualityScore: (m.qualityScore ?? 0) });
    }

    // choose best by combining availability, normalized duration and qualityScore for currently selected mode
    const mode = selectedMode;
    const durValues = entries.map((e) => (mode === "WALKING" ? e.walkingSec ?? 0 : e.drivingSec ?? 0));
    const maxDur = Math.max(...durValues, 1);
    let best: any = null;
    let bestScore = -Infinity;
    for (const e of entries) {
      const cap = Number(e.marker.capacity) || 0;
      const current = currentPeopleMap[e.marker.id] ?? 0;
      const availability = cap > 0 ? (cap - current) / cap : 0;
      const dur = mode === "WALKING" ? (e.walkingSec ?? maxDur) : (e.drivingSec ?? maxDur);
      const durNorm = dur / maxDur;
      const score = 0.5 * availability + 0.35 * (e.qualityScore || 0) - 0.15 * durNorm;
      if (score > bestScore) {
        bestScore = score;
        best = { marker: e.marker, duration: dur, score };
      }
    }

    if (best) {
      setBestMarker(best.marker);
      // ensure we have the directions result for the chosen mode
      try {
        const result = await routePromise(origin, best.marker.position, mode === "WALKING" ? google.maps.TravelMode.WALKING : google.maps.TravelMode.DRIVING);
        setDirectionsResults((prev) => ({ ...prev, [mode]: result }));
      } catch (e) {
        // ignore
      }
      setShowDetails(true);
    }
  }, [visibleMarkers, center, currentPeopleMap, selectedMode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ width: "100%", height: "60vh", position: "relative" }}>
        <div style={{ position: "absolute", zIndex: 10, left: 12, top: 12, display: "flex", gap: 8 }}>
          <button onClick={() => findBestShelter()} style={{ padding: "8px 12px" }}>
            Find safe shelter
          </button>
          <div style={{ display: "flex", background: "white", borderRadius: 6, overflow: "hidden" }}>
            <button
              onClick={() => setSelectedMode("WALKING")}
              style={{ padding: "8px 10px", background: selectedMode === "WALKING" ? "#eef" : "transparent" }}
            >
              Walking
            </button>
            <button
              onClick={() => setSelectedMode("DRIVING")}
              style={{ padding: "8px 10px", background: selectedMode === "DRIVING" ? "#eef" : "transparent" }}
            >
              Driving
            </button>
          </div>
        </div>

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
              // try numeric code like "[1]"
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

            {/* Render selected directions */}
            {directionsResults[selectedMode] ? (
              <DirectionsRenderer directions={directionsResults[selectedMode] as google.maps.DirectionsResult} />
            ) : null}
          </GoogleMap>
        )}
      </div>

      {/* Route/communicate panel */}
      <div style={{ padding: 12, borderTop: "1px solid #eee", background: "#fafafa" }}>
        {directionsResults[selectedMode] || bestMarker ? (
          (() => {
            const dir = directionsResults[selectedMode];
            const leg = dir?.routes?.[0]?.legs?.[0];
            const steps: any[] = leg?.steps ?? [];
            const currentInstr = steps[0]?.instructions ? steps[0].instructions.replace(/<[^>]*>/g, "") : "";
            const nextInstr = steps[1]?.instructions ? steps[1].instructions.replace(/<[^>]*>/g, "") : "";
            const durationSec = leg?.duration?.value ?? null;
            const etaColor = durationSec == null ? "gray" : durationSec <= 600 ? "#22c55e" : durationSec <= 1800 ? "#ff8c00" : "#e02424";
            const best = bestMarker ?? (visibleMarkers && visibleMarkers.length ? visibleMarkers[0] : null);
            const capacity = Number(best?.capacity) || (best?.raw && Number(best.raw['Pojemnoś_'] ?? best.raw.Pojemnosc ?? best.raw.POJEMNOSC)) || 0;
            const currentCount = currentPeopleMap[best?.id] ?? 0;
            const prot = protectionLevelCategory(best?.raw ?? {});

            return (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{currentInstr || "No route instruction"}</div>
                  <div style={{ color: "#666", fontSize: 13, marginTop: 6 }}>{nextInstr ? `Then: ${nextInstr}` : ""}</div>
                </div>
                <div style={{ width: 160, textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: etaColor }}>{durationSec ? `${Math.ceil(durationSec / 60)} min` : "—"}</div>
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => setShowDetails((s) => !s)} style={{ padding: "6px 10px" }}>
                      {showDetails ? "Hide details" : "Details"}
                    </button>
                  </div>
                </div>
                {showDetails ? (
                  <div style={{ width: "100%", marginTop: 12, padding: 12, background: "white", borderRadius: 8 }}>
                    <div style={{ fontWeight: 700 }}>Closest safe place to you</div>
                    <div style={{ marginTop: 6 }}>{best?.raw?.Nazwa || best?.raw?.Name || best?.raw?.Adres || "Unnamed"}</div>
                    <div style={{ marginTop: 8 }}>Available places: {currentCount}/{capacity}</div>
                    <div style={{ marginTop: 6 }}>Protection level: {prot.level} - {prot.label}</div>
                  </div>
                ) : null}
              </div>
            );
          })()
        ) : (
          <div style={{ color: "#666" }}>No active route — click "Find safe shelter" to calculate routes.</div>
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
