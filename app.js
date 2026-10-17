/* Configuration : remplace ces valeurs par celles de ton projet Supabase.
   La clé anon/publishable est conçue pour être publique ; la sécurité repose sur RLS.
   N'insère jamais une clé service_role ici. */
const SUPABASE_URL = "COLLE_ICI_URL_SUPABASE";
const SUPABASE_ANON_KEY = "COLLE_ICI_CLE_ANON_OU_PUBLISHABLE";
const configured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("COLLE_ICI") &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes("COLLE_ICI");
let client = null;

let currentUser = null;
let currentAccess = { role: "user", is_suspended: false };
let posts = [];
let mode = "login";
let view = "feed";
let localMode = false;
let adminPage = 0;
let adminTotal = 0;
const adminPageSize = 50;
const $ = (id) => document.getElementById(id);

async function loadSupabaseClient() {
  if (!configured) return;
  if (!window.supabase) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Impossible de charger Supabase JS."));
      document.head.append(script);
    });
  }
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

async function localApi(path, method = "GET", body) {
  const options = { method, credentials: "same-origin" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Erreur du serveur local.");
  return result;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function notify(message, error = false) {
  const element = $("status");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.style.display = "block";
  clearTimeout(window.nt);
  window.nt = setTimeout(() => {
    element.style.display = "none";
  }, 5500);
}

function relative(date) {
  const minutes = Math.max(0, Date.now() - new Date(date).getTime()) / 60000;
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${Math.floor(minutes)} min`;
  if (minutes < 1440) return `il y a ${Math.floor(minutes / 60)} h`;
  return new Date(date).toLocaleDateString("fr-FR");
}

function userName(user) {
  return user?.user_metadata?.display_name || user?.email?.split("@")[0] || "Membre";
}

function setUser(user) {
  if (!user || user.id !== currentUser?.id) {
    currentAccess = { role: "user", is_suspended: false };
  }
  currentUser = user;
  $("authButton").textContent = user ? "Mon compte" : "Connexion";
  $("sideAuth").textContent = user ? "Gérer mon compte" : "Créer un compte";
  $("sideName").textContent = user ? userName(user) : "Visiteur";
  $("sideHandle").textContent = user
    ? `@${user.email?.split("@")[0] || "membre"}`
    : "Connecte-toi pour publier";
  $("topAvatar").textContent = user
    ? userName(user).slice(0, 1).toUpperCase()
    : "N";
  $("sideAvatar").textContent = $("topAvatar").textContent;
  $("postText").placeholder = user
    ? "Partage une idée, un projet ou une découverte…"
    : "Connecte-toi pour partager une idée…";
  $("logoutButton").classList.toggle("hidden", !user);
  const isAdmin = user && currentAccess.role === "admin" && !currentAccess.is_suspended;
  $("adminNav").classList.toggle("hidden", !isAdmin);
  $("mobileAdminNav").classList.toggle("hidden", !isAdmin);
  if (!isAdmin && view === "admin") setView("feed");
  renderProfile();
}

function applyLocalSession(session) {
  const user = session?.user || null;
  setUser(user);
  currentAccess = session?.access || { role: "user", is_suspended: false };
  setUser(user);
}

async function loadAccess() {
  if (localMode) {
    try {
      applyLocalSession(await localApi("/session"));
      if (currentAccess.is_suspended) {
        notify("Ton compte est suspendu. Contacte un administrateur.", true);
      }
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (!client || !currentUser) return;
  const { data, error } = await client.rpc("get_my_access");
  if (error) {
    currentAccess = { role: "user", is_suspended: false };
    setUser(currentUser);
    notify("Applique schema.sql pour activer la gestion des comptes.", true);
    return;
  }

  currentAccess = data || { role: "user", is_suspended: false };
  setUser(currentUser);
  if (currentAccess.is_suspended) {
    notify("Ton compte est suspendu. Contacte un administrateur.", true);
  }
}

function renderProfile() {
  const profile = $("profileView");
  if (!currentUser) {
    profile.innerHTML =
      "<h2>Mon profil</h2><p>Connecte-toi pour voir ton profil.</p><button class='btn' onclick='openAuth()'>Connexion</button>";
    return;
  }

  profile.innerHTML = `<div class="row"><div class="avatar profile-avatar">${esc(userName(currentUser).slice(0, 1).toUpperCase())}</div><div><h2 class="profile-name">${esc(userName(currentUser))}</h2><div class="muted">${esc(currentUser.email || "")} · Profil NEXO</div></div></div><p>Bienvenue dans ton espace NEXO. Partage tes idées et participe aux quêtes créatives.</p><div class="tag">Créativité</div> <div class="tag">Communauté</div><p class="notice">Pour ta sécurité, garde ton adresse e-mail privée et utilise un pseudo public.</p><button class="btn secondary" onclick="openAuth()">Gérer mon compte</button>`;
}

function showAuth() {
  $("authModal").classList.remove("hidden");
  $("logoutButton").classList.toggle("hidden", !currentUser);
  $("authForm").classList.toggle("hidden", !!currentUser);
  $("switchAuth").classList.toggle("hidden", !!currentUser);
  if (currentUser) {
    $("authTitle").textContent = "Ton compte";
    $("authSubtitle").textContent = "Tu es connecté.";
  } else {
    setMode("login");
  }
}

function openAuth() {
  showAuth();
}
window.openAuth = openAuth;

function setMode(nextMode) {
  mode = nextMode;
  $("authTitle").textContent =
    mode === "login" ? "Connexion à NEXO" : "Créer ton compte NEXO";
  $("authSubtitle").textContent =
    mode === "login"
      ? "Retrouve ta communauté."
      : "Choisis un pseudo et rejoins la communauté.";
  $("authSubmit").textContent =
    mode === "login" ? "Se connecter" : "Créer mon compte";
  $("switchAuth").textContent =
    mode === "login" ? "Créer un compte" : "J'ai déjà un compte";
  $("nameLabel").classList.toggle("hidden", mode === "login");
  $("displayName").classList.toggle("hidden", mode === "login");
  $("displayName").required = mode === "signup";
  $("password").autocomplete =
    mode === "login" ? "current-password" : "new-password";
}

function openPostComposer(text = "", tag = "Défi créatif") {
  setView("feed");
  $("postText").value = text;
  $("postTag").value = tag;
  $("composer").scrollIntoView({ behavior: "smooth", block: "center" });
  $("postText").focus();
}

function setView(nextView) {
  if (
    nextView === "admin" &&
    (currentAccess.role !== "admin" || currentAccess.is_suspended)
  ) {
    return;
  }
  view = nextView;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("profileView").classList.toggle("hidden", view !== "profile");
  $("questsView").classList.toggle("hidden", view !== "quests");
  $("adminView").classList.toggle("hidden", view !== "admin");
  $("feedHeading").classList.toggle(
    "hidden",
    view === "profile" || view === "quests" || view === "admin",
  );
  $("composer").classList.toggle(
    "hidden",
    view === "profile" || view === "quests" || view === "admin",
  );
  $("posts").classList.toggle(
    "hidden",
    view === "profile" || view === "quests" || view === "admin",
  );
  $("feedTitle").textContent =
    view === "discover"
      ? "Découvrir des idées"
      : view === "profile"
        ? "Mon profil"
        : view === "quests"
          ? "Quêtes créatives"
          : "À découvrir";
  if (view === "discover") $("search").focus();
  if (view === "quests") {
    $("questsView").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  if (view === "admin") loadAdminUsers();
}

function setAdminStatus(message, error = false) {
  const status = $("adminStatus");
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function loadAdminUsers() {
  if (currentAccess.role !== "admin" || currentAccess.is_suspended) return;
  setAdminStatus("Chargement des comptes…");
  let users;
  if (localMode) {
    try {
      const result = await localApi(
        `/admin/users?limit=${adminPageSize}&offset=${adminPage * adminPageSize}`,
      );
      users = result.users;
      adminTotal = result.total;
    } catch (error) {
      setAdminStatus("Impossible de charger les comptes : " + error.message, true);
      return;
    }
  } else {
    const { data, error } = await client.rpc("admin_list_users", {
      result_limit: adminPageSize,
      result_offset: adminPage * adminPageSize,
    });
    if (error) {
      setAdminStatus("Impossible de charger les comptes : " + error.message, true);
      return;
    }
    users = data || [];
    adminTotal = users[0]?.total_count || 0;
  }

  users = users || [];
  if (users.length === 0 && adminPage > 0) {
    adminPage -= 1;
    return loadAdminUsers();
  }
  $("adminUsers").innerHTML = users
    .map((user) => {
      const isCurrentUser = user.user_id === currentUser.id;
      const userId = esc(user.user_id);
      return `<tr>
        <td>${esc(user.email || "")}</td>
        <td>${esc(user.display_name || "Membre")}</td>
        <td>${esc(new Date(user.created_at).toLocaleDateString("fr-FR"))}</td>
        <td><select class="field admin-role" data-user-id="${userId}" aria-label="Rôle de ${esc(user.email || user.display_name)}" ${isCurrentUser ? "disabled" : ""}><option value="user" ${user.role === "user" ? "selected" : ""}>Membre</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option></select></td>
        <td><label class="admin-suspend"><input class="admin-suspended" type="checkbox" data-user-id="${userId}" ${user.is_suspended ? "checked" : ""} ${isCurrentUser ? "disabled" : ""}> Suspendu</label></td>
        <td><div class="admin-row-actions"><button class="btn secondary" type="button" data-save-user="${userId}" ${isCurrentUser ? "disabled" : ""}>Enregistrer</button><button class="btn secondary" type="button" data-delete-user="${userId}" ${isCurrentUser ? "disabled" : ""}>Supprimer</button></div></td>
      </tr>`;
    })
    .join("");
  const pageCount = Math.max(1, Math.ceil(adminTotal / adminPageSize));
  $("adminPageLabel").textContent = `Page ${adminPage + 1} / ${pageCount}`;
  $("adminPrev").disabled = adminPage === 0;
  $("adminNext").disabled = adminPage + 1 >= pageCount;
  setAdminStatus(adminTotal + (adminTotal > 1 ? " comptes" : " compte"));
}

async function updateManagedUser(button) {
  const row = button.closest("tr");
  const userId = button.dataset.saveUser;
  const role = row.querySelector(".admin-role").value;
  const isSuspended = row.querySelector(".admin-suspended").checked;
  let error;
  if (localMode) {
    try {
      await localApi(`/admin/users/${encodeURIComponent(userId)}`, "PATCH", {
        role,
        is_suspended: isSuspended,
      });
    } catch (caught) {
      error = caught;
    }
  } else {
    ({ error } = await client.rpc("admin_update_user", {
      target_user_id: userId,
      target_role: role,
      target_is_suspended: isSuspended,
    }));
  }
  if (error) {
    setAdminStatus("Modification impossible : " + error.message, true);
    return;
  }
  setAdminStatus("Compte mis à jour.");
  await loadAdminUsers();
}

async function deleteManagedUser(button) {
  const userId = button.dataset.deleteUser;
  if (!confirm("Supprimer définitivement ce compte et ses publications ?")) return;
  let error;
  if (localMode) {
    try {
      await localApi(`/admin/users/${encodeURIComponent(userId)}`, "DELETE");
    } catch (caught) {
      error = caught;
    }
  } else {
    ({ error } = await client.rpc("admin_delete_user", {
      target_user_id: userId,
    }));
  }
  if (error) {
    setAdminStatus("Suppression impossible : " + error.message, true);
    return;
  }
  adminTotal = Math.max(0, adminTotal - 1);
  if (adminPage > 0 && adminPage * adminPageSize >= adminTotal) {
    adminPage -= 1;
  }
  setAdminStatus("Compte supprimé.");
  await loadAdminUsers();
}

async function loadPosts() {
  if (localMode) {
    try {
      const result = await localApi("/posts");
      posts = result.posts || [];
      renderPosts();
    } catch (error) {
      notify("Impossible de charger les publications : " + error.message, true);
    }
    return;
  }
  if (!client) {
    posts = [];
    renderPosts();
    notify(
      "Le site est en mode configuration : ajoute tes identifiants Supabase en suivant le guide.",
      true,
    );
    return;
  }

  const { data, error } = await client
    .from("posts")
    .select("id,content,topic,created_at,user_id,profiles(display_name)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    notify("Impossible de charger les publications : " + error.message, true);
    return;
  }

  const postIds = (data || []).map((post) => post.id);
  let engagements = [];
  if (postIds.length) {
    const { data: engagementData, error: engagementError } = await client.rpc(
      "get_post_engagement",
      { post_ids: postIds },
    );
    if (engagementError) {
      notify("Impossible de charger les likes : " + engagementError.message, true);
      return;
    }
    engagements = engagementData || [];
  }
  const engagementByPost = new Map(
    engagements.map((item) => [String(item.post_id), item]),
  );
  posts = (data || []).map((post) => ({
    ...post,
    author: post.profiles?.display_name || "Membre",
    likesCount: engagementByPost.get(String(post.id))?.likes_count || 0,
    liked: engagementByPost.get(String(post.id))?.liked || false,
  }));
  renderPosts();
}

function renderPosts() {
  const query = $("search").value.trim().toLowerCase();
  const list = posts.filter((post) =>
    (post.content + " " + (post.topic || "") + " " + post.author)
      .toLowerCase()
      .includes(query),
  );
  $("postCount").textContent =
    list.length + " publication" + (list.length > 1 ? "s" : "");
  $("posts").innerHTML = list.length
    ? list
        .map(
          (post) => `<article class="panel post"><div class="posthead"><div class="avatar">${esc((post.author || "M").slice(0, 1).toUpperCase())}</div><div class="postmeta"><strong>${esc(post.author)} <span class="muted small">@membre</span></strong><span class="muted small">${esc(relative(post.created_at))} · <span class="tag">${esc(post.topic || "Idée")}</span></span></div>${currentUser?.id === post.user_id ? `<button class="action" onclick="deletePost('${post.id}')">Supprimer</button>` : ""}</div><div class="postbody">${esc(post.content)}</div><div class="actions"><button class="action ${post.liked ? "liked" : ""}" onclick="toggleLike('${post.id}')">${post.liked ? "♥" : "♡"} ${post.likesCount || 0} J'aime</button><button class="action" onclick="notify('Les commentaires seront ajoutés dans une prochaine version.')">▢ Commentaires bientôt</button><button class="action" onclick="sharePost('${post.id}')">↗ Partager</button></div></article>`,
        )
        .join("")
    : `<div class="panel empty">${client || localMode ? "Aucune publication pour le moment. Sois le premier à partager une idée !" : "Configure Supabase pour charger les publications partagées."}</div>`;
}

async function publish() {
  if (!client && !localMode) {
    notify("Configure Supabase avant de publier des posts partagés.", true);
    return;
  }
  if (!currentUser) {
    showAuth();
    notify("Connecte-toi pour publier.", true);
    return;
  }

  const content = $("postText").value.trim();
  const topic = $("postTag").value.trim().slice(0, 24) || "Idée";
  if (!content) {
    notify("Écris d'abord ton idée.", true);
    return;
  }

  const button = $("publish");
  button.disabled = true;
  let error;
  if (localMode) {
    try {
      await localApi("/posts", "POST", { content, topic });
    } catch (caught) {
      error = caught;
    }
  } else {
    ({ error } = await client
      .from("posts")
      .insert({ content, topic, user_id: currentUser.id }));
  }
  button.disabled = false;
  if (error) {
    notify("Publication impossible : " + error.message, true);
    return;
  }

  $("postText").value = "";
  $("postTag").value = "";
  notify("Publication partagée avec la communauté !");
  await loadPosts();
}

async function toggleLike(id) {
  if ((!client && !localMode) || !currentUser) {
    showAuth();
    notify("Connecte-toi pour aimer une publication.", true);
    return;
  }

  const post = posts.find((item) => String(item.id) === String(id));
  if (!post) return;
  if (localMode) {
    try {
      await localApi(
        `/posts/${encodeURIComponent(id)}/likes`,
        post.liked ? "DELETE" : "POST",
      );
    } catch (error) {
      notify("Action impossible : " + error.message, true);
      return;
    }
    await loadPosts();
    return;
  }
  const result = post.liked
    ? await client
        .from("likes")
        .delete()
        .eq("post_id", id)
        .eq("user_id", currentUser.id)
    : await client
        .from("likes")
        .insert({ post_id: id, user_id: currentUser.id });
  if (result.error) {
    notify("Action impossible : " + result.error.message, true);
    return;
  }
  await loadPosts();
}
window.toggleLike = toggleLike;

async function deletePost(id) {
  if ((!client && !localMode) || !currentUser || !confirm("Supprimer cette publication ?")) return;
  if (localMode) {
    try {
      await localApi(`/posts/${encodeURIComponent(id)}`, "DELETE");
    } catch (error) {
      notify("Suppression impossible : " + error.message, true);
      return;
    }
    notify("Publication supprimée.");
    await loadPosts();
    return;
  }
  const { error } = await client
    .from("posts")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) {
    notify("Suppression impossible : " + error.message, true);
    return;
  }
  notify("Publication supprimée.");
  await loadPosts();
}
window.deletePost = deletePost;

async function sharePost(id) {
  const url = location.href.split("#")[0] + "#post-" + id;
  try {
    await navigator.clipboard.writeText(url);
    notify("Lien copié !");
  } catch {
    notify(url);
  }
}

$("publish").addEventListener("click", publish);
$("search").addEventListener("input", renderPosts);
$("authButton").addEventListener("click", showAuth);
$("sideAuth").addEventListener("click", showAuth);
$("closeModal").addEventListener("click", () =>
  $("authModal").classList.add("hidden"),
);
$("authModal").addEventListener("click", (event) => {
  if (event.target === $("authModal")) {
    $("authModal").classList.add("hidden");
  }
});
$("switchAuth").addEventListener("click", () =>
  setMode(mode === "login" ? "signup" : "login"),
);
$("refreshUsers").addEventListener("click", loadAdminUsers);
$("adminPrev").addEventListener("click", () => {
  adminPage = Math.max(0, adminPage - 1);
  loadAdminUsers();
});
$("adminNext").addEventListener("click", () => {
  if ((adminPage + 1) * adminPageSize < adminTotal) {
    adminPage += 1;
    loadAdminUsers();
  }
});
$("adminUsers").addEventListener("click", async (event) => {
  const saveButton = event.target.closest("[data-save-user]");
  if (saveButton) {
    saveButton.disabled = true;
    await updateManagedUser(saveButton);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-user]");
  if (deleteButton) {
    deleteButton.disabled = true;
    await deleteManagedUser(deleteButton);
    deleteButton.disabled = false;
  }
});
$("logoutButton").addEventListener("click", async () => {
  if (localMode) {
    try {
      await localApi("/logout", "POST");
    } catch (error) {
      notify(error.message, true);
    }
  } else if (client) {
    await client.auth.signOut();
  }
  setUser(null);
  $("authModal").classList.add("hidden");
  notify("Tu es déconnecté.");
  loadPosts();
});
$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client && !localMode) {
    notify("Supabase n'est pas configuré. Suis le fichier LISEZ-MOI.", true);
    return;
  }

  const email = $("email").value.trim();
  const password = $("password").value;
  let user;
  if (localMode) {
    try {
      const result = await localApi(
        mode === "signup" ? "/register" : "/login",
        "POST",
        {
          email,
          password,
          displayName: $("displayName").value.trim() || "Membre",
        },
      );
      applyLocalSession(result);
      user = result.user;
    } catch (error) {
      notify("Connexion impossible : " + error.message, true);
      return;
    }
  } else {
    let result;
    if (mode === "signup") {
      const display_name = $("displayName").value.trim() || "Membre";
      result = await client.auth.signUp({
        email,
        password,
        options: { data: { display_name } },
      });
      if (!result.error && !result.data.session) {
        notify("Compte créé ! Vérifie ton e-mail si la confirmation est activée.");
        $("authModal").classList.add("hidden");
        return;
      }
    } else {
      result = await client.auth.signInWithPassword({ email, password });
    }

    if (result.error) {
      notify("Connexion impossible : " + result.error.message, true);
      return;
    }
    user = result.data.user;
    setUser(user);
  }

  $("authModal").classList.add("hidden");
  notify(mode === "signup" ? "Bienvenue sur NEXO !" : "Content de te revoir !");
  if (!localMode) await loadAccess();
  await loadPosts();
});

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => setView(button.dataset.view)),
);
$("joinQuest").addEventListener("click", () =>
  openPostComposer("Mon pouvoir inédit : ...", "Défi créatif"),
);

async function start() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (response.ok) {
      const result = await response.json();
      localMode = result.mode === "local";
    }
  } catch {
    localMode = false;
  }

  if (localMode) {
    try {
      applyLocalSession(await localApi("/session"));
      notify("Mode local SQLite : les données restent sur cet ordinateur.");
      await loadPosts();
    } catch (error) {
      notify("Impossible de démarrer le mode local : " + error.message, true);
    }
    return;
  }

  if (!client && configured) {
    try {
      await loadSupabaseClient();
    } catch (error) {
      notify(error.message, true);
    }
  }

  if (!client) {
    setUser(null);
    renderPosts();
    notify(
      "Mode aperçu : connecte Supabase pour activer les comptes et les posts partagés.",
      true,
    );
    return;
  }

  const {
    data: { session },
  } = await client.auth.getSession();
  setUser(session?.user || null);
  await loadAccess();
  client.auth.onAuthStateChange((_event, nextSession) => {
    setUser(nextSession?.user || null);
    window.setTimeout(() => {
      loadAccess();
      loadPosts();
    }, 0);
  });
  await loadPosts();
}

setMode("login");
start();
