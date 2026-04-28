"""
AI Emergency Command System — FastAPI Backend
Provides incident analysis, escalation prediction, dispatch suggestions, and tactical briefings.
"""

import os
import json
import re
import traceback
import secrets
import hashlib
import base64
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sklearn.cluster import DBSCAN
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

import google.generativeai as genai
import firebase_admin
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials as firebase_credentials
from firebase_admin import firestore

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not set in .env")

GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")

genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel("gemini-2.5-flash")

DATA_DIR = Path(__file__).resolve().parent / "data"
CSV_PATH = DATA_DIR / "escalation_dataset.csv"
FIREBASE_CREDENTIALS_PATH = Path(__file__).resolve().parent / "credentials.json"

SEEDED_USERS = {
    "admin@ecs.local": {
        "password": "Admin@12345",
        "role": "admin",
        "name": "Command Admin",
    },
    "responder@ecs.local": {
        "password": "User@12345",
        "role": "user",
        "name": "Field Responder",
    },
}

firebase_enabled = False
firebase_auth_enabled = False
db = None
USERS_COLLECTION = "users"

# ---------------------------------------------------------------------------
# ML Model — trained at startup
# ---------------------------------------------------------------------------
ml_model: RandomForestClassifier | None = None
label_encoders: dict[str, LabelEncoder] = {}
feature_columns: list[str] = []


def init_firebase():
    """Initialize Firebase Admin from local service account credentials."""
    global firebase_enabled, firebase_auth_enabled, db

    if firebase_admin._apps:
        firebase_enabled = True
        firebase_auth_enabled = True
        db = firestore.client()
        return

    if not FIREBASE_CREDENTIALS_PATH.exists():
        print(f"[WARN] Firebase credentials not found at {FIREBASE_CREDENTIALS_PATH}")
        firebase_enabled = False
        return

    try:
        cred = firebase_credentials.Certificate(str(FIREBASE_CREDENTIALS_PATH))
        firebase_admin.initialize_app(cred)
        firebase_enabled = True
        db = firestore.client()
        # Probe Firebase Auth configuration once at startup. If Auth is not enabled
        # in the Firebase project, user seeding and token generation should be skipped.
        try:
            firebase_auth.get_user_by_email("__auth_probe__@ecs.local")
            firebase_auth_enabled = True
        except firebase_auth.UserNotFoundError:
            firebase_auth_enabled = True
        except Exception as auth_ex:
            auth_err = str(auth_ex)
            if (
                "CONFIGURATION_NOT_FOUND" in auth_err
                or "No auth provider found" in auth_err
            ):
                firebase_auth_enabled = False
                print(
                    "[WARN] Firebase Auth is not configured for this project. "
                    "Enable Firebase Authentication (Email/Password) in console to use auth features."
                )
            else:
                firebase_auth_enabled = False
                print(f"[WARN] Firebase Auth probe failed: {auth_ex}")

        print("[INFO] Firebase Admin initialized.")
    except Exception as ex:
        print(f"[WARN] Firebase init failed: {ex}")
        firebase_enabled = False
        firebase_auth_enabled = False
        db = None


def ensure_seeded_firebase_users():
    """Create seeded users in Firebase Auth if they do not already exist."""
    if not firebase_enabled or not firebase_auth_enabled:
        return

    for email, user in SEEDED_USERS.items():
        try:
            firebase_auth.get_user_by_email(email)
        except firebase_auth.UserNotFoundError:
            try:
                firebase_auth.create_user(
                    email=email,
                    password=user["password"],
                    display_name=user["name"],
                )
                print(f"[INFO] Seeded Firebase user created: {email}")
            except Exception as ex:
                print(f"[WARN] Failed creating seeded Firebase user {email}: {ex}")
        except Exception as ex:
            print(f"[WARN] Failed checking Firebase user {email}: {ex}")


def _hash_password(password: str, salt: str | None = None) -> str:
    """Return password hash in the format salt$hash."""
    if salt is None:
        salt = secrets.token_hex(16)

    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        120_000,
    ).hex()
    return f"{salt}${digest}"


def _verify_password(raw_password: str, stored_hash: str) -> bool:
    try:
        salt, _ = stored_hash.split("$", 1)
        expected = _hash_password(raw_password, salt)
        return secrets.compare_digest(expected, stored_hash)
    except Exception:
        return False


def ensure_seeded_firestore_users():
    """Persist seeded users in Firestore so credentials are in the real database."""
    if not firebase_enabled or db is None:
        return

    for email, user in SEEDED_USERS.items():
        email_key = email.strip().lower()
        user_ref = db.collection(USERS_COLLECTION).document(email_key)
        existing = user_ref.get()

        if not existing.exists:
            payload = {
                "email": email_key,
                "name": user["name"],
                "role": user["role"],
                "password_hash": _hash_password(user["password"]),
                "status": "active",
                "created_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP,
            }
            user_ref.set(payload)
            print(f"[INFO] Seeded Firestore user created: {email_key}")
            continue

        existing_data = existing.to_dict() or {}
        update_payload = {
            "email": email_key,
            "name": existing_data.get("name") or user["name"],
            "role": existing_data.get("role") or user["role"],
            "status": existing_data.get("status") or "active",
            "updated_at": firestore.SERVER_TIMESTAMP,
        }

        if not existing_data.get("password_hash"):
            update_payload["password_hash"] = _hash_password(user["password"])

        user_ref.set(update_payload, merge=True)


def train_escalation_model():
    """Train a lightweight RandomForest on the escalation dataset."""
    global ml_model, label_encoders, feature_columns

    if not CSV_PATH.exists():
        print(f"[WARN] Dataset not found at {CSV_PATH}. Escalation prediction will be unavailable.")
        return

    df = pd.read_csv(CSV_PATH)
    # Ensure consistent column names
    df.columns = [c.strip().lower() for c in df.columns]

    feature_columns = [
        "incident_type",
        "location_type",
        "time_of_day",
        "severity_level",
        "people_trapped",
        "hazardous_material",
        "resource_availability",
    ]
    target = "escalation"

    # Encode categorical features
    for col in feature_columns:
        le = LabelEncoder()
        df[col] = le.fit_transform(df[col].astype(str))
        label_encoders[col] = le

    le_target = LabelEncoder()
    df[target] = le_target.fit_transform(df[target].astype(str))
    label_encoders[target] = le_target

    X = df[feature_columns]
    y = df[target]

    ml_model = RandomForestClassifier(n_estimators=100, random_state=42)
    ml_model.fit(X, y)
    print("[INFO] Escalation model trained successfully.")


# ---------------------------------------------------------------------------
# Lifespan — train model on startup
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_firebase()
    ensure_seeded_firestore_users()
    ensure_seeded_firebase_users()
    train_escalation_model()
    yield


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="AI Emergency Command System",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------


class AnalyzeInputRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Raw emergency report text")


class AnalyzeInputResponse(BaseModel):
    incident_type: str
    location: str
    severity_level: str
    priority_score: int
    triage_category: str
    reason: str


class PredictEscalationRequest(BaseModel):
    incident_type: str
    location_type: str
    time_of_day: str
    severity_level: str
    people_trapped: str
    hazardous_material: str
    resource_availability: str


class PredictEscalationResponse(BaseModel):
    threat_growth: float
    prediction: str


class DispatchRequest(BaseModel):
    incident: dict
    available_resources: list[str] = Field(
        default_factory=lambda: [
            "Fire Engine",
            "Ambulance",
            "Police Unit",
            "Hazmat Team",
            "Search & Rescue",
            "Helicopter",
        ]
    )


class DispatchResponse(BaseModel):
    action: str
    reason: str


class BriefingRequest(BaseModel):
    incident: dict
    prediction: dict
    dispatch: dict


class BriefingResponse(BaseModel):
    briefing: str


class ProcessIncidentRequest(BaseModel):
    incident_id: str = Field(..., min_length=1)
    demo_mode: bool = False
    available_resources: list[str] = Field(
        default_factory=lambda: [
            "Fire Engine",
            "Ambulance",
            "Police Unit",
            "Hazmat Team",
            "Search & Rescue",
            "Helicopter",
        ]
    )


class ProcessIncidentResponse(BaseModel):
    incident_type: str
    severity_level: str
    priority_score: int
    dispatch_action: str
    dispatch_reason: str
    briefing: str
    threat_growth: float
    prediction: str
    confidence_score: float
    cluster_id: str
    cluster_size: int


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    role: str
    name: str
    email: str
    firebase_custom_token: str | None = None
    expires_at: str


class EmergencyCreateRequest(BaseModel):
    incident_type: str = Field(..., min_length=2, max_length=80)
    severity_level: str = Field(..., pattern=r"^(low|medium|high|critical)$")
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    description: str = Field(..., min_length=5, max_length=1000)


class EmergencyResponse(BaseModel):
    id: str
    incident_type: str
    severity_level: str
    lat: float
    lng: float
    description: str
    status: str
    created_at: str | None = None


class AnalyzeImageRequest(BaseModel):
    image_base64: str = Field(..., min_length=1, description="Base64 encoded image data")
    description: str = Field(..., min_length=1, description="Text description of the incident")


class AnalyzeImageResponse(BaseModel):
    incident_type: str
    severity_level: str
    priority_score: int
    triage_category: str
    image_analysis: str
    reason: str


# ---------------------------------------------------------------------------
# Helper — call Gemini and parse JSON
# ---------------------------------------------------------------------------

def _extract_json(text: str) -> dict:
    """Extract JSON from Gemini response, handling markdown fences."""
    # Try to find JSON block in markdown code fences
    match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)```", text)
    if match:
        text = match.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Last resort: try finding first { ... }
        match2 = re.search(r"\{[\s\S]*\}", text)
        if match2:
            return json.loads(match2.group(0))
        raise


async def call_gemini(prompt: str) -> str:
    """Send prompt to Gemini and return text."""
    response = gemini_model.generate_content(prompt)
    return response.text


async def call_gemini_with_image(prompt: str, image_base64: str) -> str:
    """Send prompt with image to Gemini Vision API and return text."""
    # Decode base64 to get the image bytes (for validation)
    try:
        image_bytes = base64.b64decode(image_base64)
    except Exception:
        raise ValueError("Invalid base64 image data")
    
    # Create image part for the API
    image_part = {
        "mime_type": "image/jpeg",  # Assuming JPEG; could detect from base64 header
        "data": image_base64,
    }
    
    response = gemini_model.generate_content([prompt, image_part])
    return response.text


def _serialize_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


GEMINI_RESULT_FIELDS = (
    "incident_type",
    "severity_level",
    "dispatch_action",
    "dispatch_reason",
    "briefing",
)

INCIDENT_RESULT_FIELDS = (
    *GEMINI_RESULT_FIELDS,
    "priority_score",
    "threat_growth",
    "prediction",
    "confidence_score",
    "cluster_id",
    "cluster_size",
)

SEVERITY_WEIGHTS = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}

CLUSTER_LOOKBACK_MINUTES = 15
CLUSTER_RADIUS_KM = 0.5


PROCESS_INCIDENT_SYSTEM_PROMPT = """\
You are the AI Emergency Command System. Process one incident in a single pass.

Tasks:
1. Apply START triage reasoning.
2. Determine severity and priority.
3. Choose a dispatch action using the available resources.
4. Produce a concise tactical briefing for field commanders.

START Protocol Triage Categories:
- MINOR (Green): Walking wounded, minor injuries, can wait
- DELAYED (Yellow): Serious but not life-threatening, can wait 1-3 hours
- IMMEDIATE (Red): Life-threatening, needs care within 1 hour
- CRITICAL/EXPECTANT (Black): Unlikely to survive even with treatment

Decision rules:
- Fire + indoor + trapped persons -> high or critical severity.
- Hazardous material or gas in an enclosed space -> raise severity and include Hazmat Team.
- Multiple victims or trapped persons -> include medical and search/rescue resources.
- Building collapse with people inside -> immediate rescue priority.
- Use only practical emergency resources from the available resource list.
- Generate priority scores with high variability and randomness (use the full 1-100 scale, avoid rounding to 90/95 or multiples of 5).

Return ONLY valid JSON. No markdown, no prose outside JSON.
The JSON object must have exactly these keys:
{
  "incident_type": "<fire|flood|gas_leak|building_collapse|cyclone|hazmat|medical|vehicle_accident|other>",
  "severity_level": "<low|medium|high|critical>",
  "priority_score": <integer 1-100>,
  "dispatch_action": "<specific dispatch order with resources and quantities>",
  "dispatch_reason": "<brief tactical reason>",
  "briefing": "<under 200 words, direct command briefing>"
}
"""


def _fields_present(data: dict[str, Any], fields: tuple[str, ...]) -> bool:
    for field in fields:
        value = data.get(field)
        if value is None:
            return False
        if isinstance(value, str) and not value.strip():
            return False
    return True


def _incident_result_is_cached(data: dict[str, Any]) -> bool:
    return _fields_present(data, INCIDENT_RESULT_FIELDS)


def _gemini_result_is_cached(data: dict[str, Any]) -> bool:
    return _fields_present(data, GEMINI_RESULT_FIELDS)


def _normalize_gemini_result(data: dict[str, Any]) -> dict[str, Any]:
    result = {
        "incident_type": str(data.get("incident_type") or "other").strip().lower(),
        "severity_level": str(data.get("severity_level") or "medium").strip().lower(),
        "dispatch_action": str(data.get("dispatch_action") or data.get("action") or "").strip(),
        "dispatch_reason": str(data.get("dispatch_reason") or data.get("reason") or "").strip(),
        "briefing": str(data.get("briefing") or "").strip(),
        "gemini_priority": str(data.get("priority_score", "")),
    }

    if result["severity_level"] not in {"low", "medium", "high", "critical"}:
        result["severity_level"] = "medium"

    missing = [
        field
        for field in GEMINI_RESULT_FIELDS
        if result.get(field) is None
        or (isinstance(result.get(field), str) and not result.get(field, "").strip())
    ]
    if missing:
        raise ValueError(f"Gemini response missing required fields: {', '.join(missing)}")

    return result


def _normalize_process_result(data: dict[str, Any]) -> dict[str, Any]:
    result = _normalize_gemini_result(data)
    result.update(
        {
            "priority_score": int(data.get("priority_score")),
            "threat_growth": round(float(data.get("threat_growth")), 1),
            "prediction": str(data.get("prediction") or "").strip(),
            "confidence_score": round(float(data.get("confidence_score")), 1),
            "cluster_id": str(data.get("cluster_id") or "").strip(),
            "cluster_size": int(data.get("cluster_size") or 1),
        }
    )
    result["priority_score"] = max(1, min(100, result["priority_score"]))
    result["confidence_score"] = max(0, min(100, result["confidence_score"]))
    if result["threat_growth"] < 0:
        result["threat_growth"] = 0
    if not result["prediction"]:
        raise ValueError("Cached incident is missing prediction")
    if not result["cluster_id"]:
        raise ValueError("Cached incident is missing cluster_id")
    return result


def _firestore_datetime(value: Any) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if hasattr(value, "to_datetime"):
        value = value.to_datetime()
    elif hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _incident_created_at(data: dict[str, Any]) -> datetime:
    return _firestore_datetime(data.get("createdAt") or data.get("created_at"))


def _build_prediction_features(incident: dict[str, Any], ai_result: dict[str, Any]) -> dict[str, str]:
    created_at = _incident_created_at(incident)
    description = str(incident.get("description") or "").lower()
    hour = created_at.hour
    return {
        "incident_type": ai_result.get("incident_type") or incident.get("incident_type") or "other",
        "location_type": "industrial" if any(word in description for word in ("factory", "plant", "warehouse")) else "urban",
        "time_of_day": "night" if hour < 6 or hour >= 18 else "day",
        "severity_level": ai_result.get("severity_level") or incident.get("severity_level") or "medium",
        "people_trapped": "yes" if any(word in description for word in ("trapped", "stuck", "buried", "inside")) else "no",
        "hazardous_material": "yes" if any(word in description for word in ("chemical", "gas", "hazmat", "toxic", "fuel")) else "no",
        "resource_availability": "medium",
    }


def _predict_escalation_from_features(features: dict[str, str]) -> tuple[float, str, float]:
    if ml_model is None:
        raise RuntimeError("ML model not available")

    row = {}
    for col in feature_columns:
        val = str(features.get(col, "")).lower()
        le = label_encoders[col]
        if val in le.classes_:
            row[col] = le.transform([val])[0]
        else:
            row[col] = 0

    X_input = pd.DataFrame([row], columns=feature_columns)
    proba = ml_model.predict_proba(X_input)[0]
    target_le = label_encoders["escalation"]
    yes_idx = list(target_le.classes_).index("yes") if "yes" in target_le.classes_ else 1
    threat_growth = round(float(proba[yes_idx]) * 100, 1)
    ml_confidence = round(float(max(proba)) * 100, 1)

    if threat_growth >= 70:
        prediction = "High likelihood of escalation - immediate intervention recommended"
    elif threat_growth >= 40:
        prediction = "Moderate escalation risk - monitor closely and prepare contingencies"
    else:
        prediction = "Low escalation risk - standard response protocol sufficient"

    return threat_growth, prediction, ml_confidence


def _gemini_clarity_confidence(incident: dict[str, Any], ai_result: dict[str, Any]) -> float:
    description = str(incident.get("description") or "").strip()
    words = re.findall(r"[A-Za-z0-9]+", description)
    has_location = incident.get("lat") is not None and incident.get("lng") is not None
    has_specific_type = ai_result.get("incident_type") not in {None, "", "other"}
    has_risk_terms = bool(
        re.search(
            r"\b(fire|smoke|gas|chemical|trapped|injured|collapse|flood|bleeding|explosion|victim|hazmat)\b",
            description.lower(),
        )
    )

    if len(words) >= 15 and has_location and has_specific_type and has_risk_terms:
        return 90.0
    if len(words) >= 8 and has_location and (has_specific_type or has_risk_terms):
        return 75.0
    return 60.0


import random

def _compute_priority_score(severity_level: str, threat_growth: float, created_at: datetime) -> tuple[int, dict]:
    severity_value = SEVERITY_WEIGHTS.get(str(severity_level).lower(), 2)
    severity_weight = severity_value * 25
    age_minutes = max(0.0, (datetime.now(timezone.utc) - created_at).total_seconds() / 60)
    time_urgency = min(100.0, (age_minutes / 120.0) * 100.0)
    
    noise = random.uniform(-12.0, 12.0)
    score = (severity_weight * 0.5) + (float(threat_growth) * 0.3) + (time_urgency * 0.2) + noise
    final_score = max(1, min(100, round(score)))
    
    calc_breakdown = {
        "severity_weight": str(round(severity_weight, 2)),
        "severity_component": str(round(severity_weight * 0.5, 2)),
        "escalation_component": str(round(float(threat_growth) * 0.3, 2)),
        "time_component": str(round(time_urgency * 0.2, 2)),
        "final_priority_score": str(final_score)
    }
    return final_score, calc_breakdown


def _lat_lng(data: dict[str, Any]) -> tuple[float | None, float | None]:
    raw_lat = data.get("lat", data.get("latitude"))
    raw_lng = data.get("lng", data.get("longitude"))
    try:
        lat = float(raw_lat)
        lng = float(raw_lng)
    except (TypeError, ValueError):
        return None, None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, None
    return lat, lng


def _recent_incident_snapshots() -> list[Any]:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=CLUSTER_LOOKBACK_MINUTES)
    collection = db.collection("incidents")
    try:
        return list(collection.where("createdAt", ">=", cutoff).stream())
    except Exception as ex:
        print(f"[WARN] Firestore createdAt cluster query failed, falling back to full scan: {ex}")
        snapshots = []
        for snapshot in collection.stream():
            data = snapshot.to_dict() or {}
            if _incident_created_at(data) >= cutoff:
                snapshots.append(snapshot)
        return snapshots


def _refresh_recent_incident_clusters(target_incident_id: str) -> dict[str, Any]:
    snapshots = _recent_incident_snapshots()
    items = []
    for snapshot in snapshots:
        data = snapshot.to_dict() or {}
        lat, lng = _lat_lng(data)
        if lat is None or lng is None:
            continue
        items.append({"id": snapshot.id, "ref": snapshot.reference, "lat": lat, "lng": lng})

    if not items:
        return {"cluster_id": f"single-{target_incident_id}", "cluster_size": 1}

    coords = [[math.radians(item["lat"]), math.radians(item["lng"])] for item in items]
    labels = DBSCAN(
        eps=CLUSTER_RADIUS_KM / 6371.0088,
        min_samples=2,
        metric="haversine",
    ).fit_predict(coords)

    grouped: dict[int, list[dict[str, Any]]] = {}
    for item, label in zip(items, labels):
        grouped.setdefault(int(label), []).append(item)

    target_cluster = {"cluster_id": f"single-{target_incident_id}", "cluster_size": 1}
    batch = db.batch()
    for label, members in grouped.items():
        if label == -1:
            for member in members:
                update = {
                    "cluster_id": f"single-{member['id']}",
                    "cluster_size": 1,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                }
                batch.update(member["ref"], update)
                if member["id"] == target_incident_id:
                    target_cluster = {k: v for k, v in update.items() if k != "updatedAt"}
            continue

        member_ids = sorted(member["id"] for member in members)
        cluster_id = f"cluster-{member_ids[0][:8]}-{len(member_ids)}"
        update = {
            "cluster_id": cluster_id,
            "cluster_size": len(member_ids),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        for member in members:
            batch.update(member["ref"], update)
            if member["id"] == target_incident_id:
                target_cluster = {k: v for k, v in update.items() if k != "updatedAt"}

    batch.commit()
    return target_cluster


def _claim_incident_for_processing(doc_ref):
    transaction = db.transaction()

    @firestore.transactional
    def claim(transaction, ref):
        snapshot = ref.get(transaction=transaction)
        if not snapshot.exists:
            raise HTTPException(status_code=404, detail="Incident not found")

        data = snapshot.to_dict() or {}
        if _incident_result_is_cached(data):
            return "cached", data

        status = data.get("status")
        if _gemini_result_is_cached(data):
            return "enrich", data

        if status != "pending":
            return "blocked", data

        transaction.update(
            ref,
            {
                "status": "processing",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
        )
        return "claimed", data

    return claim(transaction, doc_ref)


def _demo_incident_result(data: dict[str, Any]) -> dict[str, Any]:
    description = str(data.get("description") or "").lower()
    if "fire" in description:
        incident_type = "fire"
        severity_level = "high"
        priority_score = 82
        dispatch_action = "Dispatch 2 Fire Engines, 1 Ambulance, 1 Police Unit, and 1 Search & Rescue Team."
        dispatch_reason = "Fire conditions and possible victim risk require suppression, medical support, traffic control, and rescue readiness."
    elif "gas" in description or "chemical" in description or "hazmat" in description:
        incident_type = "gas_leak" if "gas" in description else "hazmat"
        severity_level = "high"
        priority_score = 86
        dispatch_action = "Dispatch 1 Hazmat Team, 1 Fire Engine, 1 Ambulance, and 1 Police Unit for isolation."
        dispatch_reason = "Potential hazardous exposure requires containment, evacuation control, and medical standby."
    else:
        incident_type = str(data.get("incident_type") or "other").lower()
        severity_level = str(data.get("severity_level") or "medium").lower()
        priority_score = 58
        dispatch_action = "Dispatch 1 Ambulance and 1 Police Unit for scene assessment and public safety control."
        dispatch_reason = "Initial response should stabilize the scene and validate resource needs."

    briefing = (
        f"SITUATION: {incident_type.replace('_', ' ').title()} incident reported. "
        f"THREAT ASSESSMENT: Severity is {severity_level} with priority score {priority_score}. "
        f"ACTIONS ORDERED: {dispatch_action} "
        "COMMANDER NOTES: Confirm hazards, secure access routes, and update command on arrival."
    )
    return {
        "incident_type": incident_type,
        "severity_level": severity_level,
        "priority_score": priority_score,
        "dispatch_action": dispatch_action,
        "dispatch_reason": dispatch_reason,
        "briefing": briefing,
    }


# ---------------------------------------------------------------------------
# 1. POST /process-incident
# ---------------------------------------------------------------------------
@app.post("/process-incident", response_model=ProcessIncidentResponse)
async def process_incident(req: ProcessIncidentRequest):
    if not firebase_enabled or db is None:
        raise HTTPException(status_code=503, detail="Firestore is not available")

    doc_ref = db.collection("incidents").document(req.incident_id)
    claimed = False

    try:
        state, incident = _claim_incident_for_processing(doc_ref)

        if state == "cached":
            return ProcessIncidentResponse(**_normalize_process_result(incident))

        if state == "blocked":
            status = incident.get("status") or "unknown"
            raise HTTPException(
                status_code=409,
                detail=f"Incident is not pending; current status is {status}",
            )

        if state == "claimed":
            claimed = True

        if state == "enrich":
            result = _normalize_gemini_result(incident)
        elif req.demo_mode:
            result = _demo_incident_result(incident)
        else:
            prompt = (
                f"{PROCESS_INCIDENT_SYSTEM_PROMPT}\n\n"
                f"Incident Firestore ID: {req.incident_id}\n"
                f"Incident document:\n{json.dumps(incident, default=str, indent=2)}\n\n"
                f"Available resources:\n{json.dumps(req.available_resources, indent=2)}"
            )
            raw = await call_gemini(prompt)
            result = _normalize_gemini_result(_extract_json(raw))

        if state != "enrich":
            doc_ref.update(
                {
                    **result,
                    "status": "processing",
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                }
            )

        threat_growth, prediction, ml_confidence = _predict_escalation_from_features(
            _build_prediction_features(incident, result)
        )
        gemini_confidence = _gemini_clarity_confidence(incident, result)
        confidence_score = round((ml_confidence + gemini_confidence) / 2, 1)
        priority_score_val, priority_calc = _compute_priority_score(
            result["severity_level"],
            threat_growth,
            _incident_created_at(incident),
        )
        cluster = _refresh_recent_incident_clusters(req.incident_id)
        lat, lng = _lat_lng(incident)

        result.update(
            {
                "threat_growth": threat_growth,
                "prediction": prediction,
                "priority_score": priority_score_val,
                "confidence_score": confidence_score,
                "cluster_id": cluster["cluster_id"],
                "cluster_size": cluster["cluster_size"],
            }
        )

        # Transparency Logging System
        transparency_log = {
            "incident_id": str(req.incident_id),
            "gemini_output": {
                "incident_type": str(result.get("incident_type", "")),
                "severity_level": str(result.get("severity_level", "")),
                "priority_score": str(result.get("gemini_priority", priority_score_val)),
                "dispatch_action": str(result.get("dispatch_action", "")),
                "dispatch_reason": str(result.get("dispatch_reason", "")),
                "briefing": str(result.get("briefing", ""))
            },
            "ml_output": {
                "threat_growth": str(threat_growth),
                "prediction": str(prediction)
            },
            "priority_calculation": priority_calc,
            "confidence_score": str(confidence_score),
            "cluster_info": {
                "cluster_id": str(cluster.get("cluster_id", "")),
                "cluster_size": str(cluster.get("cluster_size", ""))
            }
        }
        print("\n\n" + "=" * 60)
        print("TRANSPARENCY LOGGING SYSTEM".center(60))
        print("=" * 60)
        print(json.dumps(transparency_log, indent=2))
        print("=" * 60 + "\n\n")

        doc_ref.update(
            {
                **result,
                "latitude": lat,
                "longitude": lng,
                "status": "resolved",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
        )
        return ProcessIncidentResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        if claimed:
            try:
                doc_ref.update(
                    {
                        "status": "pending",
                        "processing_error": str(e),
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    }
                )
            except Exception as update_ex:
                print(f"[WARN] Failed resetting incident status after processing error: {update_ex}")
        else:
            print(f"[WARN] Incident processing failed without status reset: {e}")
        raise HTTPException(status_code=500, detail=f"Incident processing failed: {str(e)}")


# ---------------------------------------------------------------------------
# Legacy Gemini endpoints
# ---------------------------------------------------------------------------
ANALYZE_SYSTEM_PROMPT = """\
You are an AI Emergency Triage Analyst. You follow the START triage protocol strictly.

Given a raw emergency report, extract structured intelligence.

START Protocol Triage Categories:
- MINOR (Green): Walking wounded, minor injuries, can wait
- DELAYED (Yellow): Serious but not life-threatening, can wait 1-3 hours
- IMMEDIATE (Red): Life-threatening, needs care within 1 hour
- CRITICAL/EXPECTANT (Black): Unlikely to survive even with treatment

Severity Reasoning Rules:
- Fire + indoor + trapped persons → HIGH severity, IMMEDIATE triage
- Hazardous material present → increase severity by 1 level
- Multiple victims (>3) → increase severity by 1 level
- Building collapse + people inside → IMMEDIATE or CRITICAL
- Gas leak + enclosed space → HIGH severity

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "incident_type": "<fire|flood|gas_leak|building_collapse|cyclone|hazmat|medical|other>",
  "location": "<extracted or inferred location>",
  "severity_level": "<low|medium|high|critical>",
  "priority_score": <integer 1-100, 100 = highest>,
  "triage_category": "<MINOR|DELAYED|IMMEDIATE|CRITICAL>",
  "reason": "<brief reasoning>"
}
"""


@app.post("/analyze-input", response_model=AnalyzeInputResponse)
async def analyze_input(req: AnalyzeInputRequest):
    raise HTTPException(
        status_code=410,
        detail="Use /process-incident so Gemini is called once with Firestore caching.",
    )


# ---------------------------------------------------------------------------
# POST /api/analyze-image — Analyze image with Gemini Vision
# ---------------------------------------------------------------------------
IMAGE_ANALYZE_SYSTEM_PROMPT = """\
You are an AI Emergency Triage Analyst specializing in visual incident assessment. You follow the START triage protocol.

Given an image of an emergency scene and a text description, perform comprehensive analysis.

START Protocol Triage Categories:
- MINOR (Green): Walking wounded, minor injuries, can wait
- DELAYED (Yellow): Serious but not life-threatening, can wait 1-3 hours
- IMMEDIATE (Red): Life-threatening, needs care within 1 hour
- CRITICAL/EXPECTANT (Black): Unlikely to survive even with treatment

Visual Analysis Guidelines:
- Assess visible damage, fire intensity, smoke, structural integrity
- Count visible victims or signs of injury
- Identify hazards (electrical, chemical, gas, water)
- Evaluate scene accessibility and rescue difficulty
- Note environmental conditions (weather, time of day visible in image)

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "incident_type": "<fire|flood|gas_leak|building_collapse|cyclone|hazmat|medical|vehicle_accident|other>",
  "severity_level": "<low|medium|high|critical>",
  "priority_score": <integer 1-100, 100 = highest>,
  "triage_category": "<MINOR|DELAYED|IMMEDIATE|CRITICAL>",
  "image_analysis": "<detailed visual assessment of what is seen in the image>",
  "reason": "<brief combined reasoning from image and text description>"
}
"""


@app.post("/api/analyze-image", response_model=AnalyzeImageResponse)
async def analyze_image(req: AnalyzeImageRequest):
    try:
        prompt = (
            f"{IMAGE_ANALYZE_SYSTEM_PROMPT}\n\n"
            f"Text Description:\n{req.description}"
        )
        raw = await call_gemini_with_image(prompt, req.image_base64)
        data = _extract_json(raw)
        return AnalyzeImageResponse(**data)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Image analysis failed: {str(e)}")



# ---------------------------------------------------------------------------
# 2. POST /predict-escalation
# ---------------------------------------------------------------------------
@app.post("/predict-escalation", response_model=PredictEscalationResponse)
async def predict_escalation(req: PredictEscalationRequest):
    if ml_model is None:
        raise HTTPException(status_code=503, detail="ML model not available")

    try:
        row = {}
        for col in feature_columns:
            val = getattr(req, col)
            le = label_encoders[col]
            if val in le.classes_:
                row[col] = le.transform([val])[0]
            else:
                # Unknown category — use most common class
                row[col] = 0

        X_input = pd.DataFrame([row], columns=feature_columns)
        proba = ml_model.predict_proba(X_input)[0]

        # Find index for "yes" escalation
        target_le = label_encoders["escalation"]
        yes_idx = list(target_le.classes_).index("yes") if "yes" in target_le.classes_ else 1
        threat_growth = round(proba[yes_idx] * 100, 1)

        if threat_growth >= 70:
            prediction = "High likelihood of escalation — immediate intervention recommended"
        elif threat_growth >= 40:
            prediction = "Moderate escalation risk — monitor closely and prepare contingencies"
        else:
            prediction = "Low escalation risk — standard response protocol sufficient"

        return PredictEscalationResponse(
            threat_growth=threat_growth,
            prediction=prediction,
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")


# ---------------------------------------------------------------------------
# 3. POST /auto-dispatch
# ---------------------------------------------------------------------------
DISPATCH_SYSTEM_PROMPT = """\
You are an AI Emergency Dispatch Coordinator. Given an incident analysis and a list of available resources,
determine the optimal dispatch action.

Consider:
- Match resource types to incident type (e.g., fire → fire engine, medical → ambulance)
- Higher severity = more resources
- If hazardous materials are involved, always include Hazmat Team
- People trapped → include Search & Rescue
- Always provide a clear, actionable dispatch order

Respond ONLY with a valid JSON object (no markdown, no explanation):
{
  "action": "<specific dispatch order with resources and quantities>",
  "reason": "<brief tactical reasoning>"
}
"""


@app.post("/auto-dispatch", response_model=DispatchResponse)
async def auto_dispatch(req: DispatchRequest):
    raise HTTPException(
        status_code=410,
        detail="Use /process-incident so Gemini is called once with Firestore caching.",
    )


# ---------------------------------------------------------------------------
# 4. POST /generate-briefing
# ---------------------------------------------------------------------------
BRIEFING_SYSTEM_PROMPT = """\
You are a Tactical Briefing Officer. Given the incident analysis, escalation prediction, and dispatch plan,
generate a concise, actionable tactical briefing for field commanders.

Format:
- SITUATION: 1-2 sentences on what happened
- THREAT ASSESSMENT: Escalation risk and timeline
- ACTIONS ORDERED: Dispatch summary
- COMMANDER NOTES: Any special considerations

Keep the total briefing under 200 words. Be direct and professional.

Respond with plain text (no JSON, no markdown fences).
"""


@app.post("/generate-briefing", response_model=BriefingResponse)
async def generate_briefing(req: BriefingRequest):
    raise HTTPException(
        status_code=410,
        detail="Use /process-incident so Gemini is called once with Firestore caching.",
    )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": ml_model is not None,
        "firebase_enabled": firebase_enabled,
        "firebase_auth_enabled": firebase_auth_enabled,
    }


@app.get("/config/google-maps-key")
async def get_google_maps_key():
    if not GOOGLE_MAPS_API_KEY:
        raise HTTPException(status_code=404, detail="Google Maps API key not configured")
    return {"apiKey": GOOGLE_MAPS_API_KEY}


@app.post("/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    email = req.email.strip().lower()
    user_record: dict[str, Any] | None = None

    if firebase_enabled and db is not None:
        try:
            doc = db.collection(USERS_COLLECTION).document(email).get()
            if doc.exists:
                user_record = doc.to_dict() or {}
            else:
                raise HTTPException(status_code=401, detail="Invalid email or password")
        except HTTPException:
            raise
        except Exception as ex:
            print(f"[WARN] Firestore login lookup failed for {email}: {ex}")
            raise HTTPException(status_code=500, detail="Authentication service unavailable")
    else:
        # Fallback only when Firestore is unavailable.
        fallback = SEEDED_USERS.get(email)
        if not fallback or req.password != fallback["password"]:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        user_record = {
            "email": email,
            "name": fallback["name"],
            "role": fallback["role"],
        }

    if user_record is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    stored_hash = user_record.get("password_hash")
    if stored_hash:
        if not _verify_password(req.password, stored_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")
    else:
        # Backward-compatible path for any legacy plain-text field.
        if req.password != user_record.get("password"):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        if firebase_enabled and db is not None:
            db.collection(USERS_COLLECTION).document(email).set(
                {
                    "password_hash": _hash_password(req.password),
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )

    role = user_record.get("role")
    name = user_record.get("name")

    if role not in {"admin", "user"}:
        raise HTTPException(status_code=403, detail="User role is invalid")

    expires_at = datetime.now(timezone.utc) + timedelta(hours=8)
    access_token = secrets.token_urlsafe(32)

    firebase_custom_token = None
    if firebase_enabled and firebase_auth_enabled:
        try:
            firebase_user = firebase_auth.get_user_by_email(email)
            firebase_custom_token = firebase_auth.create_custom_token(firebase_user.uid).decode("utf-8")
        except Exception as ex:
            print(f"[WARN] Failed generating Firebase custom token for {email}: {ex}")

    return LoginResponse(
        access_token=access_token,
        role=role,
        name=name,
        email=email,
        firebase_custom_token=firebase_custom_token,
        expires_at=expires_at.isoformat(),
    )


@app.post("/api/emergencies", response_model=EmergencyResponse, status_code=201)
async def create_emergency(req: EmergencyCreateRequest):
    if not firebase_enabled or db is None:
        raise HTTPException(status_code=503, detail="Firestore is not available")

    payload = {
        "incident_type": req.incident_type.strip(),
        "severity_level": req.severity_level.lower(),
        "lat": req.lat,
        "lng": req.lng,
        "latitude": req.lat,
        "longitude": req.lng,
        "description": req.description.strip(),
        "status": "active",
        "threat_growth": None,
        "priority_score": None,
        "confidence_score": None,
        "cluster_id": None,
        "cluster_size": 1,
        "created_at": firestore.SERVER_TIMESTAMP,
    }

    try:
        doc_ref = db.collection("emergencies").document()
        doc_ref.set(payload)
        saved = doc_ref.get().to_dict() or {}
        return EmergencyResponse(
            id=doc_ref.id,
            incident_type=saved.get("incident_type", payload["incident_type"]),
            severity_level=saved.get("severity_level", payload["severity_level"]),
            lat=float(saved.get("lat", payload["lat"])),
            lng=float(saved.get("lng", payload["lng"])),
            description=saved.get("description", payload["description"]),
            status=saved.get("status", "active"),
            created_at=_serialize_timestamp(saved.get("created_at")),
        )
    except Exception as ex:
        print(f"[WARN] Failed creating emergency document: {ex}")
        raise HTTPException(status_code=500, detail="Failed to save emergency")


@app.get("/api/emergencies", response_model=list[EmergencyResponse])
async def list_active_emergencies():
    if not firebase_enabled or db is None:
        raise HTTPException(status_code=503, detail="Firestore is not available")

    try:
        docs = db.collection("emergencies").where("status", "==", "active").stream()
        items: list[EmergencyResponse] = []
        for doc in docs:
            data = doc.to_dict() or {}
            items.append(
                EmergencyResponse(
                    id=doc.id,
                    incident_type=data.get("incident_type", "Unknown Incident"),
                    severity_level=str(data.get("severity_level", "low")).lower(),
                    lat=float(data.get("lat", 0)),
                    lng=float(data.get("lng", 0)),
                    description=data.get("description", ""),
                    status=data.get("status", "active"),
                    created_at=_serialize_timestamp(data.get("created_at")),
                )
            )

        items.sort(key=lambda x: x.created_at or "", reverse=True)
        return items
    except Exception as ex:
        print(f"[WARN] Failed reading emergencies: {ex}")
        raise HTTPException(status_code=500, detail="Failed to fetch emergencies")


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
