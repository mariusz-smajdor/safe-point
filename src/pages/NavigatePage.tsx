import { useEffect, useMemo, useRef, useState } from "react";
import { useLoadScript, GoogleMap, Marker, DirectionsRenderer, Polyline } from "@react-google-maps/api";

const ARCGIS_BASE =
  "https://services-eu1.arcgis.com/HE4WRthd9CIPj0R8/arcgis/rest/services/schrony_csv/FeatureServer/0/query";

function latLngToMercator(lat: number, lng: number) {
  const R = 6378137.0;
  const x = (lng * Math.PI) / 180 * R;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * R;
  return { x, y };
}

function mercatorToLatLng(x: number, y: number) {
  const R = 6378137.0;
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return { lat, lng: lon };
}

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

function getShelterDisplayName(raw: Record<string, any> | undefined | null) {
  if (!raw) return "-";
  const nameFields = [
    "Nazwa",
    "NAZWA",
    "Name",
    "NAZWA_1",
    "NAZWA_2",
    "Nazwa_obiektu",
    "NAZWA_OBIEKTU",
    "NAZWAOBIEKTU",
  ];
  let name: string | null = null;
  for (const k of nameFields) {
    const v = raw[k];
    if (v && typeof v === "string" && v.trim().length > 0) {
      name = v.trim();
      break;
    }
  }

  if (!name) {
    const addr = raw?.Adres || raw?.Ulica || raw?.Address || raw?.adres || null;
    if (addr && typeof addr === "string" && addr.trim().length > 0) name = addr.trim();
  }

  const kindRaw = (raw?.Rodzaj_obi || raw?.Rodzaj || "").toString();
  let prefix = "Schron";
  let level = "";
  const codeMatch = kindRaw.match(/\[\s*(\d+)\s*\]/);
  if (codeMatch) {
    const code = codeMatch[1];
    if (code === "1") {
      prefix = "Schron";
      level = "L3";
    } else if (code === "2") {
      prefix = "Ukrycie";
      level = "L2";
    } else if (code === "3") {
      prefix = "MDS";
      level = "L1";
    }
  } else {
    const kindLower = kindRaw.toLowerCase();
    if (/schron|\(s\)/i.test(kindLower)) {
      prefix = "Schron";
      level = "L3";
    } else if (/ukry|\(u\)/i.test(kindLower)) {
      prefix = "Ukrycie";
      level = "L2";
    } else if (/mds/i.test(kindLower)) {
      prefix = "MDS";
      level = "L1";
    }
  }

  const parts: string[] = [];
  if (prefix) parts.push(prefix + (level ? ` ${level}` : ""));
  if (name) parts.push(name);
  if (parts.length === 0 && kindRaw) parts.push(kindRaw);
  return parts.join(" - ");
}

function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, "");
}

function buildOsrmInstruction(step: any) {
  const mv = step.maneuver || {};
  const type = (mv.type || "").toString();
  const modifier = (mv.modifier || "").toString();
  const name = step.name || "";
  if (type === "depart") return `Head ${modifier || "straight"}${name ? ` on ${name}` : ""}`;
  if (type === "arrive") return `Arrive at ${name || "destination"}`;
  if (type === "turn") {
    const dir = modifier || "";
    if (name) return `Turn ${dir} onto ${name}`;
    return `Turn ${dir}`;
  }
  if (type === "roundabout") return `Enter roundabout${name ? `, ${name}` : ""}`;
  if (type === "merge") return `Merge${name ? ` onto ${name}` : ""}`;
  if (type === "on ramp" || type === "off ramp") return `${type}${name ? ` ${name}` : ""}`;
  return name || (step.ref ? `Follow ${step.ref}` : "Continue");
}

const CACHE_USERPOS_KEY = 'nav:userPos';
const CACHE_CAND_KEY = 'nav:candidates';
const CACHE_BEST_KEY = 'nav:best';

function loadCached<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) as T : null;
  } catch (e) {
    return null;
  }
}

function saveCached<T>(k: string, v: T) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
  }
}

export default function NavigatePage() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
  const { isLoaded, loadError } = useLoadScript({ googleMapsApiKey: apiKey });

  const mapRef = useRef<any | null>(null);
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [best, setBest] = useState<any | null>(null);
  const [mode, setMode] = useState<'WALKING' | 'DRIVING'>('WALKING');
  const [directions, setDirections] = useState<any | null>(null);

  useEffect(() => {
    const cached = loadCached<{ lat: number; lng: number }>(CACHE_USERPOS_KEY);
    // if offline and we have a cached position, use it
    if (typeof navigator !== 'undefined' && !navigator.onLine && cached) {
      setUserPos(cached);
      return;
    }

    if (!navigator.geolocation) {
      if (cached) setUserPos(cached);
      else setUserPos({ lat: 50.06465, lng: 19.94498 });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserPos(p);
        try { saveCached(CACHE_USERPOS_KEY, p); } catch (e) {}
      },
      () => {
        if (cached) setUserPos(cached);
        else setUserPos({ lat: 50.06465, lng: 19.94498 });
      },
      { enableHighAccuracy: true }
    );
  }, []);

  useEffect(() => {
    if (!userPos) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const cached = loadCached<any[]>(CACHE_CAND_KEY);
      if (cached && cached.length > 0) {
        setCandidates(cached);
        return;
      }
      setCandidates([]);
      return;
    }
    const c = latLngToMercator(userPos.lat, userPos.lng);
    const pad = 15000; // meters
    const geometry = `${c.x - pad},${c.y - pad},${c.x + pad},${c.y + pad}`;
    const params = new URLSearchParams({
      f: 'json',
      geometry,
      geometryType: 'esriGeometryEnvelope',
      inSR: '3857',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*,x,y',
      outSR: '3857',
      resultRecordCount: '400',
      where: '1=1',
      returnGeometry: 'true',
    });

    fetch(`${ARCGIS_BASE}?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        const features = Array.isArray(d.features) ? d.features : [];
        const mapped = features
          .map((f: any) => {
            const attrs = f.attributes || {};
            let coords: any = null;
            if (f.geometry && typeof f.geometry.x === 'number') coords = { x: f.geometry.x, y: f.geometry.y };
            if (!coords) {
              const xk = Object.keys(attrs).find((k) => /(^x$|lon|long|longitude|point_x)/i.test(k));
              const yk = Object.keys(attrs).find((k) => /(^y$|lat|latitude|point_y)/i.test(k));
              if (xk && yk) {
                const x = Number(attrs[xk]);
                const y = Number(attrs[yk]);
                if (!Number.isNaN(x) && !Number.isNaN(y)) coords = { x, y };
              }
            }
            if (!coords) return null;
            return {
              id: attrs.ObjectId ?? attrs.OBJECTID ?? attrs.ObjectId2 ?? Math.random(),
              position: mercatorToLatLng(coords.x, coords.y),
              capacity: Number(attrs['Pojemnoś_'] ?? attrs.Pojemnosc ?? attrs.POJEMNOSC) || 0,
              raw: attrs,
            };
          })
          .filter(Boolean);

        setCandidates(mapped);
        try { saveCached(CACHE_CAND_KEY, mapped); } catch (e) { /* ignore */ }
      })
      .catch(() => {
        const cached = loadCached<any[]>(CACHE_CAND_KEY);
        if (cached && cached.length > 0) setCandidates(cached);
        else setCandidates([]);
      });
  }, [userPos]);

  useEffect(() => {
    if (!userPos || candidates.length === 0) return;
    const withDist = candidates.map((c) => ({ ...c, dist: haversineDistance(userPos, c.position) }));
    withDist.sort((a, b) => a.dist - b.dist);
    const nearest = withDist[0] ?? null;
    setBest(nearest);
    try { if (nearest) saveCached(CACHE_BEST_KEY, nearest); } catch (e) { /* ignore */ }
  }, [candidates, userPos]);

  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [osrmRoute, setOsrmRoute] = useState<{ coords: { lat: number; lng: number }[]; duration: number; distance: number } | null>(null);
  const [routeSteps, setRouteSteps] = useState<any[]>([]);
  useEffect(() => {
    if (!isLoaded || !userPos || !best) {
      setDirections(null);
      setEtaSeconds(null);
      return;
    }
    try {
      const gm = (window as any).google;
      if (!gm || !gm.maps) {
        setDirections(null);
        setEtaSeconds(null);
        return;
      }
      const ds = new gm.maps.DirectionsService();
      const travelMode = mode === 'WALKING' ? gm.maps.TravelMode.WALKING : gm.maps.TravelMode.DRIVING;
      ds.route({ origin: userPos, destination: best.position, travelMode, provideRouteAlternatives: false }, (res: any, status: string) => {
        if (status === 'OK' && res && res.routes && res.routes[0] && res.routes[0].legs && res.routes[0].legs[0]) {
          setDirections(res);
          setOsrmRoute(null);
          const eta = res.routes[0].legs[0].duration?.value ?? null;
          setEtaSeconds(typeof eta === 'number' ? eta : null);
          try {
            const gsteps = res.routes[0].legs[0].steps || [];
            const parsed = gsteps.map((s: any) => ({
              instruction: stripHtml(s.instructions || ""),
              distance: s.distance?.value ?? null,
              duration: s.duration?.value ?? null,
              end_location: { lat: typeof s.end_location?.lat === 'function' ? s.end_location.lat() : s.end_location?.lat, lng: typeof s.end_location?.lng === 'function' ? s.end_location.lng() : s.end_location?.lng },
            }));
            setRouteSteps(parsed);
          } catch (e) {
            setRouteSteps([]);
          }
        } else {
          setDirections(null);
          (async () => {
            try {
              const profile = mode === 'WALKING' ? 'walking' : 'driving';
              const from = `${userPos.lng},${userPos.lat}`;
              const to = `${best.position.lng},${best.position.lat}`;
              const url = `https://router.project-osrm.org/route/v1/${profile}/${from};${to}?overview=full&geometries=geojson&steps=true`;
              const r = await fetch(url);
              if (!r.ok) {
                const distMeters = best?.dist ?? haversineDistance(userPos, best.position);
                const walkSpeed = 5000 / 3600;
                const driveSpeed = 50000 / 3600;
                const secs = mode === 'WALKING' ? Math.round(distMeters / walkSpeed) : Math.round(distMeters / driveSpeed);
                setEtaSeconds(secs);
                setOsrmRoute(null);
                setRouteSteps([]);
                return;
              }
              const jd = await r.json();
              const route = jd.routes && jd.routes[0];
              if (route && route.geometry && Array.isArray(route.geometry.coordinates)) {
                const coords = route.geometry.coordinates.map((c: any) => ({ lat: c[1], lng: c[0] }));
                setOsrmRoute({ coords, duration: route.duration ?? 0, distance: route.distance ?? 0 });
                setEtaSeconds(typeof route.duration === 'number' ? Math.round(route.duration) : null);
                try {
                  const osrmLeg = jd.routes[0].legs && jd.routes[0].legs[0];
                  const osrmSteps = (osrmLeg && osrmLeg.steps) || [];
                  const parsed = osrmSteps.map((s: any) => ({
                    instruction: buildOsrmInstruction(s),
                    distance: s.distance ?? null,
                    duration: s.duration ?? null,
                    end_location: s.maneuver && Array.isArray(s.maneuver.location) ? { lat: s.maneuver.location[1], lng: s.maneuver.location[0] } : null,
                  }));
                  setRouteSteps(parsed);
                } catch (e) {
                  setRouteSteps([]);
                }
              } else {
                const distMeters = best?.dist ?? haversineDistance(userPos, best.position);
                const walkSpeed = 5000 / 3600;
                const driveSpeed = 50000 / 3600;
                const secs = mode === 'WALKING' ? Math.round(distMeters / walkSpeed) : Math.round(distMeters / driveSpeed);
                setEtaSeconds(secs);
                setOsrmRoute(null);
                setRouteSteps([]);
              }
            } catch (e) {
              const distMeters = best?.dist ?? haversineDistance(userPos, best.position);
              const walkSpeed = 5000 / 3600;
              const driveSpeed = 50000 / 3600;
              const secs = mode === 'WALKING' ? Math.round(distMeters / walkSpeed) : Math.round(distMeters / driveSpeed);
              setEtaSeconds(secs);
              setOsrmRoute(null);
              setRouteSteps([]);
            }
          })();
        }
      });
    } catch (e) {
      setDirections(null);
      setEtaSeconds(null);
    }
  }, [isLoaded, userPos, best, mode]);

  const center = useMemo(() => userPos ?? { lat: 50.06465, lng: 19.94498 }, [userPos]);
  const currentStepIndex = useMemo(() => {
    if (!userPos || !routeSteps || routeSteps.length === 0) return -1;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < routeSteps.length; i++) {
      const step = routeSteps[i];
      const loc = step.end_location;
      if (!loc) continue;
      const d = haversineDistance(userPos, { lat: loc.lat, lng: loc.lng });
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, [routeSteps, userPos]);

  const currentInstruction = currentStepIndex >= 0 && routeSteps[currentStepIndex] ? routeSteps[currentStepIndex].instruction : null;
  const nextInstruction = currentStepIndex >= 0 && routeSteps[currentStepIndex + 1] ? routeSteps[currentStepIndex + 1].instruction : null;

  // compute time left from steps if possible, otherwise use etaSeconds fallback
  const timeLeftFromSteps = useMemo(() => {
    if (!routeSteps || routeSteps.length === 0 || currentStepIndex < 0) return null;
    let s = 0;
    for (let i = currentStepIndex; i < routeSteps.length; i++) {
      const d = Number(routeSteps[i].duration || 0);
      s += isFinite(d) ? d : 0;
    }
    return s > 0 ? s : null;
  }, [routeSteps, currentStepIndex]);

  const timeLeftSeconds = timeLeftFromSteps ?? etaSeconds;
  const etaColor = useMemo(() => {
    const minutes = Math.round(((timeLeftSeconds || 0) / 60) || 0);
    if (minutes > 20) return '#e02424';
    if (minutes > 10) return '#ff8c00';
    return '#22c55e';
  }, [timeLeftSeconds]);

  if (loadError) return <div style={{ padding: 20 }}>Map load error</div>;
  if (!isLoaded) return <div style={{ padding: 20 }}>Loading map…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ height: '72vh' }}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={center}
          zoom={14}
    onLoad={(m) => { mapRef.current = m; }}
        >
          {userPos && <Marker position={userPos} label="You" />}
          {best && <Marker position={best.position} icon={'/red-marker.png'} />}
          {directions ? (
            <DirectionsRenderer directions={directions} />
          ) : osrmRoute ? (
            <>
              <Polyline path={osrmRoute.coords} options={{ strokeColor: '#ffffff', strokeOpacity: 0.9, strokeWeight: 10 }} />
              <Polyline path={osrmRoute.coords} options={{ strokeColor: '#1976d2', strokeOpacity: 0.95, strokeWeight: 6 }} />
            </>
          ) : null}
        </GoogleMap>
      </div>

      <div style={{ padding: 12, borderTop: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Best shelter</div>
            <div>{getShelterDisplayName(best?.raw)}</div>
          <div style={{ color: '#666', fontSize: 13 }}>{best ? `${Math.round(best.dist)} m · ${best.current ?? 0}/${best.capacity ?? 0} used` : ''}</div>
          {/* current and next instructions */}
          {currentInstruction ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{currentInstruction}</div>
              {nextInstruction && <div style={{ fontSize: 14, color: '#555', marginTop: 4 }}>Then: {nextInstruction}</div>}
            </div>
          ) : null}

          {/* ETA badge, colored by proximity */}
          {timeLeftSeconds != null && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'inline-block', background: etaColor, color: 'white', padding: '8px 12px', borderRadius: 8, fontWeight: 700 }}>
                {Math.max(1, Math.round(timeLeftSeconds / 60))} min left
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setMode('WALKING')}
            style={{ padding: '10px 14px', background: mode === 'WALKING' ? '#1976d2' : '#eee', color: mode === 'WALKING' ? 'white' : '#000', border: 'none', borderRadius: 6 }}
          >
            Foot
          </button>
          <button
            onClick={() => setMode('DRIVING')}
            style={{ padding: '10px 14px', background: mode === 'DRIVING' ? '#1976d2' : '#eee', color: mode === 'DRIVING' ? 'white' : '#000', border: 'none', borderRadius: 6 }}
          >
            Car
          </button>
        </div>
      </div>
    </div>
  );
}
