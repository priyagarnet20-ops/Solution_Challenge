"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { getDb, hasFirebaseConfig } from "../../lib/firebase";

function statusClass(status) {
  if (status === "resolved") return "sev-low";
  if (status === "processing") return "sev-high";
  return "sev-medium";
}

function formatTimestamp(value) {
  if (!value) return "Pending timestamp";
  if (typeof value?.toDate === "function") {
    return value.toDate().toLocaleString([], {
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "2-digit",
    });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending timestamp";
  return parsed.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "2-digit",
  });
}

export default function UserDashboardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("report");
  const [incidentText, setIncidentText] = useState("");
  const [isFetchingLocation, setIsFetchingLocation] = useState(false);
  const [location, setLocation] = useState("Location not attached");
  const [locationCoords, setLocationCoords] = useState(null);
  const [history, setHistory] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadedImage, setUploadedImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  function onLogout() {
    localStorage.removeItem("ecsAuth");
    router.replace("/login");
  }

  useEffect(() => {
    const raw = localStorage.getItem("ecsAuth");
    if (!raw) {
      router.replace("/login");
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.role || (parsed.role !== "user" && parsed.role !== "admin")) {
        router.replace("/login");
        return;
      }

      if (!parsed?.email) {
        router.replace("/login");
        return;
      }

      queueMicrotask(() => setCurrentUser(parsed));
    } catch {
      router.replace("/login");
    }
  }, [router]);

  useEffect(() => {
    if (!currentUser?.email) return undefined;

    const db = getDb();

    if (!hasFirebaseConfig() || !db) {
      queueMicrotask(() => setSubmitError("Firebase is not configured in frontend environment variables."));
      return undefined;
    }

    const incidentsQuery = query(
      collection(db, "incidents"),
      where("userId", "==", currentUser.email)
    );

    const unsub = onSnapshot(
      incidentsQuery,
      (snapshot) => {
        const entries = snapshot.docs
          .map((doc) => {
            const data = doc.data();
            return {
              id: doc.id,
              description: String(data.description || "No description"),
              status: String(data.status || "pending"),
              confidenceScore: data.confidence_score ?? null,
              priorityScore: data.priority_score ?? null,
              createdAt: data.createdAt || null,
            };
          })
          .sort((a, b) => {
            const at = typeof a.createdAt?.toMillis === "function" ? a.createdAt.toMillis() : 0;
            const bt = typeof b.createdAt?.toMillis === "function" ? b.createdAt.toMillis() : 0;
            return bt - at;
          });

        setHistory(entries);
      },
      () => {
        setSubmitError("Unable to stream your incidents in real-time.");
      }
    );

    return () => unsub();
  }, [currentUser]);

  const canSubmit = useMemo(
    () => Boolean(locationCoords) && (incidentText.trim().length > 0 || uploadedImage),
    [incidentText, locationCoords, uploadedImage]
  );

  function onFetchLocation() {
    if (!navigator.geolocation) {
      setLocation("Geolocation is not supported in this browser");
      return;
    }

    setIsFetchingLocation(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        setLocationCoords({ lat: latitude, lng: longitude });
        setLocation(
          `${latitude.toFixed(6)}, ${longitude.toFixed(6)} • Accuracy ~${Math.round(accuracy)}m`
        );
        setIsFetchingLocation(false);
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setLocation("Location permission denied. Please allow location access.");
          setLocationCoords(null);
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setLocation("Location unavailable. Try again outdoors or on a stronger network.");
          setLocationCoords(null);
        } else if (error.code === error.TIMEOUT) {
          setLocation("Location request timed out. Please try again.");
          setLocationCoords(null);
        } else {
          setLocation("Unable to fetch your real location.");
          setLocationCoords(null);
        }
        setIsFetchingLocation(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
      }
    );
  }

  async function onImageSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setSubmitError("Please select a valid image file");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setSubmitError("Image file is too large. Maximum size is 5MB.");
      return;
    }

    setUploadedImage(file);
    setSubmitError("");

    // Create preview
    const reader = new FileReader();
    reader.onload = (evt) => {
      setImagePreview(evt.target.result);
    };
    reader.readAsDataURL(file);
  }

  function onClearImage() {
    setUploadedImage(null);
    setImagePreview(null);
  }

  async function onSubmitIncident() {
    if (!canSubmit) return;

    const db = getDb();

    if (!currentUser?.email || !db) {
      setSubmitError("Cannot submit without authenticated user and Firestore connection.");
      return;
    }

    setSubmitError("");
    setIsSubmitting(true);

    try {
      const incidentData = {
        userId: currentUser.email,
        description: incidentText.trim(),
        imageUrl: imagePreview || null,
        lat: locationCoords.lat,
        lng: locationCoords.lng,
        latitude: locationCoords.lat,
        longitude: locationCoords.lng,
        incident_type: null,
        status: "pending",
        severity_level: null,
        priority_score: null,
        confidence_score: null,
        cluster_id: null,
        cluster_size: 1,
        triage_category: null,
        image_analysis: null,
        reason: null,
        prediction: null,
        dispatch_action: null,
        dispatch_reason: null,
        briefing: null,
        createdAt: serverTimestamp(),
        created_at: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      await addDoc(collection(db, "incidents"), incidentData);

      setIncidentText("");
      setUploadedImage(null);
      setImagePreview(null);
    } catch {
      setSubmitError("Failed to submit incident to Firestore.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="app-shell" style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 18 }}>
      <header
        className="glass slide-up"
        style={{
          padding: "16px 24px 0 24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px"
          }}
        >
          <div>
            <p className="panel-title" style={{ marginBottom: 4, fontSize: "0.75rem", fontWeight: 700 }}>
              AI EMERGENCY COMMAND SYSTEM
            </p>
            <h1 className="h2" style={{ fontSize: "1.5rem", fontWeight: 700, color: "#112d66", margin: 0 }}>
              Rapid Incident Reporting Console
            </h1>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              className="tag"
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 999,
                padding: "6px 12px",
                background: "#ffffff",
                border: "1px solid #dfe9ff",
                color: "#112d66",
              }}
            >
              RESPONDER, FIELD UNIT 01
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#23ba86" }} />
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onLogout}
              style={{ padding: "8px 16px", fontSize: "0.875rem", fontWeight: 600, borderRadius: 8 }}
            >
              Logout
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            width: "100%",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab("report")}
            className={activeTab === "report" ? "btn btn-primary" : "btn"}
            style={{
              padding: "8px 20px",
              fontSize: "0.875rem",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderRadius: "8px",
              ...(activeTab !== "report" ? {
                border: "1px solid #dfe9ff",
                background: "#ffffff",
                color: "#2f4f87",
              } : {})
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Report Incident
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={activeTab === "history" ? "btn btn-primary" : "btn"}
            style={{
              padding: "8px 20px",
              fontSize: "0.875rem",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderRadius: "8px",
              ...(activeTab !== "history" ? {
                border: "1px solid #dfe9ff",
                background: "#ffffff",
                color: "#2f4f87",
              } : {})
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            History
          </button>
        </div>
      </header>

      <section
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "stretch",
          padding: "48px 12vw",
          flexGrow: 1,
        }}
      >
        {activeTab === "report" && (
          <article className="glass-strong slide-up" style={{ padding: 32, animationDelay: "90ms", display: "flex", flexDirection: "column", width: "100%" }}>
            <p className="panel-title" style={{ marginBottom: 6, fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase" }}>CREATE INCIDENT REPORT</p>
            <h2 style={{ marginBottom: 6, color: "#112d66", fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
              Describe emergency details
            </h2>
            <p className="muted" style={{ marginTop: 6, marginBottom: 16, fontSize: "0.875rem" }}>
              Provide accurate information to help responders assess and act quickly.
            </p>

            <div style={{ position: "relative", flexGrow: 1, display: "flex", flexDirection: "column" }}>
              <textarea
                className="field"
                value={incidentText}
                onChange={(e) => setIncidentText(e.target.value)}
                placeholder="Describe what happened, nearby landmarks, people involved, and immediate risks..."
                maxLength={1000}
                style={{ resize: "none", flexGrow: 1, paddingBottom: 24, fontSize: "0.875rem", border: "1px solid #d6e3ff", borderRadius: 12, padding: "16px 16px 28px 16px" }}
              />
              <span
                style={{
                  position: "absolute",
                  bottom: 8,
                  right: 12,
                  fontSize: "0.75rem",
                  color: "#8193b8",
                }}
              >
                {incidentText.length}/1000
              </span>
            </div>

            <div
              style={{
                marginTop: 20,
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(120px, 1fr))",
                gap: 12,
              }}
            >
              <label
                className="btn"
                style={{ textAlign: "center", cursor: "pointer", minHeight: 72, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: "8px" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a72ef" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  <strong style={{ fontSize: "0.875rem" }}>{uploadedImage ? "Image Ready" : "Upload Image"}</strong>
                </div>
                <span className="muted" style={{ fontSize: "0.7rem" }}>JPG, PNG up to 10MB</span>
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={onImageSelected}
                />
              </label>

              <button
                type="button"
                className="btn"
                aria-label="Voice input placeholder"
                style={{ minHeight: 72, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: "8px" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a72ef" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                  <strong style={{ fontSize: "0.875rem" }}>Voice Input (Soon)</strong>
                </div>
                <span className="muted" style={{ fontSize: "0.7rem" }}>Speak to describe incident</span>
              </button>

              <button
                type="button"
                className="btn btn-primary"
                onClick={onFetchLocation}
                disabled={isFetchingLocation}
                style={{ minHeight: 72, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: "8px" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                  <strong style={{ fontSize: "0.875rem", color: "#fff" }}>{isFetchingLocation ? "Locating..." : "Fetch My Location"}</strong>
                </div>
                <span style={{ fontSize: "0.7rem", opacity: 0.9, color: "#fff" }}>Use current GPS location</span>
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #d6e3ff",
                background: "#f9fbff",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a72ef" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
              <span className="muted" style={{ fontSize: "0.875rem" }}>{location}</span>
            </div>

            {imagePreview && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid #d6e3ff",
                  background: "#f9fbff",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span className="panel-title" style={{ margin: 0 }}>Image Preview</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={onClearImage}
                    style={{ padding: "5px 9px", fontSize: "0.82rem" }}
                  >
                    Remove
                  </button>
                </div>

                <img
                  src={imagePreview}
                  alt="Incident"
                  style={{
                    width: "100%",
                    maxHeight: 320,
                    borderRadius: 10,
                    objectFit: "contain",
                    border: "1px solid #d6e3ff",
                    backgroundColor: "#ffffff",
                  }}
                />
              </div>
            )}

            <div style={{ marginTop: "auto" }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: "100%", padding: "12px 16px", fontSize: "0.95rem", display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}
                onClick={onSubmitIncident}
                disabled={!canSubmit || isSubmitting}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                {isSubmitting ? "Submitting..." : "Submit Emergency Report"}
              </button>

              {submitError ? (
                <p style={{ color: "#d84c74", marginTop: 10, marginBottom: 0, fontSize: "0.9rem", textAlign: "center" }}>
                  {submitError}
                </p>
              ) : null}
            </div>
          </article>
        )}

        {activeTab === "history" && (
          <aside className="glass fade-in" style={{ padding: 32, display: "flex", flexDirection: "column", width: "100%" }}>
            <p className="panel-title" style={{ marginBottom: 12, fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase" }}>RECENT REPORTS</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flexGrow: 1 }}>
              {!history.length ? (
                <article
                  style={{
                    border: "1px solid #d6e3ff",
                    borderRadius: 8,
                    padding: "12px 14px",
                    background: "#ffffff",
                  }}
                >
                  <strong style={{ fontSize: "0.875rem", color: "#1f356b" }}>No recent reports</strong>
                  <p className="muted" style={{ marginBottom: 0, fontSize: "0.75rem", marginTop: 4 }}>Submit an incident to start your timeline.</p>
                </article>
              ) : null}

              {history.slice(0, 8).map((entry) => (
                <article
                  key={entry.id}
                  style={{
                    border: "1px solid #d6e3ff",
                    borderRadius: 8,
                    padding: "12px 14px",
                    background: "#ffffff",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong
                      style={{
                        fontSize: "0.875rem",
                        color: "#1f356b",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.description || "No description"}
                    </strong>
                    <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.75rem", color: "#112d66", fontWeight: 600, textTransform: "capitalize" }}>
                      <span className={`severity-dot ${statusClass(entry.status)}`} />
                      {entry.status}
                    </span>
                  </div>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>{formatTimestamp(entry.createdAt)}</span>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: "0.72rem", color: "#5d74a6" }}>
                    <span>Confidence: <strong style={{ color: "#1f356b" }}>{entry.confidenceScore != null ? `${entry.confidenceScore}%` : "Pending"}</strong></span>
                    <span>Priority: <strong style={{ color: "#1f356b" }}>{entry.priorityScore ?? "Pending"}</strong></span>
                  </div>
                </article>
              ))}

              <button type="button" className="btn" style={{ minHeight: 40, marginTop: "auto", padding: "8px 16px", display: "flex", justifyContent: "center", alignItems: "center", gap: 8, fontSize: "0.875rem" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2a72ef" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><polyline points="12 7 12 12 15 15"></polyline></svg>
                View All History
              </button>
            </div>
          </aside>
        )}
      </section>

      <style jsx>{`
        @media (max-width: 760px) {
          header > div:first-child {
            align-items: flex-start !important;
          }

          header > div:last-child {
            justify-content: flex-start !important;
            flex-wrap: wrap;
          }

          header > div:last-child button {
            width: 100% !important;
          }

          div[style*="repeat(3"] {
            grid-template-columns: 1fr !important;
          }

          h1 {
            font-size: 2rem !important;
          }
        }
      `}</style>
    </main>
  );
}
