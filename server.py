from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
CATALOG_PATH = ROOT / "data" / "joybuy_catalog.json"
SESSIONS: dict[str, dict] = {}
MAX_CLARIFICATION_TURNS = 2
REPURCHASE_CATEGORIES = {"Animalerie", "Epicerie et maison", "Best of Asie"}


@dataclass
class SearchHit:
    product: dict
    score: float
    source: str


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    ascii_text = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return ascii_text.lower()


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", normalize(text)))


SYNONYMS = {
    "froid": ["chaud", "chauffant", "hiver", "frileux", "warm", "heat"],
    "chaud": ["froid", "chauffant", "hiver", "thermal"],
    "cadeau": ["offrir", "anniversaire", "pere", "papa", "gift"],
    "papa": ["pere", "homme", "father"],
    "ecole": ["scolaire", "a4", "cartable", "etudiant", "school"],
    "sac": ["backpack", "cartable", "bagage"],
    "impermeable": ["waterproof", "deperlant", "pluie"],
    "ecouteurs": ["earbuds", "bluetooth", "anc", "audio"],
    "metro": ["transport", "train", "bus", "commute"],
    "bruit": ["anc", "silence", "reduction"],
    "chat": ["croquettes", "animalerie", "pet"],
    "lessive": ["capsules", "linge", "menage"],
    "reapprovisionnement": ["reachat", "recurrent", "tous les mois"],
    "chien": ["croquettes", "animalerie", "dog"],
    "beaute": ["soin", "visage", "serum", "creme", "cosmetique"],
    "telephone": ["smartphone", "coque", "chargeur", "usb-c", "powerbank"],
    "cuiseur": ["vapeur", "cuisine", "electromenager"],
    "aspirateur": ["menage", "maison", "sans sac"],
    "ramen": ["nouilles", "asie", "asiatique"],
    "sport": ["fitness", "yoga", "sante", "bien-etre"],
}


def expand_terms(words: set[str]) -> set[str]:
    expanded = set(words)
    for word in list(words):
        expanded.update(SYNONYMS.get(word, []))
    return expanded


def infer_cross_language_hints(message: str) -> str:
    """Small deterministic bridge for PRD examples where source/query terms cross Chinese and French."""
    hints: list[str] = []
    rules = [
        ("怕冷", "froid chaud chauffant hiver frileux"),
        ("爸爸", "papa pere cadeau"),
        ("礼物", "cadeau offrir"),
        ("上学", "ecole etudiant scolaire"),
        ("书包", "sac cartable a4"),
        ("防水", "impermeable waterproof pluie"),
        ("猫粮", "chat croquettes reapprovisionnement"),
        ("猫砂", "chat litiere reapprovisionnement"),
        ("狗粮", "chien croquettes reapprovisionnement"),
        ("洗衣", "lessive linge reapprovisionnement"),
        ("耳机", "ecouteurs bluetooth high-tech"),
        ("手机", "telephone chargeur coque"),
        ("蒸锅", "cuiseur vapeur electromenager cuisine"),
    ]
    for needle, hint in rules:
        if needle in message:
            hints.append(hint)
    return " ".join(hints)


class SimulatedJoybuyProductAPI:
    """Replace this adapter when real Joybuy product/search APIs are available."""

    def __init__(self, catalog_path: Path):
        self.catalog_path = catalog_path
        self.products = json.loads(catalog_path.read_text(encoding="utf-8"))

    def all_products(self) -> list[dict]:
        return list(self.products)

    def keyword_search(self, keywords: list[str], limit: int = 12) -> list[SearchHit]:
        query_terms = expand_terms(tokenize(" ".join(keywords)))
        hits: list[SearchHit] = []
        for product in self.products:
            field_text = " ".join(
                [
                    product["name"],
                    product.get("source_title", ""),
                    product["category"],
                    product.get("subcategory", ""),
                    product.get("brand", ""),
                    product["description"],
                    " ".join(product["tags"]),
                    " ".join(f"{k} {v}" for k, v in product.get("specs", {}).items()),
                ]
            )
            product_terms = tokenize(field_text)
            overlap = query_terms & product_terms
            if overlap:
                score = len(overlap) * 2.0 + product["rating"] / 5
                hits.append(SearchHit(product, score, "keyword_search"))
        return sorted(hits, key=lambda hit: hit.score, reverse=True)[:limit]

    def semantic_search(self, intent: dict, limit: int = 12) -> list[SearchHit]:
        query_terms = expand_terms(tokenize(" ".join([intent["raw"], " ".join(intent["keywords"])])))
        hits: list[SearchHit] = []
        for product in self.products:
            semantic_terms = expand_terms(tokenize(" ".join(product["tags"] + [product["description"], product["category"]])))
            intersection = len(query_terms & semantic_terms)
            union = max(len(query_terms | semantic_terms), 1)
            score = intersection / union
            if intent.get("category") == product["category"]:
                score += 0.45
            if intent.get("scene") in product["tags"]:
                score += 0.18
            if score > 0:
                hits.append(SearchHit(product, round(score * 10, 4), "semantic_search"))
        return sorted(hits, key=lambda hit: hit.score, reverse=True)[:limit]

    def structured_filter(self, intent: dict, limit: int = 12) -> list[SearchHit]:
        hits: list[SearchHit] = []
        for product in self.products:
            score = 0.0
            if intent.get("category") and product["category"] == intent["category"]:
                score += 4.0
            elif intent.get("category"):
                continue
            if intent.get("budget") and product["price"] <= intent["budget"]:
                score += 2.0
            if intent.get("repurchase_candidate") and product.get("repurchasable"):
                score += 3.0
            for pref in intent.get("preferences", []):
                if pref in product["tags"] or pref in product.get("specs", {}).values():
                    score += 1.2
            if score:
                hits.append(SearchHit(product, score + product["rating"] / 5, "structured_filter"))
        return sorted(hits, key=lambda hit: hit.score, reverse=True)[:limit]


PRODUCT_API = SimulatedJoybuyProductAPI(CATALOG_PATH)


def parse_budget(text: str) -> float | None:
    match = re.search(r"(?:moins de|sous|jusqu'?a|max(?:imum)?|<)\s*(\d{1,4})|(\d{2,4})\s*(?:eur|euros|euro|€)", text)
    if not match:
        return None
    return float(match.group(1) or match.group(2))


def parse_intent(message: str, history: list[str] | None = None) -> dict:
    text = normalize(f"{message} {infer_cross_language_hints(message)}")
    words = tokenize(text)
    history = history or []
    intent = {
        "raw": message,
        "category": None,
        "budget": parse_budget(text),
        "recipient": None,
        "scene": None,
        "preferences": [],
        "size": None,
        "keywords": [],
        "missing_fields": [],
        "repurchase_candidate": False,
        "completeness_score": 0.3,
        "clarification_history": history,
    }

    category_rules = [
        ("Beaute", ["beaute", "soin", "visage", "cosmetique", "serum", "creme", "demaquillant", "bioderma", "garnier", "roche"]),
        ("Electromenager", ["electromenager", "aspirateur", "cuisine", "mixeur", "airfryer", "friteuse", "vapeur", "cuiseur", "blender"]),
        ("Gaming", ["gaming", "casque", "souris", "clavier", "gamer", "razer", "logitech", "steelseries"]),
        ("Chaleur et confort", ["froid", "chaud", "chauffant", "hiver", "bouillotte", "frileux", "thermique", "heattech"]),
        ("Sacs et bagages", ["sac", "cartable", "ecole", "a4", "dos", "backpack", "ordinateur", "lycee", "etudiant"]),
        ("High-Tech", ["ecouteur", "ecouteurs", "bluetooth", "telephone", "enceinte", "anc", "bruit", "metro", "chargeur", "coque", "batterie", "usb"]),
        ("Animalerie", ["chat", "chien", "croquette", "croquettes", "litiere", "animal", "purina", "royal", "catsan"]),
        ("Epicerie et maison", ["lessive", "detergent", "menage", "capsule", "capsules", "vaisselle", "eau", "cafe", "essuie", "courses"]),
        ("Best of Asie", ["asie", "asiatique", "ramen", "snacks", "matcha", "nouilles", "nissin", "nongshim"]),
        ("Sport, Sante et Bien-etre", ["sport", "sante", "bien", "yoga", "fitness", "tensiometre", "massage", "halteres"]),
    ]
    for category, terms in category_rules:
        if words & set(terms):
            intent["category"] = category
            break

    if words & {"papa", "pere", "father"}:
        intent["recipient"] = "papa"
    elif words & {"maman", "mere"}:
        intent["recipient"] = "maman"
    elif words & {"enfant", "ecole", "etudiant", "college", "lycee"}:
        intent["recipient"] = "etudiant"

    scene_rules = {
        "cadeau": ["cadeau", "offrir", "anniversaire"],
        "metro": ["metro", "transport", "train", "bus"],
        "ecole": ["ecole", "college", "lycee", "universite"],
        "reachat": ["mois", "reapprovisionnement", "recurrent", "racheter", "rachete", "regulier"],
    }
    for scene, terms in scene_rules.items():
        if words & set(terms):
            intent["scene"] = scene
            break

    preference_rules = {
        "impermeable": ["impermeable", "waterproof", "deperlant", "pluie"],
        "reduction de bruit": ["anc", "bruit", "silence"],
        "sans fil": ["wireless", "bluetooth"],
        "portable": ["portable", "nomade", "leger"],
        "standard recurrent": ["recurrent", "mois", "automatique"],
        "lavable": ["lavable", "entretien"],
    }
    for pref, terms in preference_rules.items():
        if words & set(terms):
            intent["preferences"].append(pref)

    if "a4" in words:
        intent["size"] = "A4"
    intent["repurchase_candidate"] = intent["scene"] == "reachat" or "standard recurrent" in intent["preferences"]

    if not intent["category"]:
        intent["missing_fields"].append("category")
    if intent["scene"] == "cadeau" and not intent["budget"]:
        intent["missing_fields"].append("budget")
    if intent["category"] in {"Sacs et bagages", "High-Tech"} and not intent["preferences"]:
        intent["missing_fields"].append("preferences")

    intent["keywords"] = keyword_generator(intent)
    score = 0.3
    score += 0.25 if intent["category"] else 0
    score += 0.15 if intent["budget"] else 0
    score += 0.1 if intent["scene"] else 0
    score += 0.1 if intent["recipient"] else 0
    score += min(len(intent["preferences"]) * 0.06, 0.18)
    score += 0.05 if intent["size"] else 0
    intent["completeness_score"] = round(min(score, 0.98), 2)
    return intent


def keyword_generator(intent: dict) -> list[str]:
    values = [intent.get("category"), intent.get("recipient"), intent.get("scene"), intent.get("size")]
    values.extend(intent.get("preferences", []))
    values.extend(tokenize(intent.get("raw", "")))
    keywords = []
    for value in values:
        if value and value not in keywords:
            keywords.append(str(value))
    return keywords[:18]


def check_intent_completeness(intent: dict) -> dict:
    """Rule-based guardrail mirroring the PRD check_intent_completeness tool."""
    blocking_fields = list(intent.get("missing_fields", []))
    complete = intent.get("completeness_score", 0) >= 0.62 and not blocking_fields
    return {
        "complete": complete,
        "missing_fields": blocking_fields,
        "score": intent.get("completeness_score", 0),
    }


def product_classifier(product: dict) -> dict:
    """Classify whether the transaction agent may handle automatic replenishment."""
    is_standard = bool(product.get("standard_product") or product.get("repurchasable"))
    low_emotion = product.get("emotional_value", "medium") == "low"
    stable_price = product.get("price_stability", "medium") in {"high", "medium"}
    eligible_category = product.get("category") in REPURCHASE_CATEGORIES
    eligible = is_standard and low_emotion and stable_price and eligible_category and product.get("price", 999) <= 80
    reasons = []
    if is_standard:
        reasons.append("standard_product")
    if low_emotion:
        reasons.append("low_emotional_value")
    if stable_price:
        reasons.append("stable_price")
    if eligible_category:
        reasons.append("repurchase_category")
    return {"eligible": eligible, "reasons": reasons}


def rrf_merge(result_sets: list[list[SearchHit]], k: int = 60) -> list[dict]:
    scores: dict[str, float] = defaultdict(float)
    products: dict[str, dict] = {}
    sources: dict[str, set[str]] = defaultdict(set)
    raw_scores: dict[str, dict[str, float]] = defaultdict(dict)
    for hits in result_sets:
        for rank, hit in enumerate(hits, start=1):
            pid = hit.product["id"]
            products[pid] = hit.product
            sources[pid].add(hit.source)
            raw_scores[pid][hit.source] = hit.score
            scores[pid] += 1 / (k + rank)
    merged = []
    for pid, product in products.items():
        item = dict(product)
        item["retrieval_sources"] = sorted(sources[pid])
        item["retrieval_score"] = round(scores[pid], 5)
        item["raw_scores"] = raw_scores[pid]
        merged.append(item)
    return sorted(merged, key=lambda item: item["retrieval_score"], reverse=True)


def entropy_calculator(products: list[dict]) -> dict:
    if not products:
        return {"category_entropy": 0, "price_spread": 0, "dominant_category": None}
    categories = Counter(product["category"] for product in products)
    total = sum(categories.values())
    entropy = -sum((count / total) * math.log2(count / total) for count in categories.values())
    prices = [product["price"] for product in products]
    return {
        "category_entropy": round(entropy, 3),
        "price_spread": round(max(prices) - min(prices), 2),
        "dominant_category": categories.most_common(1)[0][0],
    }


def question_generator(intent: dict, entropy: dict, turn_count: int = 0) -> dict | None:
    if turn_count >= MAX_CLARIFICATION_TURNS:
        return None
    asked = " ".join(intent.get("clarification_history", []))
    if "category" in intent["missing_fields"] and "category" not in asked:
        return {
            "dimension": "category",
            "question": "Quel type de produit cherchez-vous ?",
            "options": [
                {"label": "Un cadeau qui tient chaud", "value": "cadeau chaleur froid category"},
                {"label": "Un sac pour l'ecole", "value": "sac ecole impermeable A4 category"},
                {"label": "Un produit high-tech", "value": "high-tech bluetooth category"},
            ],
        }
    if "budget" in intent["missing_fields"] and "budget" not in asked:
        return {
            "dimension": "budget",
            "question": "Quel est votre budget approximatif ?",
            "options": [
                {"label": "Moins de 30 euros", "value": "moins de 30 euros budget"},
                {"label": "30 a 50 euros", "value": "moins de 50 euros budget"},
                {"label": "Plus de 50 euros", "value": "moins de 90 euros budget"},
            ],
        }
    if not intent.get("category") and intent["completeness_score"] < 0.72 and entropy["category_entropy"] > 1.2 and "category" not in asked:
        return {
            "dimension": "category",
            "question": "Les resultats sont disperses. Quelle famille vous interesse le plus ?",
            "options": [
                {"label": "High-Tech", "value": "high-tech bluetooth category"},
                {"label": "Maison et confort", "value": "maison chaleur confort category"},
                {"label": "Courses recurrentes", "value": "croquettes lessive reapprovisionnement category"},
            ],
        }
    return None


def fit_score(product: dict, intent: dict) -> float:
    score = product.get("retrieval_score", 0) * 100
    if intent.get("category") == product["category"]:
        score += 30
    if intent.get("budget"):
        score += 18 if product["price"] <= intent["budget"] else -25
    if intent.get("repurchase_candidate") and product.get("repurchasable"):
        score += 20
    product_terms = tokenize(" ".join(product["tags"]) + " " + product["description"])
    score += len(expand_terms(tokenize(intent["raw"])) & product_terms) * 3
    score += product["rating"]
    return round(score, 2)


def product_explainer(product: dict, intent: dict) -> str:
    pieces = []
    if intent.get("budget") and product["price"] <= intent["budget"]:
        pieces.append(f"respecte le budget de {int(intent['budget'])} euros")
    if intent.get("category") == product["category"]:
        pieces.append(f"correspond a la categorie {product['category']}")
    if intent.get("scene"):
        pieces.append(f"adapte au contexte {intent['scene']}")
    if product.get("repurchasable"):
        pieces.append("eligible au reapprovisionnement avec confirmation avant paiement")
    suffix = ", ".join(pieces) if pieces else "proche de la demande exprimee"
    return f"{product['description']} Ce choix est pertinent car il {suffix}."


def diff_comparator(products: list[dict]) -> list[dict]:
    compared = []
    for product in products[:3]:
        compared.append(
            {
                "id": product["id"],
                "name": product["name"],
                "price": product["price"],
                "delivery": f"J+{product['delivery_days']}",
                "key_strength": product.get("key_strength", product["category"]),
                "tradeoff": product.get("tradeoff", "Moins specialise que le premier choix."),
            }
        )
    return compared


def recommendation_generator(products: list[dict], intent: dict) -> list[dict]:
    ranked = []
    for product in products:
        item = dict(product)
        item["fit_score"] = fit_score(product, intent)
        item["ai_reason"] = product_explainer(product, intent)
        item["recommendation_reason"] = item["ai_reason"]
        ranked.append(item)
    ranked.sort(key=lambda item: item["fit_score"], reverse=True)
    return ranked


def search_response(message: str, session_id: str | None = None, history: list[str] | None = None) -> dict:
    session_id = session_id or str(uuid.uuid4())
    history = history or []
    intent = parse_intent(message, history)
    completeness = check_intent_completeness(intent)

    keyword_hits = PRODUCT_API.keyword_search(intent["keywords"])
    semantic_hits = PRODUCT_API.semantic_search(intent)
    filtered_hits = PRODUCT_API.structured_filter(intent)
    merged = rrf_merge([keyword_hits, semantic_hits, filtered_hits])
    entropy = entropy_calculator(merged[:8])
    clarification = question_generator(intent, entropy, len(history))
    forced_search = bool(history and len(history) >= MAX_CLARIFICATION_TURNS)
    ranked = recommendation_generator(merged[:12], intent)
    products = ranked[:8]
    comparison = diff_comparator(products)

    SESSIONS[session_id] = {"intent": intent, "turns": len(history) + 1}
    return {
        "sessionId": session_id,
        "agents": [
            {"name": "Master Agent", "status": "done", "detail": "Orchestration intent -> search -> recommendation"},
            {"name": "Intent Agent", "status": "done", "detail": f"Score {intent['completeness_score']}"},
            {"name": "Completeness Tool", "status": "done", "detail": "Complete" if completeness["complete"] else f"Missing {','.join(completeness['missing_fields'])}"},
            {"name": "Search Agent", "status": "done", "detail": f"KW {len(keyword_hits)} / SEM {len(semantic_hits)} / FIL {len(filtered_hits)}"},
            {"name": "Clarification Agent", "status": "done", "detail": "Question prete" if clarification else ("Limite atteinte, recherche forcee" if forced_search else "Pas de blocage")},
            {"name": "Product Explainer Agent", "status": "done", "detail": "Descriptions FR generees"},
            {"name": "Recommendation Agent", "status": "done", "detail": "RRF + comparaison personnalisee"},
        ],
        "intent": intent,
        "intent_completeness": completeness,
        "search_pipeline": {
            "keyword_search": len(keyword_hits),
            "semantic_search": len(semantic_hits),
            "structured_filter": len(filtered_hits),
            "rrf_merged": len(merged),
            "entropy": entropy,
            "clarification_turn": len(history),
            "max_clarification_turns": MAX_CLARIFICATION_TURNS,
            "forced_search": forced_search,
            "catalog_source": "data/joybuy_catalog.json",
            "adapter": "SimulatedJoybuyProductAPI(realistic_mock_catalog)",
        },
        "clarification": clarification,
        "comparison": comparison,
        "recommendations": products[:3],
        "products": products,
    }


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length == 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


class JoybuyHandler(BaseHTTPRequestHandler):
    server_version = "JoybuyMVP/2.0"

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json({
                "ok": True,
                "service": "joybuy-agent-api",
                "catalog_size": len(PRODUCT_API.products),
                "prd_alignment": ["intent_parser", "keyword_search", "semantic_search", "structured_filter", "rrf_merge", "clarification_limit_2", "product_explainer", "recommendation_generator", "product_classifier", "repurchase_executor"],
            })
            return
        if self.path == "/api/catalog":
            self.send_json({"products": PRODUCT_API.all_products(), "source": "simulated"})
            return
        self.serve_static()

    def do_POST(self):
        try:
            payload = read_json(self)
            if self.path == "/api/search":
                message = str(payload.get("message", "")).strip()
                if not message:
                    self.send_json({"error": "message is required"}, 400)
                    return
                self.send_json(search_response(message, payload.get("sessionId")))
                return

            if self.path == "/api/clarify":
                session_id = payload.get("sessionId")
                answer = str(payload.get("answer", "")).strip()
                session = SESSIONS.get(session_id or "")
                if not session or not answer:
                    self.send_json({"error": "sessionId and answer are required"}, 400)
                    return
                history = list(session["intent"].get("clarification_history", [])) + [answer]
                combined = f"{session['intent']['raw']} {answer}"
                self.send_json(search_response(combined, session_id, history))
                return

            if self.path == "/api/repurchase":
                product_id = payload.get("productId")
                product = next((p for p in PRODUCT_API.products if p["id"] == product_id), None)
                if not product:
                    self.send_json({"error": "unknown product"}, 404)
                    return
                classification = product_classifier(product)
                if not classification["eligible"]:
                    self.send_json({
                        "ok": False,
                        "classification": classification,
                        "message": "Ce produit sera traite par le paiement classique: il n'est pas eligible au reapprovisionnement automatique.",
                    })
                    return
                self.send_json({
                    "ok": True,
                    "classification": classification,
                    "message": "Agent de reapprovisionnement active. Il preparera recherche, comparaison, panier et demandera confirmation avant paiement.",
                    "rule": {
                        "product": product["name"],
                        "frequency": payload.get("frequency", "monthly"),
                        "quantity": int(payload.get("quantity", 1)),
                        "price_cap": product["price"],
                        "payment_policy": "confirm_before_payment",
                    },
                })
                return

            if self.path == "/api/cart":
                product_id = payload.get("productId")
                product = next((p for p in PRODUCT_API.products if p["id"] == product_id), None)
                self.send_json({
                    "ok": True,
                    "message": "Produit ajoute au panier de demonstration.",
                    "line": {"productId": product_id, "name": product["name"] if product else None},
                })
                return

            if self.path == "/api/checkout":
                items = payload.get("items", [])
                self.send_json({
                    "ok": True,
                    "status": "payment_confirmation_required",
                    "message": "Commande preparee. Conformement au PRD, le paiement reste a confirmer par l'utilisateur.",
                    "items": items,
                    "payment_policy": "confirm_before_payment",
                })
                return

            self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def serve_static(self):
        request_path = unquote(self.path.split("?", 1)[0]).lstrip("/")
        file_path = WEB_ROOT / (request_path or "index.html")
        if not file_path.exists() or not file_path.is_file():
            file_path = WEB_ROOT / "index.html"
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


def main():
    port = int(os.environ.get("PORT", "8765"))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), JoybuyHandler)
    print(f"Joybuy MVP running on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
