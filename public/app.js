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
let tab = 'compteur', me = null, lock = null, filtre = 'tous';
const large = () => matchMedia('(min-width: 800px)').matches;
const iso = d => d.toLocaleDateString('sv-SE');
function ondulation(btn) {
  const o = document.createElement('span');
  o.className = 'onde';
  btn.appendChild(o);
  o.addEventListener('animationend', () => o.remove());
}

// écran qui reste allumé (réglage propre à l'appareil), seulement sur l'écran du compteur
const shouldWake = () => pref.get('ecran') === '1' && (tab === 'compteur' || large()) && /^#\/p\/\d+/.test(location.hash);
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
  const ps = await api('/api/projects'), F = [['tous', 'Tous'], ['en_cours', 'En cours'], ['pause', 'En pause'], ['termine', 'Terminés']];
  const L = { pause: 'En pause', termine: 'Terminé' }, vus = ps.filter(p => filtre === 'tous' || p.statut === filtre);
  app.innerHTML = `<header><h1>Mes projets</h1><button class="pill" id="new">+ Nouveau</button></header>
    <div class="row filtres">${F.map(([k, l]) => `<button class="pill ${filtre === k ? '' : 'clair'}" data-f="${k}">${l}</button>`).join('')}</div>` +
    (vus.length ? vus.map(p => `<a class="card" href="#/p/${p.id}"><b>${esc(p.name)}</b><span class="n">${p.rangs}</span>
      <small>${esc([L[p.statut], p.pattern_name, p.materials.split('\n')[0]].filter(Boolean).join(' – ') || 'Pas encore de détails')}</small>
      ${p.objectif ? `<div class="barre"><i style="width:${Math.min(100, Math.round(p.rangs / p.objectif * 100))}%"></i></div>` : ''}</a>`).join('')
    : `<p class="vide">${ps.length ? 'Aucun projet dans cette catégorie.' : 'Aucun projet pour l’instant. Touche « + Nouveau » pour commencer.'}</p>`) +
    `<p class="vide"><small>Connecté : ${esc(me.user)}</small><br><a class="pill clair" href="#/parametres">Paramètres</a> <button class="pill ghost" id="out">Se déconnecter</button></p>`;
  document.querySelectorAll('.filtres button').forEach(b => b.onclick = () => { filtre = b.dataset.f; list(); });
  $('#out').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; route(); };
  $('#new').onclick = async () => {
    const n = prompt('Nom du projet ?');
    if (n?.trim()) { const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: n.trim() }) }); location.hash = '#/p/' + p.id; }
  };
}

async function project(id) {
  let p;
  try { p = await api('/api/projects/' + id); } catch (e) { if (e.status === 401) throw e; location.hash = ''; return; }
  let maj = () => {}, majExtras = () => {};
  const save = d => (maj(), api('/api/projects/' + id, { method: 'PATCH', body: JSON.stringify(d) }))
    .catch(() => alert('Sauvegarde impossible : le serveur ne répond pas.'));
  if (p.steps.some(s => s.longueur == null)) {   // anciennes étapes (rang absolu) -> longueurs
    let prev = 0;
    p.steps.forEach(s => { if (s.longueur == null) { s.longueur = Math.max(1, s.rang - prev); prev = s.rang; } });
    p.debut = Math.max(0, ...p.steps.filter(s => s.fait).map(s => s.rang ?? 0));
    save({ steps: p.steps, debut: p.debut });
  }
  p.steps.forEach(s => { s.repetitions ||= 1; s.faites ||= 0; });
  // titre d'une étape : le « puis » est facultatif
  const titre = s => {
    const r = s.repetitions > 1 ? ` (${s.repetitions} fois)` : '', t = s.texte;
    if (s.longueur === 0) return `Tout de suite${t ? ' : ' + t : ''}${r}`;
    if (!t) return `${s.longueur} rangs${r}`;
    return s.repetitions > 1 ? `Tous les ${s.longueur} rangs : ${t}${r}` : `${s.longueur} rangs, puis : ${t}`;
  };
  const T = [['compteur', 'Compteur'], ['etapes', 'Étapes'], ['stats', 'Stats'], ['infos', 'Infos']];
  const W = large(), TT = W ? T.slice(1) : T;
  if (W && tab === 'compteur') tab = 'etapes';
  app.innerHTML = `<header><a href="#">‹ Projets</a><h1 id="titre">${esc(p.name)}</h1></header>
    ${(nav => W ? `<div class="deux"><section id="g"></section><div>${nav}<section id="v"></section></div></div>` : `${nav}<section id="v"></section>`)(
      `<nav class="tabs">${TT.map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</nav>`)}`;
  document.querySelectorAll('.tabs button').forEach(b => {
    b.className = 'pill ' + (b.dataset.t === tab ? '' : 'clair');
    b.onclick = () => { tab = b.dataset.t; project(id); };
  });
  const render = async (v, tab) => {
  if (tab === 'compteur') {
    v.innerHTML = `<div class="compteur"><div class="suivi" id="suivi"></div><p id="chiffre" aria-live="polite"></p><div id="rayures" style="width:100%"></div><div id="detail" style="width:100%"></div><div id="etape" style="width:100%"></div>
      <div class="boutons"><button class="rond moins" id="moins" aria-label="Enlever un rang">−</button>
      <button class="rond" id="plus" aria-label="Ajouter un rang">+</button></div>
      <div class="row" style="justify-content:center"><button class="pill ghost" id="reset">Remise à 0</button><button class="pill clair" id="conc">Mode concentration</button></div><div id="extras" class="extras"></div></div>`;
    const paint = () => {
      const n = Math.max(0, p.rangs - p.debut), pend = p.steps.filter(x => !x.fait), s = pend[0];
      $('#chiffre').textContent = n;
      const X = p.rayures, reste = X ? X - p.rangs % X : 0;
      $('#rayures').innerHTML = !X ? '' : p.rangs > 0 && p.rangs % X === 0
        ? '<div class="alerte centre"><b>Changement de couleur !</b></div>'
        : `<div class="prochain"><small>Changement de couleur dans ${reste} rang${reste > 1 ? 's' : ''}</small></div>`;
      const L = p.detail_on ? p.detail.split('\n').map(x => x.trim()).filter(Boolean) : [];
      const ligne = k => !L.length ? null : p.detail_boucle ? L[k % L.length] : L[k];
      $('#detail').innerHTML = ligne(n) == null ? '' : `<div class="detail"><small>Rang ${n + 1}</small><b>${esc(ligne(n))}</b>${ligne(n + 1) != null ? `<small>Ensuite : ${esc(ligne(n + 1))}</small>` : ''}</div>`;
      $('#suivi').innerHTML = p.objectif
        ? `<div class="barre"><i style="width:${Math.min(100, Math.round(p.rangs / p.objectif * 100))}%"></i></div><small>Total : ${p.rangs} / ${p.objectif} rangs</small>`
        : p.debut ? `<small>Total : ${p.rangs} rangs</small>` : '';
      const quoi = s && (s.texte || (!s.longueur && s.description));   // consigne affichée dans l'alerte de fin d'étape
      $('#etape').innerHTML = !s ? '' : n >= s.longueur
        ? `<div class="alerte"><b>${s.longueur ? s.longueur + ' rangs faits' : 'À faire maintenant'}${quoi ? ' : ' + esc(quoi) : ''}</b><button class="pill" id="fait">${s.faites + 1 < s.repetitions ? 'Répétition suivante' : 'Étape suivante'}</button></div>`
        : `<div class="prochain"><small>${s.repetitions > 1 ? `Répétition ${s.faites + 1} / ${s.repetitions}` : 'Étape en cours'} : ${n} / ${s.longueur} rangs</small>
            <div class="barre"><i style="width:${Math.round(n / s.longueur * 100)}%"></i></div>
            ${s.description ? `<b class="consigne">${esc(s.description)}</b>` : ''}
            ${s.texte ? `<small>Puis : ${esc(s.texte)}</small>` : ''}</div>`;
      const valider = () => { s.compte = (s.compte ?? s.longueur * s.faites) + n; s.faites++; if (s.faites >= s.repetitions) s.fait = true; p.debut = p.rangs; save({ steps: p.steps, debut: p.debut }); paint(); };
      if ($('#fait')) $('#fait').onclick = valider;
      if ($('#f-chiffre')) {   // mode concentration : chiffre + consigne du rang + alertes seulement quand elles se déclenchent
        $('#f-chiffre').textContent = n;
        $('#f-info').innerHTML = ($('#rayures .alerte')?.outerHTML || '') + ($('#etape .alerte')?.outerHTML.replace('id="fait"', 'id="f-fait"') || '') + $('#detail').innerHTML
          + (s?.description && n < s.longueur ? `<div class="detail"><small>Étape en cours</small><b>${esc(s.description)}</b></div>` : '');
        if ($('#f-fait')) $('#f-fait').onclick = valider;
      }
    };
    const set = n => { p.rangs = Math.max(0, n); save({ rangs: p.rangs, jour: iso(new Date()) }); paint(); };
    const tap = (b, n) => {
      ondulation(b); set(n);
      const c = $('#chiffre'); c.classList.remove('pouf'); void c.offsetWidth; c.classList.add('pouf');
    };
    $('#plus').onclick = e => tap(e.currentTarget, p.rangs + 1);
    $('#moins').onclick = e => { if (p.rangs > p.debut) tap(e.currentTarget, p.rangs - 1); };
    const drawExtras = () => {
      const z = $('#extras');
      if (!p.extras) { z.innerHTML = ''; return; }
      z.innerHTML = p.compteurs.map((c, i) => `<div class="extra"><b>${esc(c.nom)}</b>
        <button class="pill clair" data-i="${i}" data-d="-1" aria-label="Enlever">−</button><span>${c.valeur}</span>
        <button class="pill" data-i="${i}" data-d="1" aria-label="Ajouter">+</button>
        <button class="x" data-i="${i}" aria-label="Supprimer ce compteur">×</button></div>`).join('') +
        '<button class="pill ghost" id="addc">+ Ajouter un compteur</button>';
      z.querySelectorAll('button[data-d]').forEach(b => b.onclick = () => {
        const c = p.compteurs[+b.dataset.i];
        c.valeur = Math.max(0, c.valeur + +b.dataset.d);
        ondulation(b); save({ compteurs: p.compteurs });
        b.parentNode.querySelector('span').textContent = c.valeur;
      });
      z.querySelectorAll('.x').forEach(b => b.onclick = () => {
        const c = p.compteurs[+b.dataset.i];
        if (confirm(`Supprimer le compteur « ${c.nom} » ?`)) { p.compteurs.splice(+b.dataset.i, 1); save({ compteurs: p.compteurs }); drawExtras(); }
      });
      $('#addc').onclick = () => {
        const n = prompt('Nom du compteur ? (ex. augmentations)');
        if (n?.trim()) { p.compteurs.push({ nom: n.trim(), valeur: 0 }); save({ compteurs: p.compteurs }); drawExtras(); }
      };
    };
    $('#reset').onclick = () => { if (p.rangs === p.debut || confirm('Remettre le compteur de l’étape à 0 ? Le total est conservé.')) { p.debut = p.rangs; save({ debut: p.debut }); paint(); } };
    paint();
    drawExtras();
    maj = paint; majExtras = drawExtras;
    $('#conc').onclick = () => {
      const o = document.createElement('div');
      o.id = 'focus';
      o.innerHTML = `<button class="pill ghost" id="quitter">Quitter</button><div id="f-info"></div><p id="f-chiffre"></p>
        <div class="boutons"><button class="rond moins" id="f-moins" aria-label="Enlever un rang">−</button><button class="rond" id="f-plus" aria-label="Ajouter un rang">+</button></div>`;
      document.body.appendChild(o);
      $('#f-plus').onclick = e => tap(e.currentTarget, p.rangs + 1);
      $('#f-moins').onclick = e => { if (p.rangs > p.debut) tap(e.currentTarget, p.rangs - 1); };
      $('#quitter').onclick = () => o.remove();
      paint();
    };
  } else if (tab === 'stats') {
    v.innerHTML = '<p class="vide">Chargement…</p>';
    const rows = await api(`/api/projects/${id}/stats`);
    const par = Object.fromEntries(rows.map(x => [x.day, x.n]));
    const jour = i => iso(new Date(Date.now() - i * 864e5));
    const somme = k => Array.from({ length: k }, (_, i) => par[jour(i)] || 0).reduce((a, b) => a + b, 0);
    const actifs = Array.from({ length: 30 }, (_, i) => par[jour(i)] || 0).filter(n => n > 0);
    const best = rows.reduce((m, x) => x.n > m.n ? x : m, { n: 0 });
    const g = Array.from({ length: 14 }, (_, i) => { const d = jour(13 - i); return { d, n: par[d] || 0 }; }), max = Math.max(1, ...g.map(x => x.n));
    v.innerHTML = rows.length ? `<div class="stats">
      <div><b>${somme(1)}</b>aujourd’hui</div><div><b>${somme(7)}</b>7 derniers jours</div>
      <div><b>${somme(30)}</b>30 derniers jours</div><div><b>${actifs.length ? Math.round(actifs.reduce((a, b) => a + b, 0) / actifs.length) : 0}</b>par jour de tricot</div></div>
      <h2>14 derniers jours</h2>
      <div class="graphe">${g.map(x => `<div title="${x.d} : ${x.n}"><i style="height:${Math.round(x.n / max * 100)}%"></i><small>${+x.d.slice(8)}</small></div>`).join('')}</div>
      ${best.n ? `<p>Meilleur jour : ${best.n} rangs le ${new Date(best.day + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}.</p>` : ''}`
      : '<p class="vide">Les statistiques se remplissent à partir de maintenant : compte quelques rangs et reviens ici.</p>';
  } else if (tab === 'etapes') {
    let edit = -1, ouvert = false;
    const draw = () => {
      const cur = p.steps.findIndex(x => !x.fait), e0 = p.steps[edit] || { longueur: 10, texte: '', description: '', repetitions: 1 };
      const n = Math.max(0, p.rangs - p.debut), paires = p.steps.map((s, i) => [s, i]);
      const faites = paires.filter(([s]) => s.fait), restes = paires.filter(([s]) => !s.fait);
      const item = (s, i) => `<li class="${s.fait ? 'fait' : ''}${i === cur ? ' courante' : ''}${i === edit ? ' edit' : ''}"><span><b>${esc(titre(s))}</b>${s.description ? `<br><small>Pendant : ${esc(s.description)}</small>` : ''}<br>
        <small>${s.fait ? 'Fait' : i === cur ? `En cours : ${s.repetitions > 1 ? 'répétition ' + (s.faites + 1) + '/' + s.repetitions + ', ' : ''}${n} / ${s.longueur} rangs` : 'À venir'}</small></span>
        <span class="row"><button class="pill ghost fleche" data-haut="${i}" aria-label="Monter" ${i === 0 || p.steps[i - 1].fait !== s.fait ? 'disabled' : ''}>▲</button><button class="pill ghost fleche" data-bas="${i}" aria-label="Descendre" ${i === p.steps.length - 1 || p.steps[i + 1].fait !== s.fait ? 'disabled' : ''}>▼</button><button class="pill clair" data-dup="${i}">Dupliquer</button><button class="pill clair" data-m="${i}">Modifier</button><button class="pill ghost" data-i="${i}">Supprimer</button></span>
        ${i === cur ? `<div class="barre"><i style="width:${s.longueur ? Math.min(100, Math.round(n / s.longueur * 100)) : 100}%"></i></div>` : ''}</li>`;
      const ul = l => `<ul class="etapes">${l.map(([s, i]) => item(s, i)).join('')}</ul>`;
      const bloc = !p.steps.length ? '<ul class="etapes"><li class="vide">Aucune étape pour l’instant.</li></ul>'
        : (faites.length ? `<details class="faites"${ouvert ? ' open' : ''}><summary>Terminées (${faites.length})</summary>${ul(faites)}</details>` : '')
          + (restes.length ? `<p class="section">En cours</p>${ul(restes.slice(0, 1))}` + (restes.length > 1 ? `<p class="section">À venir</p>${ul(restes.slice(1))}` : '')
            : '<p class="vide">Toutes les étapes sont terminées.</p>');
      v.innerHTML = `${bloc}
        <form id="f"><h2>${edit >= 0 ? 'Modifier l’étape' : 'Nouvelle étape'}</h2>
        <label for="n">Combien de rangs ? (0 = à faire tout de suite)</label><input type="number" id="n" min="0" value="${e0.longueur}" required>
        <label for="desc">Pendant ces rangs (facultatif, ex. côtes 2/2)</label><input type="text" id="desc" value="${esc(e0.description)}">
        <label for="t">Puis quoi faire ? (facultatif, ex. 1 diminution)</label><input type="text" id="t" value="${esc(e0.texte)}">
        <label for="r">Combien de fois le répéter ? (1 = une seule fois)</label><input type="number" id="r" min="1" max="99" value="${e0.repetitions}" required>
        <div class="row" style="margin-top:1rem"><button class="pill">${edit >= 0 ? 'Enregistrer' : 'Ajouter l’étape'}</button>${edit >= 0 ? '<button type="button" class="pill ghost" id="annuler">Annuler</button>' : ''}</div></form>`;
      v.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => {
        const i = +b.dataset.i, s = p.steps[i], courante = i === p.steps.findIndex(x => !x.fait), n = Math.max(0, p.rangs - p.debut);
        const avant = s.compte ?? s.longueur * (s.fait ? s.repetitions : s.faites);   // rangs des répétitions déjà terminées
        const dd = courante || s.fait ? avant : 0, rr = dd + (courante ? n : 0);       // rangs à retirer du total
        if (!confirm(rr ? `Supprimer cette étape ? Les ${Math.min(rr, p.rangs)} rangs comptés pour elle seront retirés du total.` : 'Supprimer cette étape ?')) return;
        p.rangs = Math.max(0, p.rangs - rr); p.debut = Math.min(p.rangs, Math.max(0, p.debut - dd));
        p.steps.splice(i, 1); edit = -1;
        save({ steps: p.steps, rangs: p.rangs, debut: p.debut, jour: iso(new Date()) }); draw();
      });
      v.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => { edit = +b.dataset.m; if (p.steps[edit].fait) ouvert = true; draw(); $('#f').scrollIntoView({ behavior: 'smooth' }); });
      const det = v.querySelector('details.faites');
      if (det) det.ontoggle = () => { ouvert = det.open; };
      const bouger = (i, d) => { [p.steps[i], p.steps[i + d]] = [p.steps[i + d], p.steps[i]]; edit = -1; save({ steps: p.steps }); draw(); };
      v.querySelectorAll('button[data-haut]').forEach(b => b.onclick = () => bouger(+b.dataset.haut, -1));
      v.querySelectorAll('button[data-bas]').forEach(b => b.onclick = () => bouger(+b.dataset.bas, 1));
      v.querySelectorAll('button[data-dup]').forEach(b => b.onclick = () => {
        const i = +b.dataset.dup, { compte, ...src } = p.steps[i], f = p.steps.findIndex(x => !x.fait);
        p.steps.splice(src.fait ? (f < 0 ? p.steps.length : f) : i + 1, 0, { ...src, faites: 0, fait: false });
        edit = -1; save({ steps: p.steps }); draw();
      });
      if ($('#annuler')) $('#annuler').onclick = () => { edit = -1; draw(); };
      $('#f').onsubmit = ev => {
        ev.preventDefault();
        const l = parseInt($('#n').value, 10), r = parseInt($('#r').value, 10);
        const d = { longueur: Number.isNaN(l) ? 1 : Math.max(0, l), texte: $('#t').value.trim(), description: $('#desc').value.trim(), repetitions: Math.min(99, Math.max(1, r || 1)) };
        if (edit >= 0) { const s = p.steps[edit]; Object.assign(s, d); if (!s.fait) s.faites = Math.min(s.faites, d.repetitions - 1); }
        else p.steps.push({ ...d, faites: 0, fait: false });
        edit = -1; save({ steps: p.steps }); draw();
      };
    };
    draw();
  } else {
    const a = p.pattern_name;
    v.innerHTML = `<label for="nom">Nom du projet</label><input type="text" id="nom" value="${esc(p.name)}">
      <label for="obj">Objectif de rangs (0 = aucun)</label><input type="number" id="obj" min="0" value="${p.objectif}">
      <label for="ray">Rayures : changer de couleur tous les … rangs (0 = désactivé)</label><input type="number" id="ray" min="0" value="${p.rayures}">
      <label class="ligne"><input type="checkbox" id="dt" ${p.detail_on ? 'checked' : ''}> Rangs détaillés</label>
      <div id="dwrap" ${p.detail_on ? '' : 'hidden'}><label for="dl">Une ligne par rang : la 1re ligne pour le rang 1, la 2e pour le rang 2…</label>
      <textarea id="dl">${esc(p.detail)}</textarea>
      <label class="ligne"><input type="checkbox" id="db" ${p.detail_boucle ? 'checked' : ''}> Recommencer au rang 1 après la dernière ligne</label></div>
      <label for="st">Statut</label><select id="st">${[['en_cours', 'En cours'], ['pause', 'En pause'], ['termine', 'Terminé']].map(([k, l]) => `<option value="${k}" ${p.statut === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="ligne"><input type="checkbox" id="ex" ${p.extras ? 'checked' : ''}> Compteurs supplémentaires pour ce projet</label>
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
    $('#ray').onchange = e => { p.rayures = Math.max(0, parseInt(e.target.value, 10) || 0); e.target.value = p.rayures; save({ rayures: p.rayures }); };
    $('#dt').onchange = e => { p.detail_on = e.target.checked ? 1 : 0; $('#dwrap').hidden = !e.target.checked; save({ detail_on: p.detail_on }); };
    $('#dl').onchange = e => { p.detail = e.target.value; save({ detail: p.detail }); };
    $('#db').onchange = e => { p.detail_boucle = e.target.checked ? 1 : 0; save({ detail_boucle: p.detail_boucle }); };
    $('#st').onchange = e => { p.statut = e.target.value; save({ statut: p.statut }); };
    $('#ex').onchange = e => { p.extras = e.target.checked; save({ extras: p.extras }); majExtras(); };
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
  };
  if (W) await render($('#g'), 'compteur');
  await render($('#v'), tab);
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
  document.getElementById('focus')?.remove();
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
matchMedia('(min-width: 800px)').addEventListener('change', () => route());
route();
