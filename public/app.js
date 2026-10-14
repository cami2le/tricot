const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const api = async (url, o = {}) => {
  const r = await fetch(url, { headers: typeof o.body === 'string' ? {'Content-Type':'application/json'} : {}, ...o });
  if (!r.ok) { const e = new Error(await r.text()); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
};
const pref = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
let tab = 'compteur', me = null, lock = null;

// écran qui reste allumé (réglage propre à l'appareil), seulement sur l'écran du compteur
const shouldWake = () => pref.get('ecran') === '1' && tab === 'compteur' && /^#\/p\/\d+/.test(location.hash);
async function wake() {
  try {
    if (shouldWake()) {
      if (!lock && 'wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); lock.onrelease = () => { lock = null; }; }
    } else if (lock) { await lock.release(); lock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });

async function list() {
  tab = 'compteur';
  const ps = await api('/api/projects');
  app.innerHTML = `<header><h1>Mes projets</h1><button class="pill" id="new">+ Nouveau</button></header>` +
    (ps.length ? ps.map(p => `<a class="card" href="#/p/${p.id}"><b>${esc(p.name)}</b><span class="n">${p.rangs}</span>
      <small>${esc([p.pattern_name, p.materials.split('\n')[0]].filter(Boolean).join(' – ') || 'Pas encore de détails')}</small>
      ${p.objectif ? `<div class="barre"><i style="width:${Math.min(100, Math.round(p.rangs / p.objectif * 100))}%"></i></div>` : ''}</a>`).join('')
    : '<p class="vide">Aucun projet pour l’instant. Touche « + Nouveau » pour commencer.</p>') +
    `<p class="vide"><small>Connecté : ${esc(me.user)}</small><br><a class="pill clair" href="#/parametres">Paramètres</a> <button class="pill ghost" id="out">Se déconnecter</button></p>`;
  $('#out').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; route(); };
  $('#new').onclick = async () => {
    const n = prompt('Nom du projet ?');
    if (n?.trim()) { const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: n.trim() }) }); location.hash = '#/p/' + p.id; }
  };
}

async function project(id) {
  let p;
  try { p = await api('/api/projects/' + id); } catch (e) { if (e.status === 401) throw e; location.hash = ''; return; }
  const save = d => api('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(d) })
    .catch(() => alert('Sauvegarde impossible : le serveur ne répond pas.'));
  const T = [['compteur', 'Compteur'], ['etapes', 'Étapes'], ['infos', 'Infos']];
  app.innerHTML = `<header><a href="#">‹ Projets</a><h1 id="titre">${esc(p.name)}</h1></header>
    <nav class="tabs">${T.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</nav><section id="v"></section>`;
  document.querySelectorAll('.tabs button').forEach(b => {
    b.className = 'pill ' + (b.dataset.t === tab ? '' : 'clair');
    b.onclick = () => { tab = b.dataset.t; project(id); };
  });
  const v = $('#v');

  if (tab === 'compteur') {
    v.innerHTML = `<div class="compteur"><div class="suivi" id="suivi"></div><p id="chiffre" aria-live="polite"></p><div id="etape" style="width:100%"></div>
      <div class="boutons"><button class="rond moins" id="moins" aria-label="Enlever un rang">−</button>
      <button class="rond" id="plus" aria-label="Ajouter un rang">+</button></div>
      <button class="pill ghost" id="reset">Remise à 0</button></div>`;
    const paint = () => {
      $('#chiffre').textContent = p.rangs;
      $('#suivi').innerHTML = p.objectif ? `<div class="barre"><i style="width:${Math.min(100, Math.round(p.rangs / p.objectif * 100))}%"></i></div><small>${p.rangs} / ${p.objectif} rangs</small>` : '';
      const s = p.steps.find(x => !x.fait), d = s ? s.rang - p.rangs : 0;
      $('#etape').innerHTML = !s ? '' : d <= 0
        ? `<div class="alerte"><b>Maintenant : ${esc(s.texte)}</b><button class="pill" id="fait">Fait ✓</button></div>`
        : `<div class="prochain">Dans ${d} rang${d > 1 ? 's' : ''} : ${esc(s.texte)}</div>`;
      if ($('#fait')) $('#fait').onclick = () => { s.fait = true; save({ steps: p.steps }); paint(); };
    };
    const set = n => { p.rangs = Math.max(0, n); save({ rangs: p.rangs }); paint(); };
    $('#plus').onclick = () => set(p.rangs + 1);
    $('#moins').onclick = () => set(p.rangs - 1);
    $('#reset').onclick = () => { if (p.rangs === 0 || confirm('Remettre le compteur à 0 ?')) set(0); };
    paint();
  } else if (tab === 'etapes') {
    const draw = () => {
      v.innerHTML = `<ul class="etapes">${p.steps.map((s, i) => `<li class="${s.fait ? 'fait' : ''}"><span><b>${esc(s.texte)}</b><br>
        <small>Rang ${s.rang}${s.fait ? ' · fait' : s.rang > p.rangs ? ` · dans ${s.rang - p.rangs} rang(s)` : ' · à faire maintenant'}</small></span>
        <button class="pill ghost" data-i="${i}">Supprimer</button></li>`).join('') || '<li class="vide">Aucune étape pour l’instant.</li>'}</ul>
        <form id="f"><label for="n">Dans combien de rangs ?</label><input type="number" id="n" min="1" value="10" required>
        <label for="t">Quoi faire ? (ex. 1 diminution)</label><input type="text" id="t" required>
        <div class="row" style="margin-top:1rem"><button class="pill">Ajouter l’étape</button></div></form>`;
      v.querySelectorAll('li button').forEach(b => b.onclick = () => { p.steps.splice(+b.dataset.i, 1); save({ steps: p.steps }); draw(); });
      $('#f').onsubmit = e => {
        e.preventDefault();
        p.steps.push({ rang: p.rangs + Math.max(1, parseInt($('#n').value, 10) || 1), texte: $('#t').value.trim(), fait: false });
        p.steps.sort((a, b) => a.rang - b.rang);
        save({ steps: p.steps }); draw();
      };
    };
    draw();
  } else {
    const a = p.pattern_name;
    v.innerHTML = `<label for="nom">Nom du projet</label><input type="text" id="nom" value="${esc(p.name)}">
      <label for="obj">Objectif de rangs (0 = aucun)</label><input type="number" id="obj" min="0" value="${p.objectif}">
      <label for="mat">Matériel (laine, aiguilles, tension, coloris…)</label><textarea id="mat">${esc(p.materials)}</textarea>
      <label>Patron PDF</label><div class="row">
      ${a ? `<a class="pill" target="_blank" href="/api/projects/${id}/pattern">${esc(a)}</a>` : '<span>Aucun patron joint</span>'}
      <label class="pill clair">${a ? 'Remplacer' : 'Joindre un PDF'}<input type="file" id="pdf" accept="application/pdf" hidden></label>
      ${a ? '<button class="pill ghost" id="delpdf">Supprimer</button>' : ''}</div>
      <p><a class="pill clair" href="/api/projects/${id}/export">Télécharger le projet (.zip)</a></p>
      <button class="pill ghost danger" id="delp">Supprimer le projet</button>`;
    $('#nom').onchange = e => {
      if (!e.target.value.trim()) { e.target.value = p.name; return; }
      p.name = e.target.value.trim(); $('#titre').textContent = p.name; save({ name: p.name });
    };
    $('#obj').onchange = e => { p.objectif = Math.max(0, parseInt(e.target.value, 10) || 0); e.target.value = p.objectif; save({ objectif: p.objectif }); };
    $('#mat').onchange = e => save({ materials: e.target.value });
    $('#pdf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        await api(`/api/projects/${id}/pattern`, { method: 'PUT', body: f, headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(f.name) } });
        project(id);
      } catch { alert('Envoi impossible : choisis un fichier PDF de moins de 50 Mo.'); }
    };
    if (a) $('#delpdf').onclick = async () => { if (confirm('Supprimer le patron ?')) { await api(`/api/projects/${id}/pattern`, { method: 'DELETE' }); project(id); } };
    $('#delp').onclick = async () => {
      if (confirm(`Supprimer « ${p.name} » et son patron ? Cette action est définitive.`)) { await api('/api/projects/' + id, { method: 'DELETE' }); location.hash = ''; }
    };
  }
  wake();
}

function settings() {
  tab = 'compteur';
  app.innerHTML = `<header><a href="#">‹ Projets</a><h1>Paramètres</h1></header>
    <label class="ligne"><input type="checkbox" id="ecran" ${pref.get('ecran') === '1' ? 'checked' : ''}> Garder l’écran allumé pendant le comptage</label>
    <small>Réglage propre à cet appareil.</small>
    <h2>Changer le mot de passe</h2>
    <form id="f"><label for="a">Ancien mot de passe</label><input type="password" id="a" autocomplete="current-password" required>
    <label for="n">Nouveau mot de passe (8 caractères minimum)</label><input type="password" id="n" autocomplete="new-password" required>
    <p id="err" role="alert"></p><button class="pill">Changer le mot de passe</button></form>`;
  $('#ecran').onchange = e => pref.set('ecran', e.target.checked ? '1' : '0');
  $('#f').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/password', { method: 'POST', body: JSON.stringify({ ancien: $('#a').value, nouveau: $('#n').value }) });
      $('#f').reset(); $('#err').textContent = 'Mot de passe modifié ✓';
    } catch (x) { $('#err').textContent = x.message; }
  };
}

function loginView() {
  let reg = me.first;
  const draw = (msg = '') => {
    app.innerHTML = `<header><h1>${reg ? 'Créer un compte' : 'Connexion'}</h1></header>
      ${me.first ? '<p>Premier compte : il récupère tous les projets déjà enregistrés.</p>' : ''}
      <form id="f"><label for="u">Nom d’utilisateur</label>
      <input type="text" id="u" autocomplete="username" autocapitalize="none" required>
      <label for="p">Mot de passe${reg ? ' (8 caractères minimum)' : ''}</label>
      <input type="password" id="p" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
      <p id="err" role="alert">${esc(msg)}</p>
      <button class="pill" type="submit">${reg ? 'Créer mon compte' : 'Se connecter'}</button></form>
      ${me.canRegister && !me.first ? `<p><button class="pill ghost" id="sw">${reg ? 'J’ai déjà un compte' : 'Créer un compte'}</button></p>` : ''}`;
    $('#f').onsubmit = async e => {
      e.preventDefault();
      try {
        await api(reg ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify({ username: $('#u').value.trim(), password: $('#p').value }) });
        me = null; route();
      } catch (err) { draw(err.message); }
    };
    if ($('#sw')) $('#sw').onclick = () => { reg = !reg; draw(); };
  };
  draw();
}

async function route() {
  try {
    if (!me?.user) me = await api('/api/me');
    if (!me.user) return loginView();
    const m = location.hash.match(/^#\/p\/(\d+)/);
    await (location.hash === '#/parametres' ? settings() : m ? project(+m[1]) : list());
    wake();
  } catch (e) {
    if (e.status === 401) { me = null; return route(); }
    app.innerHTML = '<p class="vide">Le serveur ne répond pas. Réessaie dans un instant.</p>';
  }
}
addEventListener('hashchange', route);
route();
