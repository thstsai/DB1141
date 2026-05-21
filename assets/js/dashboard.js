'use strict';

/* ── Auth ───────────────────────────────────────────────── */
const AUTH_KEY = 'db_dash_auth';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2,'0')).join('');
}

async function initAuth(passwordHash) {
  const overlay = el('authOverlay');
  if (!passwordHash) { overlay.classList.add('d-none'); return; }
  if (sessionStorage.getItem(AUTH_KEY) === passwordHash) { overlay.classList.add('d-none'); return; }

  const attempt = async () => {
    const hash = await sha256(el('authPassword').value);
    if (hash === passwordHash) {
      sessionStorage.setItem(AUTH_KEY, passwordHash);
      overlay.classList.add('d-none');
    } else {
      el('authError').classList.remove('d-none');
      el('authPassword').value = '';
      el('authPassword').focus();
    }
  };

  el('authSubmit').addEventListener('click', attempt);
  el('authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  el('authPassword').focus();

  await new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('d-none')) { observer.disconnect(); resolve(); }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });
}

/* ── State ──────────────────────────────────────────────── */
let allTeams     = [];
let teamsData    = {};
let githubToken  = localStorage.getItem('gh_token') || '';
let currentView  = 'grid';
let statusFilter = 'all';
let searchQuery  = '';
let checkResults = {};   // teamId → result object

/* ── GitHub API ─────────────────────────────────────────── */
function apiHeaders() {
  const h = { 'Accept': 'application/vnd.github+json' };
  if (githubToken) h['Authorization'] = `Bearer ${githubToken}`;
  return h;
}

async function checkFile(repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    { headers: apiHeaders() }
  );
  if (res.ok) {
    const data = await res.json();
    // Get commit date for this file
    let committedAt = null;
    try {
      const cr = await fetch(
        `https://api.github.com/repos/${repo}/commits?path=${path}&per_page=1`,
        { headers: apiHeaders() }
      );
      if (cr.ok) {
        const commits = await cr.json();
        if (commits.length) committedAt = commits[0].commit.committer.date;
      }
    } catch (_) {}
    return { found: true, size: data.size, htmlUrl: data.html_url, committedAt };
  }
  if (res.status === 404) return { found: false };
  const remaining = res.headers.get('X-RateLimit-Remaining');
  if (remaining === '0') throw new Error('API rate limit reached — add a GitHub token.');
  throw new Error(`HTTP ${res.status}`);
}

async function checkRepo(team) {
  const required = teamsData.requiredFiles || [];
  const base = `https://api.github.com/repos/${team.repo}`;

  // Verify repo exists first
  try {
    const repoRes = await fetch(base, { headers: apiHeaders() });
    if (repoRes.status === 404) return { status: 'no-repo', files: [] };
    if (!repoRes.ok) throw new Error(`HTTP ${repoRes.status}`);
  } catch (e) {
    return { status: 'error', message: e.message, files: [] };
  }

  // Check each required file
  const files = [];
  try {
    for (const req of required) {
      const result = await checkFile(team.repo, req.path);
      files.push({ path: req.path, label: req.label, ...result });
    }
  } catch (e) {
    return { status: 'error', message: e.message, files };
  }

  const foundCount = files.filter(f => f.found).length;
  const totalCount = files.length;

  let status;
  if (totalCount === 0)          status = 'complete';   // no requirements defined
  else if (foundCount === 0)     status = 'missing';
  else if (foundCount < totalCount) status = 'partial';
  else                           status = 'complete';

  // Latest commit among found files
  const dates = files.filter(f => f.committedAt).map(f => new Date(f.committedAt));
  const latestDate = dates.length ? new Date(Math.max(...dates)).toISOString() : null;

  return { status, files, foundCount, totalCount, latestDate };
}

/* ── Formatting helpers ─────────────────────────────────── */
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(2)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function statusBadge(status) {
  const map = {
    complete:  ['status-complete',  '<i class="bi bi-check-circle-fill me-1"></i>Complete'],
    partial:   ['status-partial',   '<i class="bi bi-exclamation-circle-fill me-1"></i>Partial'],
    missing:   ['status-missing',   '<i class="bi bi-x-circle-fill me-1"></i>Not Submitted'],
    checking:  ['status-checking',  '<i class="bi bi-hourglass-split me-1"></i>Checking…'],
    error:     ['status-error',     '<i class="bi bi-exclamation-circle me-1"></i>Error'],
    'no-repo': ['status-no-repo',   '<i class="bi bi-question-circle me-1"></i>Repo Not Found'],
  };
  const [cls, label] = map[status] || map.error;
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function fileChecklist(files) {
  if (!files || !files.length) return '';
  return files.map(f => `
    <div class="file-check-row d-flex align-items-center gap-1 mt-1">
      ${f.found
        ? `<i class="bi bi-check-circle-fill found"></i>
           <a href="${f.htmlUrl}" target="_blank" class="text-decoration-none found">${f.label}</a>
           <span class="text-muted ms-auto">${fmtBytes(f.size)}</span>`
        : `<i class="bi bi-x-circle-fill missing"></i>
           <span class="missing">${f.label}</span>
           <span class="text-muted ms-auto small">missing</span>`
      }
    </div>`).join('');
}

/* ── Summary stats ──────────────────────────────────────── */
function updateStats() {
  const total    = allTeams.length;
  const complete = allTeams.filter(t => checkResults[t.id]?.status === 'complete').length;
  const partial  = allTeams.filter(t => checkResults[t.id]?.status === 'partial').length;
  const missing  = allTeams.filter(t => ['missing','no-repo'].includes(checkResults[t.id]?.status)).length;
  const pending  = allTeams.filter(t => !checkResults[t.id] || checkResults[t.id].status === 'checking').length;

  el('statTotal').textContent    = total;
  el('statSubmitted').textContent = complete;
  el('statPartial').textContent  = partial;
  el('statMissing').textContent  = missing + (pending ? ` (+${pending})` : '');

  const pct = total ? Math.round(((complete + partial * 0.5) / total) * 100) : 0;
  el('progressBar').style.width  = pct + '%';
  el('progressPct').textContent  = pct + '%';
}

/* ── Render grid view ───────────────────────────────────── */
function renderGrid() {
  const visible = filteredTeams();
  const grid = el('gridView');
  grid.innerHTML = '';

  if (!visible.length) {
    grid.innerHTML = `<div class="col-12 text-center text-muted py-5">
      <i class="bi bi-search fs-1 d-block mb-2"></i>No teams match the current filter.</div>`;
    return;
  }

  visible.forEach(team => {
    const r = checkResults[team.id] || { status: 'checking', files: [] };
    const repoUrl = `https://github.com/${team.repo}`;

    const memberList = team.members.map(m =>
      `<li class="list-group-item d-flex justify-content-between py-1 px-0 border-0 bg-transparent">
        <span><i class="bi bi-person me-1 text-muted"></i>${m.name}</span>
        <code class="text-muted small">${m.studentId}</code>
      </li>`
    ).join('');

    const extra = r.status === 'error'
      ? `<div class="mt-2 small text-danger"><i class="bi bi-exclamation-triangle me-1"></i>${r.message || 'Unknown error'}</div>`
      : (r.files?.length
          ? `<div class="mt-3 pt-3 border-top">
               <div class="small fw-semibold text-muted mb-1">Deliverables</div>
               ${fileChecklist(r.files)}
               ${r.latestDate ? `<div class="text-muted mt-2" style="font-size:.75rem">
                 <i class="bi bi-clock-history me-1"></i>Last push: ${fmtDate(r.latestDate)}</div>` : ''}
             </div>` : '');

    grid.innerHTML += `
      <div class="col-sm-6 col-xl-4">
        <div class="team-card card h-100">
          <div class="card-header d-flex align-items-center justify-content-between px-3 py-2">
            <span class="fw-bold">${team.name}</span>
            ${statusBadge(r.status)}
          </div>
          <div class="card-body p-3">
            <ul class="list-group mb-2">${memberList}</ul>
            <a href="${repoUrl}" target="_blank" class="btn btn-outline-secondary btn-sm w-100 mt-1">
              <i class="bi bi-github me-1"></i>${team.repo}
            </a>
            ${extra}
          </div>
        </div>
      </div>`;
  });
}

/* ── Render table view ──────────────────────────────────── */
function renderTable() {
  const visible = filteredTeams();
  const tbody = el('tableBody');
  tbody.innerHTML = '';

  visible.forEach(team => {
    const r = checkResults[team.id] || { status: 'checking', files: [] };
    const repoUrl = `https://github.com/${team.repo}`;
    const members = team.members.map(m => `${m.name} (${m.studentId})`).join(', ');

    const filesHtml = (r.files || []).map(f =>
      f.found
        ? `<a href="${f.htmlUrl}" target="_blank" class="badge bg-success-subtle text-success text-decoration-none me-1">${f.label}</a>`
        : `<span class="badge bg-danger-subtle text-danger me-1">${f.label} ✗</span>`
    ).join('');

    tbody.innerHTML += `
      <tr>
        <td class="fw-semibold">${team.name}</td>
        <td class="small text-muted">${members}</td>
        <td><a href="${repoUrl}" target="_blank" class="text-decoration-none small">
          <i class="bi bi-github me-1"></i>${team.repo}</a></td>
        <td>${statusBadge(r.status)}</td>
        <td>${filesHtml || '—'}</td>
        <td class="small">${fmtDate(r.latestDate)}</td>
      </tr>`;
  });

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No teams match the current filter.</td></tr>`;
  }
}

/* ── Filter + render ────────────────────────────────────── */
function filteredTeams() {
  return allTeams.filter(team => {
    const r = checkResults[team.id];
    const matchStatus =
      statusFilter === 'all' ||
      (statusFilter === 'complete' && r?.status === 'complete') ||
      (statusFilter === 'partial'  && r?.status === 'partial') ||
      (statusFilter === 'missing'  && (!r || ['missing','no-repo','checking'].includes(r.status)));
    const q = searchQuery.toLowerCase();
    const matchSearch = !q ||
      team.name.toLowerCase().includes(q) ||
      team.repo.toLowerCase().includes(q) ||
      team.members.some(m => m.name.toLowerCase().includes(q) || m.studentId.toLowerCase().includes(q));
    return matchStatus && matchSearch;
  });
}

function render() {
  if (currentView === 'grid') {
    el('gridView').classList.remove('d-none');
    el('tableView').classList.add('d-none');
    renderGrid();
  } else {
    el('gridView').classList.add('d-none');
    el('tableView').classList.remove('d-none');
    renderTable();
  }
}

/* ── Check all teams ────────────────────────────────────── */
async function checkAll() {
  el('btnCheck').disabled = true;
  el('btnCheck').innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Checking…';

  allTeams.forEach(t => { checkResults[t.id] = { status: 'checking', files: [] }; });
  updateStats();
  render();

  const queue = [...allTeams];
  const concurrency = 3;

  async function worker() {
    while (queue.length) {
      const team = queue.shift();
      checkResults[team.id] = await checkRepo(team);
      updateStats();
      render();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, allTeams.length) }, worker));

  el('btnCheck').disabled = false;
  el('btnCheck').innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Refresh Status';
  el('lastChecked').textContent = 'Last checked: ' + new Date().toLocaleTimeString();
}

/* ── Init ───────────────────────────────────────────────── */
async function init() {
  try {
    const res = await fetch('teams.json');
    if (!res.ok) throw new Error('Cannot load teams.json');
    teamsData = await res.json();
    allTeams  = teamsData.teams || [];
  } catch (e) {
    el('authOverlay').classList.add('d-none');
    el('gridView').innerHTML = `<div class="col-12"><div class="alert alert-danger">
      <strong>Error loading teams.json:</strong> ${e.message}</div></div>`;
    return;
  }

  await initAuth(teamsData.dashboardPasswordHash || null);

  // Course info
  const c = teamsData.course || {};
  el('courseTitle').textContent = c.name || 'Database Course';
  el('courseMeta').textContent  = [c.code, c.semester, c.department].filter(Boolean).join(' · ');
  if (teamsData.deadline) {
    const d = new Date(teamsData.deadline);
    el('deadlineVal').textContent = d.toLocaleDateString('en-US', {
      year:'numeric', month:'long', day:'numeric'
    }) + ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    if (new Date(teamsData.deadline) < new Date()) el('deadlineVal').classList.add('text-danger');
  }

  // Required files legend
  const req = teamsData.requiredFiles || [];
  if (req.length) {
    el('reqFilesList').innerHTML = req.map(f =>
      `<code class="me-2">${f.path}</code>`
    ).join('');
  }

  // Token UI
  if (githubToken) {
    el('tokenInput').value = githubToken;
    el('tokenStatus').innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Token loaded</span>';
  }

  // Controls
  el('btnCheck').addEventListener('click', checkAll);
  el('tokenSave').addEventListener('click', () => {
    githubToken = el('tokenInput').value.trim();
    localStorage.setItem('gh_token', githubToken);
    el('tokenStatus').innerHTML = githubToken
      ? '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Token saved</span>'
      : '<span class="text-muted">No token</span>';
  });
  el('tokenClear').addEventListener('click', () => {
    githubToken = '';
    el('tokenInput').value = '';
    localStorage.removeItem('gh_token');
    el('tokenStatus').innerHTML = '<span class="text-muted">Token cleared</span>';
  });
  el('viewGrid').addEventListener('click', () => {
    currentView = 'grid';
    el('viewGrid').classList.add('active');
    el('viewTable').classList.remove('active');
    render();
  });
  el('viewTable').addEventListener('click', () => {
    currentView = 'table';
    el('viewTable').classList.add('active');
    el('viewGrid').classList.remove('active');
    render();
  });
  el('statusFilter').addEventListener('change', e => { statusFilter = e.target.value; render(); });
  el('searchInput').addEventListener('input',  e => { searchQuery  = e.target.value;  render(); });
  el('exportBtn').addEventListener('click', exportCSV);

  updateStats();
  render();
  checkAll();
}

/* ── Export CSV ─────────────────────────────────────────── */
function exportCSV() {
  const req = teamsData.requiredFiles || [];
  const headers = ['Team','Members','Student IDs','Repository','Status',
    ...req.map(f => f.label), 'Last Push'];
  const rows = [headers];

  allTeams.forEach(team => {
    const r = checkResults[team.id] || {};
    const fileStatuses = req.map(f => {
      const found = (r.files || []).find(x => x.path === f.path);
      return found?.found ? 'Yes' : 'No';
    });
    rows.push([
      team.name,
      team.members.map(m => m.name).join('; '),
      team.members.map(m => m.studentId).join('; '),
      `https://github.com/${team.repo}`,
      r.status || 'unknown',
      ...fileStatuses,
      r.latestDate || ''
    ]);
  });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'db2026-submissions.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── Util ───────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

document.addEventListener('DOMContentLoaded', init);
