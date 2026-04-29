"use client";

import { useEffect, useState, useCallback } from "react";
import { APIProvider, AdvancedMarker, Map as GoogleMap } from "@vis.gl/react-google-maps";

const sevColor = {
  Low: "#10b981",
  Medium: "#f59e0b",
  High: "#ef4444",
  Critical: "#3b82f6",
};

/**
 * MapView — Client-only Google Maps component.
 *
 * This component is dynamically imported with { ssr: false } from the admin page
 * to guarantee it only executes in the browser. This prevents the
 * "Cannot read properties of undefined (reading 'getRootNode')" error
 * that occurs when @vis.gl/react-google-maps internals run during SSR
 * or before the DOM is ready.
 */
export default function MapView({ mapsKey, mapsError, mapMarkers, onIncidentClick }) {
  const [mounted, setMounted] = useState(false);

  // Ensure we only render the map after the component has mounted in the browser
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Guard: don't render anything until client-side mount is confirmed
  if (!mounted) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
        Initializing Map...
      </div>
    );
  }

  // Guard: show error state if map config failed
  if (mapsError) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444", fontSize: 13, padding: 16, textAlign: "center" }}>
        Map unavailable: {mapsError}
      </div>
    );
  }

  // Guard: show loading state while API key is being fetched
  if (!mapsKey) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
        Loading Map...
      </div>
    );
  }

  return (
    <APIProvider apiKey={mapsKey}>
      <GoogleMap
        defaultCenter={{ lat: 12.9716, lng: 77.5946 }}
        defaultZoom={12}
        mapId="DEMO_MAP_ID"
        style={{ width: "100%", height: "100%" }}
        disableDefaultUI={true}
      >
        {/* Cluster markers — only render if the map instance is ready */}
        {mapMarkers?.clusters?.map((cluster) => (
          <AdvancedMarker
            key={cluster.clusterId}
            position={{ lat: cluster.lat, lng: cluster.lng }}
            onClick={() => onIncidentClick?.(cluster.incident)}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: "50%",
                  background: `${sevColor[cluster.severity] || "#64748b"}33`,
                  border: `2px solid ${sevColor[cluster.severity] || "#64748b"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: sevColor[cluster.severity] || "#64748b",
                  fontWeight: 800,
                  fontSize: 13,
                  boxShadow: `0 0 0 6px ${sevColor[cluster.severity] || "#64748b"}22`,
                }}
              >
                {cluster.count}
              </div>
              <div
                style={{
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  color: "#1e293b",
                  fontSize: 11,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  boxShadow: "0 4px 10px rgba(15, 23, 42, 0.12)",
                }}
              >
                Cluster ({cluster.count} incidents)
              </div>
            </div>
          </AdvancedMarker>
        ))}

        {/* Individual markers */}
        {mapMarkers?.individuals?.map((incident) => (
          <AdvancedMarker
            key={incident.id}
            position={{ lat: incident.lat, lng: incident.lng }}
            onClick={() => onIncidentClick?.(incident)}
          >
            <div
              style={{
                width: incident.priorityScore >= 70 ? 30 : 24,
                height: incident.priorityScore >= 70 ? 30 : 24,
                borderRadius: "50%",
                background: `${sevColor[incident.severity] || "#64748b"}44`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow:
                  incident.priorityScore >= 70
                    ? `0 0 0 5px ${sevColor[incident.severity] || "#64748b"}22`
                    : "none",
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: sevColor[incident.severity] || "#64748b",
                  border: "2px solid #fff",
                }}
              />
            </div>
          </AdvancedMarker>
        ))}
      </GoogleMap>
    </APIProvider>
  );
}
