const root = document.getElementById("root");

let view = "home";
let query = "";
let isSearching = false;
let sessionId = `session_${Date.now()}`;
let result = null;
let activeModalProduct = null;
let activatedAgents = new Set();
let toast = null;
let showTrends = false;
let headerPanel = null;
let selectedLanguage = "FR";
let deliveryCode = "75007";
let cartItems = [];

const CATEGORY_QUERIES = {
  "Beauté": "produits de beauté soin visage",
  "Électroménager": "petit électroménager cuisine maison",
  "Gaming": "accessoires gaming casque souris clavier",
  "High-Tech": "écouteurs Bluetooth téléphone enceinte portable",
  "Animalerie": "croquettes chat litière réapprovisionnement",
  "Épicerie et Boissons": "courses maison lessive boissons",
  "Best of Asie": "produits asiatiques cuisine snacks",
  "Sport, Santé et Bien-être": "sport santé bien-être",
  "Maison": "maison confort couverture chauffante lessive",
  "Mode": "vêtements accessoires sac",
  "Sport": "sport santé bien-être",
};

function categoryQuery(label) {
  return CATEGORY_QUERIES[label] || label;
}

function euro(value) {
  if (typeof value === "number") return value.toFixed(2).replace(".", ",");
  return String(value || "").replace(".", ",");
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Erreur reseau");
  return data;
}

function normalizeIntent(intent) {
  return {
    category: intent?.category || null,
    scene: intent?.scene || null,
    audience: intent?.recipient || null,
    budget: intent?.budget ? `< ${intent.budget}€` : null,
  };
}

function normalizeProduct(product, index = 0) {
  return {
    id: product.id,
    name: product.name,
    price: euro(product.price),
    ai_description: product.ai_reason || product.description || "",
    recommendation_reason: product.recommendation_reason || product.ai_reason || product.description || "",
    image: product.image || "/assets/speaker.png",
    is_best_choice: index === 0,
    is_standard_product: !!product.repurchasable,
  };
}

function render() {
  root.innerHTML = `
    <div class="min-h-screen bg-white">
      ${Header()}
      <main>
        ${view === "home" ? Home() : ""}
        ${view === "results" && result ? Results() : ""}
      </main>
      ${headerPanel ? HeaderPanel() : ""}
      ${activeModalProduct ? RepurchaseModal(activeModalProduct) : ""}
      ${toast ? Toast(toast) : ""}
    </div>
  `;
  bindEvents();
}

function Header() {
  const navItems = ["Beauté", "Électroménager", "Gaming", "High-Tech", "Animalerie", "Épicerie et Boissons", "Best of Asie", "Sport, Santé et Bien-être"];
  return `
    <header class="w-full">
      <div class="bg-black text-white text-xs py-2">
        <div class="max-w-7xl mx-auto px-4 flex items-center justify-center gap-8">
          <span>✓ Qualité garantie</span>
          <span>✓ Livraison le jour même ou le lendemain</span>
          <span>📱 Téléchargez l'application</span>
        </div>
      </div>
      <div class="bg-white border-b border-gray-200">
        <div class="max-w-7xl mx-auto px-4 py-3">
          <div class="flex items-center justify-between gap-6">
            <button type="button" id="homeLogo" class="text-3xl font-bold text-joybuy-red">Joybuy</button>
            <div class="flex-1 max-w-2xl">${SearchBox()}</div>
            <div class="flex items-center gap-6 text-sm">
              <button id="deliveryButton" class="flex items-center gap-1 hover:text-joybuy-red">📍 Livrer à ${escapeHtml(deliveryCode)}</button>
              <button id="languageButton" class="flex items-center gap-1 hover:text-joybuy-red">FR ${escapeHtml(selectedLanguage)}</button>
              <button id="loginButton" class="hover:text-joybuy-red">Se connecter</button>
              <button id="cartButton" class="flex items-center gap-1 hover:text-joybuy-red">🛒 Panier${cartItems.length ? ` (${cartItems.length})` : ""}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="bg-white border-b border-gray-200">
        <div class="max-w-7xl mx-auto px-4">
          <nav class="flex items-center gap-6 text-sm py-3 overflow-x-auto">
            ${navItems.map((item) => `<button class="nav-category whitespace-nowrap hover:text-joybuy-red transition-colors" data-query="${escapeHtml(categoryQuery(item))}">${item}</button>`).join("")}
          </nav>
        </div>
      </div>
    </header>
  `;
}

function SearchBox() {
  return `
    <div class="relative">
      <form id="searchForm" class="relative">
        <input
          type="text"
          id="searchInput"
          value="${escapeHtml(query)}"
          placeholder="Décrivez ce que vous cherchez en français..."
          class="w-full px-4 py-3 pr-32 border border-gray-300 rounded-lg focus:outline-none focus:border-joybuy-red"
          ${isSearching ? "disabled" : ""}
        />
        <button
          type="submit"
          class="absolute right-1 top-1 bottom-1 px-6 bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50 flex items-center gap-2"
          ${isSearching ? "disabled" : ""}
        >
          <span class="text-xs bg-joybuy-red px-2 py-0.5 rounded text-white font-bold">✦ IA</span>
          Rechercher
        </button>
      </form>
      <div id="trendBox" class="mt-2 bg-white border border-gray-200 rounded-lg shadow-lg p-4 ${showTrends && view === "home" ? "" : "hidden"}">
        <div class="text-sm text-gray-600 mb-2">Tendances :</div>
        <div class="flex flex-wrap gap-2">
          ${["téléphone", "toilette", "enceinte portable", "décoration murale", "cuiseur vapeur"].map((item) => `<button class="trend px-3 py-1 bg-gray-100 rounded-full text-sm hover:bg-gray-200" data-value="${item}">${item}</button>`).join("")}
        </div>
      </div>
      ${isSearching ? `<div class="absolute top-full left-0 right-0 mt-2 h-1 bg-gray-200 rounded-full overflow-hidden"><div class="h-full bg-joybuy-red progress-bar"></div></div>` : ""}
    </div>
  `;
}

function Home() {
  return `
    <div class="max-w-7xl mx-auto px-4 py-8">
      <div class="grid grid-cols-2 gap-4 mb-8">
        <button type="button" class="home-category bg-joybuy-red text-white rounded-lg p-8 flex items-center justify-center h-64" data-query="courses supermarché lessive boissons maison">
          <div class="text-center">
            <h2 class="text-3xl font-bold mb-2">Coupons supermarché</h2>
            <p class="text-lg">Économisez sur vos courses</p>
          </div>
        </button>
        <div class="grid grid-rows-2 gap-4">
          <button type="button" class="home-category bg-gray-800 text-white rounded-lg p-6 flex items-center justify-center" data-query="promotions Joybuy high-tech maison animalerie">
            <div class="text-center">
              <h3 class="text-xl font-bold">Bienvenue sur Joybuy</h3>
              <p class="text-sm mt-2">Découvrez nos offres</p>
            </div>
          </button>
          <button type="button" class="home-category bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg p-6 flex items-center justify-center" data-query="nouveautés produits high-tech beauté sport">
            <div class="text-center">
              <h3 class="text-xl font-bold">Nouveautés</h3>
              <p class="text-sm mt-2">Les derniers produits</p>
            </div>
          </button>
        </div>
      </div>
      <div class="mb-8">
        <h2 class="text-2xl font-bold mb-4">Catégories populaires</h2>
        <div class="grid grid-cols-4 gap-4">
          ${[
            { name: "High-Tech", emoji: "📱" },
            { name: "Maison", emoji: "🏠" },
            { name: "Mode", emoji: "👔" },
            { name: "Sport", emoji: "⚽" },
          ].map((item) => `
            <button class="home-category bg-white border border-gray-200 rounded-lg p-6 text-center hover:shadow-lg transition-shadow cursor-pointer" data-query="${escapeHtml(categoryQuery(item.name))}">
              <div class="text-4xl mb-2">${item.emoji}</div>
              <div class="font-medium">${item.name}</div>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function Results() {
  const recommendations = (result.recommendations || []).map(normalizeProduct);
  const products = (result.products || []).map(normalizeProduct);
  return `
    <div class="max-w-7xl mx-auto px-4 py-6">
      <button id="backHome" type="button" class="mb-4 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:border-joybuy-red hover:text-joybuy-red transition-colors">← Retour à l'accueil</button>
      ${IntentSummary(normalizeIntent(result.intent))}
      ${result.clarification ? Clarification(result.clarification) : ""}
      ${recommendations.length ? RecommendationGrid(recommendations) : ""}
      ${products.length ? ProductGrid(products) : ""}
    </div>
  `;
}

function IntentSummary(intent) {
  const chips = [intent.category, intent.scene, intent.audience, intent.budget].filter(Boolean);
  return `
    <div class="animate-fade-in bg-gray-50 rounded-lg p-4 mb-6">
      <div class="flex items-center flex-wrap gap-2">
        <span class="text-gray-700 font-medium">✦ Joybuy IA a compris :</span>
        ${chips.map((chip) => `<span class="px-3 py-1 bg-red-100 text-joybuy-red rounded-full text-sm font-medium">${escapeHtml(chip)}</span>`).join("")}
      </div>
    </div>
  `;
}

function Clarification(clarification) {
  return `
    <div class="animate-slide-down bg-white border-l-4 border-joybuy-red rounded-lg shadow-md p-6 mb-6">
      <div class="text-sm text-gray-500 mb-2">Pour affiner votre recherche :</div>
      <div class="text-lg font-medium text-gray-900 mb-4">${escapeHtml(clarification.question)}</div>
      <div class="flex flex-wrap gap-3">
        ${clarification.options.map((option) => `<button class="clarify px-4 py-2 border-2 border-gray-300 rounded-lg hover:border-joybuy-red hover:text-joybuy-red transition-colors" data-answer="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`).join("")}
      </div>
    </div>
  `;
}

function RecommendationGrid(items) {
  return `
    <div class="animate-fade-in mb-8">
      <h2 class="text-xl font-bold mb-4 flex items-center gap-2">
        <span class="text-joybuy-red">✦</span>
        <span>Nos recommandations IA</span>
      </h2>
      <div class="grid grid-cols-3 gap-4">
        ${items.map((item, index) => `
          <div class="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-lg transition-shadow relative" style="animation-delay:${index * 100}ms">
            ${item.is_best_choice ? `<div class="absolute top-2 right-2 bg-joybuy-red text-white text-xs px-2 py-1 rounded-full flex items-center gap-1 animate-scale-in">✦ Meilleur choix</div>` : ""}
            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="w-full aspect-square rounded-lg mb-3" style="object-fit:cover;background:#e5e7eb" />
            <h3 class="font-medium text-gray-900 mb-2 line-clamp-2">${escapeHtml(item.name)}</h3>
            <div class="text-2xl font-bold text-joybuy-red mb-2">${item.price} €</div>
            <p class="text-sm text-gray-500 mb-3 line-clamp-2">${escapeHtml(item.recommendation_reason)}</p>
            <button class="add-cart w-full bg-joybuy-red text-white py-2 rounded-lg hover:bg-red-700 transition-colors" data-id="${escapeHtml(item.id)}">Ajouter au panier</button>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function ProductGrid(items) {
  return `
    <div class="animate-fade-in">
      <h2 class="text-xl font-bold mb-4">Tous les résultats</h2>
      <div class="grid grid-cols-4 gap-4">
        ${items.map((item, index) => `
          <div class="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-lg transition-shadow relative" style="animation-delay:${index * 50}ms">
            ${activatedAgents.has(item.id) ? `<div class="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1 animate-scale-in">Agent activé ✓</div>` : ""}
            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="w-full aspect-square rounded-lg mb-3" style="object-fit:cover;background:#e5e7eb" />
            <h3 class="font-medium text-gray-900 mb-2 line-clamp-2 text-sm">${escapeHtml(item.name)}</h3>
            <div class="text-xl font-bold text-joybuy-red mb-2">${item.price} €</div>
            <div class="flex items-center gap-1 mb-2">
              <span class="text-yellow-400">★★★★</span>
              <span class="text-gray-300">★</span>
              <span class="text-xs text-gray-500">(4.5)</span>
            </div>
            <p class="text-xs text-gray-500 mb-3 line-clamp-2">${escapeHtml(item.ai_description)}</p>
            <div class="space-y-2">
              <button class="add-cart w-full bg-joybuy-red text-white py-2 rounded-lg hover:bg-red-700 transition-colors text-sm" data-id="${escapeHtml(item.id)}">Ajouter au panier</button>
              <button class="view-product w-full border border-gray-300 text-gray-700 py-2 rounded-lg hover:border-joybuy-red hover:text-joybuy-red transition-colors text-sm">Voir le produit</button>
              ${item.is_standard_product && !activatedAgents.has(item.id) ? `<button class="activate-agent w-full text-xs text-joybuy-red hover:underline flex items-center justify-center gap-1 mt-2" data-id="${item.id}">🔄 Configurer le réapprovisionnement automatique</button>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function HeaderPanel() {
  if (headerPanel === "delivery") {
    return `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" data-close-panel="true">
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 animate-scale-in" data-panel-card="true">
          <div class="border-b border-gray-200 p-6">
            <h2 class="text-xl font-bold text-joybuy-red">Adresse de livraison</h2>
            <p class="text-sm text-gray-500 mt-1">Choisissez le code postal pour personnaliser la livraison.</p>
          </div>
          <div class="p-6 space-y-4">
            <label class="block text-sm font-medium text-gray-700">Code postal</label>
            <input id="deliveryInput" value="${escapeHtml(deliveryCode)}" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-joybuy-red" />
            <div class="grid grid-cols-3 gap-2">
              ${["75007", "75001", "69002"].map((code) => `<button class="delivery-preset border border-gray-300 rounded-lg py-2 hover:border-joybuy-red hover:text-joybuy-red" data-code="${code}">${code}</button>`).join("")}
            </div>
            <button id="saveDelivery" class="w-full bg-joybuy-red text-white py-3 rounded-lg hover:bg-red-700 transition-colors font-medium">Enregistrer</button>
            <button class="close-panel w-full text-gray-600 hover:text-gray-800 text-sm">Annuler</button>
          </div>
        </div>
      </div>
    `;
  }

  if (headerPanel === "language") {
    return `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" data-close-panel="true">
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 animate-scale-in" data-panel-card="true">
          <div class="border-b border-gray-200 p-6">
            <h2 class="text-xl font-bold text-joybuy-red">Langue et pays</h2>
            <p class="text-sm text-gray-500 mt-1">Démonstration locale pour la version française Joybuy.</p>
          </div>
          <div class="p-6 space-y-3">
            ${["FR", "EN", "中文"].map((lang) => `<button class="language-option w-full flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:border-joybuy-red" data-lang="${escapeHtml(lang)}"><span>${escapeHtml(lang)}</span><span>${selectedLanguage === lang ? "✓" : ""}</span></button>`).join("")}
            <button class="close-panel w-full text-gray-600 hover:text-gray-800 text-sm">Fermer</button>
          </div>
        </div>
      </div>
    `;
  }

  if (headerPanel === "login") {
    return `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" data-close-panel="true">
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 animate-scale-in" data-panel-card="true">
          <div class="border-b border-gray-200 p-6">
            <h2 class="text-xl font-bold text-joybuy-red">Se connecter</h2>
            <p class="text-sm text-gray-500 mt-1">Connexion de démonstration, sans compte réel.</p>
          </div>
          <div class="p-6 space-y-4">
            <input id="loginEmail" type="email" placeholder="email@example.com" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-joybuy-red" />
            <input id="loginPassword" type="password" placeholder="Mot de passe" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:border-joybuy-red" />
            <button id="demoLogin" class="w-full bg-joybuy-red text-white py-3 rounded-lg hover:bg-red-700 transition-colors font-medium">Continuer</button>
            <button class="close-panel w-full text-gray-600 hover:text-gray-800 text-sm">Annuler</button>
          </div>
        </div>
      </div>
    `;
  }

  if (headerPanel === "cart") {
    return `
      <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" data-close-panel="true">
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 animate-scale-in" data-panel-card="true">
          <div class="border-b border-gray-200 p-6">
            <h2 class="text-xl font-bold text-joybuy-red">Panier</h2>
            <p class="text-sm text-gray-500 mt-1">${cartItems.length ? `${cartItems.length} article(s)` : "Votre panier est vide."}</p>
          </div>
          <div class="p-6 space-y-4">
            ${cartItems.length ? cartItems.map((item) => `
              <div class="flex items-center justify-between gap-3 border border-gray-200 rounded-lg p-3">
                <span class="text-sm font-medium">${escapeHtml(item.name)}</span>
                <span class="text-joybuy-red font-bold">${escapeHtml(item.price)} €</span>
              </div>
            `).join("") : `<div class="bg-gray-50 rounded-lg p-4 text-gray-600">Ajoutez un produit depuis les résultats.</div>`}
            <button class="close-panel w-full bg-joybuy-red text-white py-3 rounded-lg hover:bg-red-700 transition-colors font-medium">${cartItems.length ? "Continuer mes achats" : "Fermer"}</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

function RepurchaseModal(product) {
  return `
    <div id="modalBackdrop" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 animate-scale-in">
        <div class="border-b border-gray-200 p-6">
          <h2 class="text-xl font-bold text-joybuy-red flex items-center gap-2">
            <span>✦</span>
            <span>Réapprovisionnement automatique</span>
          </h2>
          <p class="text-sm text-gray-500 mt-1">${escapeHtml(product.name)}</p>
        </div>
        <div class="p-6 space-y-6">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-3">Choisissez la fréquence de réapprovisionnement :</label>
            <div class="space-y-2">
              ${[
                ["monthly", "Tous les mois"],
                ["bimonthly", "Tous les 2 mois"],
                ["quarterly", "Tous les 3 mois"],
              ].map(([value, label], index) => `
                <label class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:border-joybuy-red cursor-pointer transition-colors">
                  <input type="radio" name="frequency" value="${value}" ${index === 0 ? "checked" : ""} class="text-joybuy-red focus:ring-joybuy-red" />
                  <span class="text-gray-900">${label}</span>
                </label>
              `).join("")}
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Quantité par commande :</label>
            <input id="quantityInput" type="number" min="1" max="5" value="1" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-joybuy-red" />
          </div>
          <div class="bg-gray-50 p-4 rounded-lg">
            <p class="text-sm text-gray-600 leading-relaxed">L'agent effectuera automatiquement la recherche, la comparaison et l'ajout au panier. Vous recevrez une notification pour confirmer le paiement.</p>
          </div>
          <button id="confirmAgent" class="w-full bg-joybuy-red text-white py-3 rounded-lg hover:bg-red-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed">Activer l'Agent</button>
          <button id="cancelAgent" class="w-full text-gray-600 hover:text-gray-800 text-sm">Annuler</button>
        </div>
      </div>
    </div>
  `;
}

function Toast(data) {
  const bg = data.type === "error" ? "bg-joybuy-red" : "bg-green-500";
  return `
    <div class="fixed top-20 right-4 z-50 animate-slide-down">
      <div class="${bg} text-white px-6 py-4 rounded-lg shadow-lg flex items-center gap-3 max-w-md">
        <span class="text-xl">${data.type === "error" ? "✦" : "✓"}</span>
        <span>${escapeHtml(data.message)}</span>
        <button id="closeToast" class="ml-4 text-white hover:text-gray-200">✕</button>
      </div>
    </div>
  `;
}

function bindEvents() {
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const trendBox = document.getElementById("trendBox");

  document.getElementById("homeLogo")?.addEventListener("click", goHome);
  document.getElementById("backHome")?.addEventListener("click", goHome);

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextQuery = input.value.trim();
    if (!nextQuery || isSearching) return;
    query = nextQuery;
    showTrends = false;
    trendBox?.classList.add("hidden");
    input.blur();
    await runSearch(nextQuery);
  });

  input?.addEventListener("input", () => {
    query = input.value;
  });
  input?.addEventListener("focus", () => {
    if (view === "home") {
      showTrends = true;
      render();
    }
  });
  input?.addEventListener("blur", () => setTimeout(() => {
    showTrends = false;
    render();
  }, 200));

  document.querySelectorAll(".trend").forEach((button) => {
    button.addEventListener("click", async () => {
      query = button.dataset.value;
      showTrends = false;
      trendBox?.classList.add("hidden");
      await runSearch(query);
    });
  });

  document.querySelectorAll(".nav-category, .home-category").forEach((button) => {
    button.addEventListener("click", async () => {
      query = button.dataset.query;
      showTrends = false;
      await runSearch(query);
    });
  });

  document.querySelectorAll(".clarify").forEach((button) => {
    button.addEventListener("click", async () => {
      await runClarify(button.dataset.answer);
    });
  });

  document.querySelectorAll(".add-cart").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/cart", {});
      showToast("Produit ajouté au panier.", "success");
    });
  });

  document.querySelectorAll(".view-product").forEach((button) => {
    button.addEventListener("click", () => showToast("Fiche produit de démonstration.", "success"));
  });

  document.querySelectorAll(".activate-agent").forEach((button) => {
    button.addEventListener("click", () => {
      const product = (result.products || []).find((item) => item.id === button.dataset.id);
      activeModalProduct = product ? normalizeProduct(product) : null;
      render();
    });
  });

  document.getElementById("modalBackdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "modalBackdrop") {
      activeModalProduct = null;
      render();
    }
  });
  document.getElementById("cancelAgent")?.addEventListener("click", () => {
    activeModalProduct = null;
    render();
  });
  document.getElementById("confirmAgent")?.addEventListener("click", runActivateAgent);
  document.getElementById("closeToast")?.addEventListener("click", () => {
    toast = null;
    render();
  });
}

function goHome() {
  view = "home";
  query = "";
  result = null;
  activeModalProduct = null;
  showTrends = false;
  render();
}

async function runSearch(message) {
  isSearching = true;
  view = "results";
  showTrends = false;
  render();
  try {
    result = await api("/api/search", { message, sessionId });
    sessionId = result.sessionId;
    view = "results";
  } catch (error) {
    showToast("Une erreur est survenue lors de la recherche", "error");
    view = "home";
  } finally {
    isSearching = false;
    render();
  }
}

async function runClarify(answer) {
  isSearching = true;
  render();
  try {
    result = await api("/api/clarify", { sessionId, answer });
  } catch (error) {
    showToast("Une erreur est survenue lors du traitement", "error");
  } finally {
    isSearching = false;
    render();
  }
}

async function runActivateAgent() {
  if (!activeModalProduct) return;
  const frequency = document.querySelector("input[name='frequency']:checked")?.value || "monthly";
  const quantity = Number(document.getElementById("quantityInput")?.value || 1);
  try {
    await api("/api/repurchase", { productId: activeModalProduct.id, frequency, quantity });
    activatedAgents.add(activeModalProduct.id);
    activeModalProduct = null;
    showToast("✦ Agent de réapprovisionnement activé avec succès !", "success");
  } catch (error) {
    showToast("Une erreur est survenue lors de l'activation", "error");
  }
}

function showToast(message, type = "success") {
  toast = { message, type };
  render();
  setTimeout(() => {
    toast = null;
    render();
  }, 3000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

render();
