"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const highlights = [
  "Live geospatial incident intelligence",
  "AI severity classification and response hints",
  "Unified command channel for responders",
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.detail || "Login failed");
      }

      localStorage.setItem(
        "ecsAuth",
        JSON.stringify({
          accessToken: data.access_token,
          role: data.role,
          name: data.name,
          email: data.email,
          expiresAt: data.expires_at,
          firebaseCustomToken: data.firebase_custom_token,
        })
      );

      if (data.role === "admin") {
        router.push("/admin");
      } else {
        router.push("/dashboard");
      }
    } catch (ex) {
      setError(ex.message || "Unable to authenticate");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main
      className="login-root"
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        background: "#f7fafe",
      }}
    >
      <section
        className="login-brand slide-up"
        style={{
          position: "relative",
          padding: "56px clamp(22px, 5vw, 66px)",
          display: "grid",
          alignItems: "center",
          borderRight: "1px solid #dbe7ff",
          background:
            "radial-gradient(circle at 20% 14%, rgba(78, 150, 255, 0.16), transparent 46%), linear-gradient(150deg, #f8fbff, #eef5ff 68%, #e9f1ff)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(129, 179, 255, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(129, 179, 255, 0.07) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            opacity: 0.5,
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", zIndex: 1, maxWidth: 620, width: "100%" }}>
          <span className="tag">Emergency Access Console</span>
          <h1 className="h1" style={{ marginTop: 18 }}>
            Emergency Command System
          </h1>
          <p className="muted" style={{ marginTop: 14, maxWidth: 540, fontSize: "1.06rem", color: "#4d669a" }}>
            Secure sign-in for responders and command administrators.
          </p>

          <div
            className="glass"
            style={{ marginTop: 34, padding: 22, display: "grid", gap: 16, maxWidth: 500 }}
          >
            <h2 className="h2" style={{ fontSize: "1.25rem" }}>
              Command Highlights
            </h2>
            {highlights.map((item) => (
              <div key={item} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: "#2d79ff",
                  }}
                />
                <span className="muted">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        className="fade-in"
        style={{
          display: "grid",
          placeItems: "center",
          padding: "36px clamp(20px, 4vw, 46px)",
          background:
            "radial-gradient(circle at 78% 20%, rgba(51, 110, 248, 0.12), transparent 42%), linear-gradient(175deg, #f8fbff, #eef4ff)",
        }}
      >
        <form className="glass-strong" style={{ width: "100%", maxWidth: 470, padding: 30 }} onSubmit={onSubmit}>
          <p className="panel-title">Secure Access</p>
          <h2 className="h2" style={{ marginTop: 4 }}>
            Sign In to Command
          </h2>
          <p className="muted" style={{ marginTop: 10 }}>
            Authenticate with backend credentials to continue.
          </p>

          <div style={{ marginTop: 24, display: "grid", gap: 14 }}>
            <label style={{ display: "grid", gap: 8 }}>
              <span className="muted" style={{ fontSize: "0.88rem" }}>
                Work Email
              </span>
              <input
                className="field"
                type="email"
                placeholder="commander@response.ai"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label style={{ display: "grid", gap: 8 }}>
              <span className="muted" style={{ fontSize: "0.88rem" }}>
                Password
              </span>
              <input
                className="field"
                type="password"
                placeholder="Enter secure passcode"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </div>

          {error ? (
            <p style={{ color: "#d84c74", marginTop: 12, marginBottom: 0, fontSize: "0.88rem" }}>{error}</p>
          ) : null}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ marginTop: 22, width: "100%" }}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Authenticating..." : "Enter Mission Console"}
          </button>

          <div className="glass" style={{ marginTop: 14, padding: 12, borderRadius: 12, fontSize: "0.82rem" }}>
            <p className="panel-title" style={{ marginBottom: 6 }}>
              Seeded Credentials
            </p>
            <p className="muted" style={{ margin: "2px 0" }}>
              Admin: admin@ecs.local / Admin@12345
            </p>
            <p className="muted" style={{ margin: "2px 0" }}>
              User: responder@ecs.local / User@12345
            </p>
          </div>
        </form>
      </section>
    </main>
  );
}