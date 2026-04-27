"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { APIProvider, AdvancedMarker, Map, Pin } from "@vis.gl/react-google-maps";
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getDb, hasFirebaseConfig } from "../../lib/firebase";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const sevColor = {
  Low: "#10b981",
  Medium: "#f59e0b",
  High: "#ef4444",
  Critical: "#3b82f6",
};

const severityOrder = ["Low", "Medium", "High", "Critical"];

function normalizeSeverity(value) {
  const safe = String(value || "low").toLowerCase();
  if (safe === "critical") return "Critical";
  if (safe === "high") return "High";
  if (safe === "medium") return "Medium";
  return "Low";
}

function titleFromType(value) {
  return String(value || "Unknown Incident")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createdAtLabel(value) {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toDisplayIncident(raw) {
  const severity = normalizeSeverity(raw?.severity_level || "low");
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  return {
    id: String(raw?.id || ""),
    title: titleFromType(raw?.incident_type || "incident"),
    incidentType: String(raw?.incident_type || "other"),
    userId: String(raw?.userId || ""),
    location: `${Number.isFinite(lat) ? lat.toFixed(4) : "--"}, ${Number.isFinite(lng) ? lng.toFixed(4) : "--"}`,
    severity,
    lat,
    lng,
    details: String(raw?.description || "No description provided."),
    createdAt: raw?.created_at || null,
    updatedAt: raw?.updatedAt || null,
    status: String(raw?.status || "pending"),
    priorityScore: raw?.priority_score ?? null,
    threatGrowth: raw?.threat_growth ?? null,
    prediction: raw?.prediction ?? null,
    dispatchAction: raw?.dispatch_action ?? null,
    dispatchReason: raw?.dispatch_reason ?? null,
    briefing: raw?.briefing ?? null,
    createdAtRaw: raw?.createdAt || null,
    imageUrl: raw?.imageUrl || null,
    isRead: raw?.read === true,
  };
}

function inferIncidentType(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("fire")) return "fire";
  if (value.includes("flood")) return "flood";
  if (value.includes("gas")) return "gas_leak";
  if (value.includes("collapse")) return "building_collapse";
  if (value.includes("cyclone")) return "cyclone";
  if (value.includes("hazmat") || value.includes("chemical")) return "hazmat";
  if (value.includes("injury") || value.includes("medical") || value.includes("ambulance")) return "medical";
  return "other";
}

function buildPredictPayload(analysis, incident) {
  const nowHour = new Date().getHours();
  const timeOfDay = nowHour < 12 ? "morning" : nowHour < 17 ? "afternoon" : "night";
  const description = String(incident.details || "").toLowerCase();
  const peopleTrapped = description.includes("trapped") ? "yes" : "no";
  const hazardousMaterial =
    description.includes("chemical") || description.includes("gas") || description.includes("hazmat")
      ? "yes"
      : "no";
  return {
    incident_type: analysis?.incident_type || inferIncidentType(incident.details),
    location_type: "urban",
    time_of_day: timeOfDay,
    severity_level: String(analysis?.severity_level || "medium").toLowerCase(),
    people_trapped: peopleTrapped,
    hazardous_material: hazardousMaterial,
    resource_availability: "medium",
  };
}

function SevBadge({ value }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      borderRadius: 999,
      padding: "2px 8px",
      border: `1px solid ${sevColor[value]}44`,
      background: `${sevColor[value]}14`,
      fontSize: "0.72rem",
      fontWeight: 600,
      letterSpacing: "0.02em",
      color: sevColor[value],
      whiteSpace: "nowrap",
    }}>
      <span style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: sevColor[value],
        flexShrink: 0,
      }} />
      {value}
    </span>
  );
}

const Card = ({ children, title, subtitle, extra, style }) => (
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20, ...style }}>
    {(title || extra) && (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {title && <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8 }}>{title}</div>}
          {subtitle && <div style={{ fontSize: 11, fontWeight: 600, color: '#10b981', background: '#d1fae5', padding: '2px 8px', borderRadius: 12 }}>{subtitle}</div>}
        </div>
        {extra}
      </div>
    )}
    {children}
  </div>
);

function SeverityChart({ incidents }) {
  const total = incidents.length || 1;
  const counts = severityOrder.map((level) => incidents.filter((i) => i.severity === level).length);
  const percentages = counts.map((count) => Math.round((count / total) * 100));

  let current = 0;
  const chartStops = percentages
    .map((pct, idx) => {
      const start = current;
      current += pct;
      return `${sevColor[severityOrder[idx]]} ${start}% ${current}%`;
    })
    .join(", ");

  const chart = `conic-gradient(${chartStops || "#10b981 0 100%"})`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, justifyContent: "space-between" }}>
      <div style={{
        width: 140,
        height: 140,
        borderRadius: "50%",
        background: chart,
        position: "relative",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>
        <div style={{ position: "absolute", inset: 24, borderRadius: "50%", background: "#ffffff" }} />
        <div style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>Total</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#1e293b", lineHeight: 1 }}>{incidents.length}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 12, flexGrow: 1 }}>
        {severityOrder.map((level, idx) => (
          <div key={level} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "#64748b" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: sevColor[level] }} />
              {level}
            </span>
            <span style={{ fontWeight: 600, color: "#1e293b" }}>{percentages[idx]}%</span>
            <span>({counts[idx]})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: "#f7faff",
      border: "1px solid #d9e5ff",
      borderRadius: 10,
      padding: "10px 14px",
    }}>
      <div style={{ fontSize: "0.7rem", color: "#6f83ad", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: "1.35rem", fontWeight: 700, color: color || "#1e3f7d", lineHeight: 1 }}>{value}</div>
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("visualization");
  const [selectedId, setSelectedId] = useState(null);
  const [modalIncidentId, setModalIncidentId] = useState(null);
  const [mapsKey, setMapsKey] = useState("");
  const [mapsError, setMapsError] = useState("");
  const [incidents, setIncidents] = useState([]);
  const [loadingIncidents, setLoadingIncidents] = useState(true);
  const [incidentsError, setIncidentsError] = useState("");
  const [processingIncidentId, setProcessingIncidentId] = useState(null);
  const [processingErrors, setProcessingErrors] = useState({});
  const [imageAnalysisLoading, setImageAnalysisLoading] = useState(false);
  const [imageAnalysisResults, setImageAnalysisResults] = useState({});
  const [showNotifications, setShowNotifications] = useState(false);

  const unreadIncidents = useMemo(() => incidents.filter((i) => !i.isRead), [incidents]);
  const unreadCount = unreadIncidents.length;

  async function handleNotificationClick(incident) {
    try {
      await updateDoc(doc(getDb(), "incidents", incident.id), { read: true });
    } catch (e) {
      console.error("Failed to mark as read", e);
    }
    setShowNotifications(false);
    setModalIncidentId(incident.id);
  }

  function onLogout() {
    localStorage.removeItem("ecsAuth");
    router.replace("/login");
  }

  useEffect(() => {
    const raw = localStorage.getItem("ecsAuth");
    if (!raw) { router.replace("/login"); return; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.role !== "admin") { router.replace("/dashboard"); return; }
    } catch { router.replace("/login"); return; }

    async function loadMapsKey() {
      try {
        const res = await fetch(`${API_URL}/config/google-maps-key`);
        const data = await res.json();
        if (!res.ok || !data?.apiKey) throw new Error(data?.detail || "Unable to fetch Google Maps key");
        setMapsKey(data.apiKey);
      } catch (ex) {
        setMapsError(ex.message || "Unable to load map configuration");
      }
    }
    loadMapsKey();

    const db = getDb();
    if (!hasFirebaseConfig() || !db) {
      setIncidentsError("Firebase is not configured in frontend environment variables.");
      setLoadingIncidents(false);
      return undefined;
    }

    const incidentsQuery = query(collection(db, "incidents"));
    const unsub = onSnapshot(
      incidentsQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((incidentDoc) => {
            const data = incidentDoc.data() || {};
            return toDisplayIncident({ id: incidentDoc.id, ...data });
          })
          .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng))
          .sort((a, b) => {
            const at = typeof a.createdAtRaw?.toMillis === "function" ? a.createdAtRaw.toMillis() : 0;
            const bt = typeof b.createdAtRaw?.toMillis === "function" ? b.createdAtRaw.toMillis() : 0;
            return bt - at;
          });
        setIncidents(next);
        setIncidentsError("");
        setLoadingIncidents(false);
        setSelectedId((prev) => (prev && next.some((item) => item.id === prev) ? prev : next[0]?.id || null));
      },
      () => {
        setIncidentsError("Unable to stream incidents in real-time.");
        setLoadingIncidents(false);
      }
    );
    return () => unsub();
  }, [router]);

  const selected = useMemo(() => incidents.find((i) => i.id === selectedId) || incidents[0] || null, [selectedId, incidents]);
  const stats = useMemo(() => ({
    total: incidents.length,
    alerts: incidents.filter((i) => i.severity === "Critical" || i.severity === "High").length,
    pending: incidents.filter((i) => i.status === "pending").length,
    processing: incidents.filter((i) => i.status === "processing").length,
    resolved: incidents.filter((i) => i.status === "resolved").length,
    activeUnits: 12,
  }), [incidents]);

  const modalIncident = useMemo(() => incidents.find((i) => i.id === modalIncidentId) || null, [incidents, modalIncidentId]);
  const topThreatIncidents = useMemo(
    () => [...incidents].sort((a, b) => (b.threatGrowth || 0) - (a.threatGrowth || 0)).slice(0, 5),
    [incidents]
  );

  async function processIncident(incident) {
    const db = getDb();
    if (!incident?.id || !db) return;
    const incidentRef = doc(db, "incidents", incident.id);
    setProcessingIncidentId(incident.id);
    setIncidentsError("");
    try {
      await updateDoc(incidentRef, { status: "processing", updatedAt: serverTimestamp() });
      const analyzeRes = await fetch(`${API_URL}/analyze-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: incident.details }),
      });
      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok) throw new Error(analyzeData?.detail || "Analyze failed");

      const predictPayload = buildPredictPayload(analyzeData, incident);
      const predictRes = await fetch(`${API_URL}/predict-escalation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(predictPayload),
      });
      const predictData = await predictRes.json();
      if (!predictRes.ok) throw new Error(predictData?.detail || "Predict escalation failed");

      const dispatchRes = await fetch(`${API_URL}/auto-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident: {
            incident_type: analyzeData.incident_type,
            severity_level: analyzeData.severity_level,
            priority_score: analyzeData.priority_score,
            description: incident.details,
            lat: incident.lat,
            lng: incident.lng,
          },
          available_resources: ["Fire Engine", "Ambulance", "Police Unit", "Hazmat Team", "Search & Rescue", "Helicopter"],
        }),
      });
      const dispatchData = await dispatchRes.json();
      if (!dispatchRes.ok) throw new Error(dispatchData?.detail || "Auto dispatch failed");

      const briefingRes = await fetch(`${API_URL}/generate-briefing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incident: {
            incident_type: analyzeData.incident_type,
            severity_level: analyzeData.severity_level,
            priority_score: analyzeData.priority_score,
            description: incident.details,
            lat: incident.lat,
            lng: incident.lng,
          },
          prediction: predictData,
          dispatch: dispatchData,
        }),
      });
      const briefingData = await briefingRes.json();
      if (!briefingRes.ok) throw new Error(briefingData?.detail || "Generate briefing failed");

      await updateDoc(incidentRef, {
        severity_level: analyzeData?.severity_level ?? null,
        priority_score: analyzeData?.priority_score ?? null,
        threat_growth: predictData?.threat_growth ?? null,
        prediction: predictData?.prediction ?? null,
        dispatch_action: dispatchData?.action ?? null,
        dispatch_reason: dispatchData?.reason ?? null,
        briefing: briefingData?.briefing ?? null,
        status: "resolved",
        updatedAt: serverTimestamp(),
      });
      setProcessingErrors((prev) => { const next = { ...prev }; delete next[incident.id]; return next; });
    } catch (ex) {
      setProcessingErrors((prev) => ({ ...prev, [incident.id]: ex.message || "AI processing failed" }));
      setIncidentsError(ex.message || "AI processing failed");
    } finally {
      setProcessingIncidentId(null);
    }
  }

  async function analyzeIncidentImage(incident) {
    if (!incident?.imageUrl) {
      setIncidentsError("No image available for analysis");
      return;
    }

    setImageAnalysisLoading(true);
    setIncidentsError("");

    try {
      const response = await fetch(`${API_URL}/api/analyze-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: incident.imageUrl.split(",")[1] || incident.imageUrl,
          description: incident.details,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || "Image analysis failed");

      setImageAnalysisResults((prev) => ({
        ...prev,
        [incident.id]: data,
      }));
    } catch (ex) {
      setIncidentsError(ex.message || "Image analysis failed");
    } finally {
      setImageAnalysisLoading(false);
    }
  }

  async function onIncidentClick(incident) {
    setSelectedId(incident.id);
    setModalIncidentId(incident.id);
  }

  const tabs = [
    { id: "visualization", label: "Visualization" },
    { id: "map", label: "Map" },
    { id: "reports", label: "Reports" },
  ];

  const buttonProportion = {
    borderRadius: 10,
    minHeight: 34,
    padding: "0 14px",
    fontSize: "0.78rem",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };

  const tabButtonProportion = {
    ...buttonProportion,
    minHeight: 36,
    padding: "0 18px",
    flex: "1 1 180px",
    minWidth: 120,
    letterSpacing: "0.03em",
  };

  return (
    <div style={{ background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* ── HEADER ── */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', background: '#fff', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 8, background: '#eff6ff', color: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#3b82f6', fontWeight: 700, letterSpacing: '0.05em', textTransform: "uppercase" }}>MISSION CONTROL</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>AI Emergency Command Center</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#64748b', fontWeight: 500 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', outline: '2px solid #d1fae5' }} />
            System Online
          </div>
          <div style={{ position: 'relative' }}>
            <button 
              type="button" 
              onClick={() => setShowNotifications(!showNotifications)} 
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
              {unreadCount > 0 && (
                <div style={{ position: 'absolute', top: -6, right: -6, background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700, width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {unreadCount}
                </div>
              )}
            </button>

            {showNotifications && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 12, width: 320, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1)', zIndex: 50, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', fontWeight: 600, color: '#1e293b', fontSize: 13 }}>Notifications</div>
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {unreadCount === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 13 }}>No new notifications</div>
                  ) : (
                    unreadIncidents.map(inc => (
                      <div 
                        key={inc.id} 
                        onClick={() => handleNotificationClick(inc)}
                        style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, transition: 'background 0.15s ease' }}
                        onMouseOver={(e) => e.currentTarget.style.background = '#f8fafc'}
                        onMouseOut={(e) => e.currentTarget.style.background = '#fff'}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{inc.title}</span>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0, marginTop: 4 }} />
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>{inc.location}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{createdAtLabel(inc.createdAt)}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <button type="button" onClick={onLogout} style={{ padding: '8px 16px', background: '#3b82f6', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 600, border: 'none', display: 'flex', alignItems: 'center', gap: 6, cursor: "pointer" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
            Logout
          </button>
        </div>
      </header>

      {/* ── MAIN LAYOUT ── */}
      <main style={{ padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 24 }}>
        
        {/* Left Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          
          {/* Top Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
            {[
              { title: "TOTAL INCIDENTS", count: stats.total, sub: "All time", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>, bg: "#eff6ff", color: "#3b82f6" },
              { title: "HIGH PRIORITY", count: stats.alerts, sub: "Requires attention", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>, bg: "#fee2e2", color: "#ef4444" },
              { title: "ACTIVE UNITS", count: stats.activeUnits, sub: "Deployed", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>, bg: "#d1fae5", color: "#10b981" },
              { title: "RESOLVED TODAY", count: stats.resolved, sub: "+40% vs yesterday", subColor: "#10b981", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>, bg: "#eff6ff", color: "#3b82f6" }
            ].map((s, i) => (
              <Card key={i} style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ background: s.bg, color: s.color, width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '0.05em' }}>{s.title}</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#1e293b', lineHeight: 1.2 }}>{s.count}</div>
                    <div style={{ fontSize: 12, color: s.subColor || '#64748b', marginTop: 4, fontWeight: s.subColor ? 600 : 400 }}>{s.sub}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Map & Feed */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 24 }}>
            <Card title={<><svg width="18" height="18" fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Incident Visualization</>} subtitle="Live" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ borderRadius: 12, overflow: 'hidden', flexGrow: 1, minHeight: 340, background: '#eef2ff' }}>
                {mapsKey ? (
                  <APIProvider apiKey={mapsKey}>
                    <Map defaultCenter={{ lat: 12.9716, lng: 77.5946 }} defaultZoom={12} mapId="admin-map" style={{ width: "100%", height: "100%" }} disableDefaultUI={true}>
                      {incidents.map((incident) => (
                        <AdvancedMarker key={incident.id} position={{ lat: incident.lat, lng: incident.lng }} onClick={() => onIncidentClick(incident)}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', background: `${sevColor[incident.severity]}44`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ width: 12, height: 12, borderRadius: '50%', background: sevColor[incident.severity], border: '2px solid #fff' }} />
                          </div>
                        </AdvancedMarker>
                      ))}
                    </Map>
                  </APIProvider>
                ) : (
                  <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>Loading Map...</div>
                )}
              </div>
            </Card>

            <Card title={<><svg width="18" height="18" fill="none" stroke="#3b82f6" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Realtime Feed</>} extra={<div style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600, cursor: 'pointer' }}>View All</div>}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {incidents.slice(0, 3).map((inc) => (
                  <div key={inc.id} style={{ display: 'flex', gap: 12 }}>
                    <div style={{ width: 12, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: sevColor[inc.severity] || '#3b82f6', marginTop: 4, flexShrink: 0 }} />
                      <div style={{ width: 2, flexGrow: 1, background: '#e2e8f0', margin: '4px 0 -16px 0' }} />
                    </div>
                    <div style={{ flexGrow: 1, background: '#f8fafc', padding: '12px 16px', borderRadius: 8, cursor: 'pointer' }} onClick={() => onIncidentClick(inc)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{inc.title}</div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>{createdAtLabel(inc.createdAt)}</div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                        <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{inc.location}</div>
                        <div style={{ fontSize: 12, color: inc.status === 'resolved' ? '#10b981' : '#f59e0b', fontWeight: 600 }}>
                          {inc.status === 'processing' ? 'Processing' : (inc.status === 'resolved' ? 'Resolved' : '')}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {!incidents.length && <div style={{ color: "#64748b", fontSize: 14 }}>No incidents</div>}
              </div>
            </Card>
          </div>

          {/* Status & Predictions */}
          <Card 
            title={<><svg width="18" height="18" fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Incident Status Overview</>} 
            extra={<div style={{ fontSize: 12, color: '#3b82f6', background: '#eff6ff', padding: '4px 12px', borderRadius: 12, fontWeight: 600, cursor: 'pointer' }}>View All</div>}
          >
            <div style={{ display: 'flex', gap: 16, marginBottom: 32 }}>
              {[
                { label: "Pending", count: stats.pending, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, color: "#3b82f6", bg: "#eff6ff" },
                { label: "Processing", count: stats.processing, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>, color: "#f59e0b", bg: "#fef3c7" },
                { label: "Resolved", count: stats.resolved, icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>, color: "#10b981", bg: "#d1fae5" }
              ].map(s => (
                <div key={s.label} style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ background: s.bg, color: s.color, width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, color: s.color, fontWeight: 700, marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#1e293b', lineHeight: 1 }}>{s.count}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#1e293b' }}>Top Escalation Predictions</div>
              <div style={{ fontSize: 11, color: '#3b82f6', background: '#eff6ff', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>AI Powered</div>
            </div>

            <div>
              {topThreatIncidents.slice(0, 3).map((inc, i) => (
                <div key={inc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', borderBottom: i < 2 ? '1px solid #f1f5f9' : 'none', cursor: 'pointer' }} onClick={() => onIncidentClick(inc)}>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div style={{ fontWeight: 700, color: '#1e293b', fontSize: 16 }}>{i + 1}</div>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#1e293b', marginBottom: 2 }}>{inc.title}</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>{inc.status} • ID {inc.id.slice(0, 6).toUpperCase()}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{inc.threatGrowth ?? 0}%</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>Threat Level</div>
                    </div>
                    <div style={{ width: 80, height: 30 }}>
                      <svg width="100%" height="100%" viewBox="0 0 80 30" preserveAspectRatio="none">
                        <path d={`M0 25 Q 10 20, 20 25 T 40 ${25 - ((inc.threatGrowth || 0)/5)} T 60 20 T 80 ${30 - ((inc.threatGrowth || 0)/2)}`} fill="none" stroke={(inc.threatGrowth || 0) > 20 ? "#ef4444" : "#f59e0b"} strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </div>
                  </div>
                </div>
              ))}
              {!topThreatIncidents.length && <div style={{ color: "#64748b", fontSize: 14 }}>No data available.</div>}
            </div>
          </Card>
        </div>

        {/* Right Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Card title="Quick Actions">
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              {[
                { icon: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>, label: "Report Incident" },
                { icon: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>, label: "View Map" },
                { icon: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>, label: "AI Briefing" },
                { icon: <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>, label: "Generate Report" }
              ].map((a, i) => (
                <button key={i} type="button" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '16px 4px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, gap: 12, cursor: 'pointer' }}>
                  <div style={{ color: '#3b82f6' }}>{a.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', textAlign: 'center' }}>{a.label}</div>
                </button>
              ))}
            </div>
          </Card>

          <Card title={<><svg width="18" height="18" fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/></svg> Severity Distribution</>}>
            <SeverityChart incidents={incidents} />
          </Card>

          <Card title={<><span style={{ color: '#3b82f6', marginRight: 8, fontWeight: 700 }}>AI</span> Situation Briefing</>} extra={<button type="button" style={{ background: '#3b82f6', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg> Generate Brief</button>}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, display: 'flex', gap: 16 }}>
              <div style={{ color: '#3b82f6', flexShrink: 0 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>
              </div>
              <div>
                <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6 }}>
                  {incidents.find(i => i.briefing)?.briefing || "1 high priority incident requires immediate attention in the area. All systems operational. Response units are optimally positioned."}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>Updated 2 minutes ago</div>
          </Card>

          <Card title="Active Alerts" extra={<div style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600, cursor: 'pointer' }}>View All</div>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {incidents.filter(i => i.severity === 'High' || i.severity === 'Critical').slice(0, 3).map((inc) => (
                <div key={inc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }} onClick={() => onIncidentClick(inc)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ color: '#f59e0b' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inc.title}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div style={{ color: sevColor[inc.severity], background: `${sevColor[inc.severity]}1a`, padding: '4px 12px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{inc.severity}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{createdAtLabel(inc.createdAt)}</div>
                  </div>
                </div>
              ))}
              {!incidents.filter(i => i.severity === 'High' || i.severity === 'Critical').length && <div style={{ color: "#64748b", fontSize: 14 }}>No active alerts</div>}
            </div>
          </Card>
        </div>
      </main>

      <footer style={{ padding: '24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 12 }}>
        <div>© 2024 AI Emergency Command Center. All rights reserved.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          v2.4.1 • <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Secure Connection</span>
        </div>
      </footer>

      {/* ── INCIDENT MODAL ── */}
      {modalIncident && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setModalIncidentId(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "grid",
            placeItems: "center",
            background: "rgba(19, 50, 107, 0.22)",
            backdropFilter: "blur(6px)",
            padding: 16,
          }}
        >
          <article
            className="glass-strong"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(700px, 96vw)",
              maxHeight: "88vh",
              overflow: "auto",
              padding: 18,
              display: "grid",
              gap: 12,
              borderRadius: 16,
            }}
          >
            {/* Modal header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <p className="panel-title" style={{ margin: "0 0 2px", fontSize: "0.65rem", letterSpacing: "0.1em" }}>INCIDENT REPORT</p>
                <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#17376f" }}>{modalIncident.title}</h3>
              </div>
              <button type="button" className="btn" onClick={() => setModalIncidentId(null)}
                style={{ ...buttonProportion, minHeight: 32, padding: "0 12px", fontSize: "0.76rem", flexShrink: 0 }}>
                Close
              </button>
            </div>

            {/* Meta row */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: "0.76rem", color: "#7287af" }}>
              <span>ID: <strong style={{ color: "#2d5da4" }}>{modalIncident.id.slice(0, 8).toUpperCase()}</strong></span>
              <span>Status: <strong style={{ color: "#2d5da4" }}>{modalIncident.status}</strong></span>
              <span>Submitted: <strong style={{ color: "#2d5da4" }}>{createdAtLabel(modalIncident.createdAt)}</strong></span>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <SevBadge value={modalIncident.severity} />
              <span style={{ fontSize: "0.76rem", color: "#7287af" }}>
                Location: {modalIncident.location}
              </span>
              <span style={{ fontSize: "0.76rem", color: "#7287af" }}>
                Escalation: <strong style={{ color: "#ff9f3d" }}>{modalIncident.threatGrowth ?? 0}%</strong>
              </span>
            </div>

            {/* Description */}
            <article className="glass" style={{ padding: "10px 12px", borderRadius: 10 }}>
              <p className="panel-title" style={{ margin: "0 0 6px", fontSize: "0.65rem", letterSpacing: "0.08em" }}>DESCRIPTION</p>
              <p style={{ margin: 0, lineHeight: 1.5, fontSize: "0.82rem", color: "#4a6296" }}>{modalIncident.details}</p>
            </article>

            {/* Image Section */}
            {modalIncident.imageUrl && (
              <article className="glass" style={{ padding: "10px 12px", borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <p className="panel-title" style={{ margin: 0, fontSize: "0.65rem", letterSpacing: "0.08em" }}>UPLOADED IMAGE</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => analyzeIncidentImage(modalIncident)}
                    disabled={imageAnalysisLoading}
                    style={{ padding: "4px 8px", fontSize: "0.75rem", minHeight: 24 }}
                  >
                    {imageAnalysisLoading ? "Analyzing..." : "Analyze with Gemini"}
                  </button>
                </div>
                <img
                  src={modalIncident.imageUrl}
                  alt="Incident"
                  style={{
                    width: "100%",
                    maxHeight: 250,
                    borderRadius: 8,
                    objectFit: "cover",
                    marginBottom: 8,
                  }}
                />
              </article>
            )}

            {/* Image Analysis Results */}
            {imageAnalysisResults[modalIncident.id] && (
              <article className="glass" style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(82, 175, 255, 0.05)", border: "1px solid rgba(82, 175, 255, 0.2)" }}>
                <p className="panel-title" style={{ margin: "0 0 8px", fontSize: "0.65rem", letterSpacing: "0.08em", color: "#82afff" }}>GEMINI IMAGE ANALYSIS</p>
                <div style={{ display: "grid", gap: 5, fontSize: "0.78rem", color: "#5f75a4" }}>
                  {[
                    ["Type", imageAnalysisResults[modalIncident.id].incident_type],
                    ["Severity", imageAnalysisResults[modalIncident.id].severity_level],
                    ["Priority", imageAnalysisResults[modalIncident.id].priority_score],
                    ["Triage", imageAnalysisResults[modalIncident.id].triage_category],
                  ].map(([label, val]) => (
                    <div key={label} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8 }}>
                      <span style={{ color: "#7a8eb5", fontSize: "0.72rem" }}>{label}</span>
                      <span style={{ color: "#2e4f8c", lineHeight: 1.4 }}>{val}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid rgba(82, 175, 255, 0.3)" }}>
                    <span style={{ color: "#7a8eb5", fontSize: "0.72rem" }}>Visual Assessment</span>
                    <p style={{ margin: "4px 0 0 0", color: "#2e4f8c", fontSize: "0.76rem", lineHeight: 1.4 }}>
                      {imageAnalysisResults[modalIncident.id].image_analysis}
                    </p>
                  </div>
                </div>
              </article>
            )}

            {/* AI output */}
            <article className="glass" style={{ padding: "10px 12px", borderRadius: 10 }}>
              <p className="panel-title" style={{ margin: "0 0 8px", fontSize: "0.65rem", letterSpacing: "0.08em" }}>AI TACTICAL OUTPUT</p>
              <div style={{ display: "grid", gap: 5, fontSize: "0.78rem", color: "#5f75a4" }}>
                {[
                  ["Priority", modalIncident.priorityScore ?? "—"],
                  ["Threat", modalIncident.threatGrowth != null ? `${modalIncident.threatGrowth}%` : "—"],
                  ["Prediction", modalIncident.prediction || "—"],
                  ["Dispatch", modalIncident.dispatchAction || "—"],
                  ["Reason", modalIncident.dispatchReason || "—"],
                  ["Briefing", modalIncident.briefing || "—"],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8 }}>
                    <span style={{ color: "#7a8eb5", fontSize: "0.72rem" }}>{label}</span>
                    <span style={{ color: "#2e4f8c", lineHeight: 1.4 }}>{val}</span>
                  </div>
                ))}
              </div>
            </article>

            {processingErrors[modalIncident.id] && (
              <p style={{ margin: 0, color: "#d65276", fontSize: "0.78rem" }}>{processingErrors[modalIncident.id]}</p>
            )}

            <button
              type="button"
              className="btn btn-critical"
              onClick={async () => { if (!modalIncident) return; await processIncident(modalIncident); }}
              disabled={processingIncidentId === modalIncident.id}
              style={{ ...buttonProportion, width: "100%", minHeight: 40, fontSize: "0.84rem" }}
            >
              {processingIncidentId === modalIncident.id ? "Processing..." : "Escalate Response Team"}
            </button>
          </article>
        </div>
      )}

      <style jsx>{`
        @media (max-width: 1280px) {
          .visualization-grid {
            grid-template-columns: 1fr !important;
          }
        }

        @media (max-width: 980px) {
          .status-cards-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }

        @media (max-width: 900px) {
          .admin-header {
            flex-direction: column;
            align-items: flex-start !important;
            gap: 10px !important;
          }

          .admin-tabs {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
            padding: 8px;
          }

          .admin-tab-btn {
            width: 100% !important;
          }
        }

        @media (max-width: 640px) {
          .status-cards-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
