'use strict';

/* ── State ──────────────────────────────────────────────── */
let allTeams = [];
let teamsData = {};
let githubToken = localStorage.getItem('gh_token') || '';
let currentView = 'grid';
let statusFilter = 'all';
let searchQuery = '';
let checkResults = {};   // teamId → result object

/* ── GitHub API ─────────────────────────────────────────── */
function apiHeaders() {
  const h = { 'Accept': 'application/vnd.github+json' };
  if (githubToken) h['Authorization'] = `Bearer ${githubToken}`;
  return h;
}

async function checkRepo(repo) {
  const filename = teamsData.filename || 'termproject.pdf';
  const base = `https://api.github.com/repos/${repo}`;

  try {
    // Check if file exists
    const fileRes = await fetch(`${base}/contents/${filename}`, { headers: apiHeaders() });

    if (fileRes.status === 404) {
      // Repo may exist but file is missing — or repo itself is missing
      const repoRes = await fetch(base, { headers: apiHeaders() });
      if (repoRes.status === 404) return { status: 'no-repo' };
      return { status: 'missing' };
    }

    if (!fileRes.ok) {
      const remaining = fileRes.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') return { status: 'error', message: 'API rate limit reached. Add a token.' };
      return { status: 'error', message: `HTTP ${fileRes.status}` };
    }

    const fileData = await fileRes.json();

    // Get commit date for this file
    let submittedAt = null;
    try {
      const commitRes = await fetch(
        `${base}/commits?path=${filename}&per_page=1`,
        { headers: apiHeaders() }
      );
      if (commitRes.ok) {
        const commits = await commitRes.json();
        if (commits.length) submittedAt = commits[0].commit.committer.date;
      }
    } catch (_) {}

    return {
      status: 'submitted',
      size: fileData.size,
      sha: fileData.sha,
      downloadUrl: fileData.download_url,
      htmlUrl: fileData.html_url,
      submittedAt
    };

  } catch (e) {
    return { status: 'error', message: e.message };
  }
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
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function statusBadge(status) {
  const map = {
    submitted: ['status-submitted', '<i class="bi bi-check-circle-fill me-1"></i>Submitted'],
    missing:   ['status-missing',   '<i class="bi bi-x-circle-fill me-1"></i>Not Submitted'],
    checking:  ['status-checking',  '<i class="bi bi-hourglass-split me-1"></i>Checking…'],
    error:     ['status-error',     '<i class="bi bi-exclamation-circle me-1"></i>Error'],
    'no-repo': ['status-no-repo',   '<i class="bi bi-question-circle me-1"></i>Repo Not Found'],
  };
  const [cls, label] = map[status] || map.error;
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function deadlinePassed() {
  return teamsData.deadline && new Date(teamsData.deadline) < new Date();
}

/* ── Summary stats ──────────────────────────────────────── */
function updateStats() {
  const total = allTeams.length;
  const submitted = allTeams.filter(t => checkResults[t.id]?.status === 'submitted').length;
  const missing   = allTeams.filter(t => checkResults[t.id]?.status === 'missing').length;
  const pending   = allTeams.filter(t => !checkResults[t.id] || checkResults[t.id].status === 'checking').length;

  el('statTotal').textContent     = total;
  el('statSubmitted').textContent = submitted;
  el('statMissing').textContent   = missing;
  el('statPending').textContent   = pending;

  const pct = total ? Math.round((submitted / total) * 100) : 0;
  el('progressBar').style.width   = pct + '%';
  el('progressPct').textContent   = pct + '%';
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
    const r = checkResults[team.id] || { status: 'checking' };
    const repoUrl = `https://github.com/${team.repo}`;
    const fileUrl = r.htmlUrl || `${repoUrl}/blob/main/${teamsData.filename}`;

    const memberList = team.members.map(m =>
      `<li class="list-group-item d-flex justify-content-between py-1 px-0 border-0 bg-transparent">
        <span><i class="bi bi-person me-1 text-muted"></i>${m.name}</span>
        <code class="text-muted small">${m.studentId}</code>
      </li>`
    ).join('');

    const extraInfo = r.status === 'submitted' ? `
      <div class="mt-3 pt-3 border-top small text-muted">
        <div><i class="bi bi-file-earmark-pdf me-1"></i>Size: <strong>${fmtBytes(r.size)}</strong></div>
        <div><i class="bi bi-clock-history me-1"></i>Submitted: <strong>${fmtDate(r.submittedAt)}</strong></div>
        <a href="${fileUrl}" target="_blank" class="btn btn-sm btn-outline-success mt-2 w-100">
          <i class="bi bi-eye me-1"></i>View PDF on GitHub
        </a>
      </div>` : (r.status === 'error' ? `
      <div class="mt-2 small text-danger"><i class="bi bi-exclamation-triangle me-1"></i>${r.message || 'Unknown error'}</div>` : '');

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
            ${extraInfo}
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
    const r = checkResults[team.id] || { status: 'checking' };
    const repoUrl = `https://github.com/${team.repo}`;
    const fileUrl = r.htmlUrl || `${repoUrl}/blob/main/${teamsData.filename}`;

    const members = team.members.map(m => `${m.name} (${m.studentId})`).join(', ');

    const pdfLink = r.status === 'submitted'
      ? `<a href="${fileUrl}" target="_blank" class="btn btn-outline-success btn-sm">
           <i class="bi bi-eye me-1"></i>View
         </a>` : '—';

    tbody.innerHTML += `
      <tr>
        <td class="fw-semibold">${team.name}</td>
        <td class="small text-muted">${members}</td>
        <td><a href="${repoUrl}" target="_blank" class="text-decoration-none small"><i class="bi bi-github me-1"></i>${team.repo}</a></td>
        <td>${statusBadge(r.status)}</td>
        <td class="small">${fmtBytes(r.size)}</td>
        <td class="small">${fmtDate(r.submittedAt)}</td>
        <td>${pdfLink}</td>
      </tr>`;
  });

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">No teams match the current filter.</td></tr>`;
  }
}

/* ── Filter + render ────────────────────────────────────── */
function filteredTeams() {
  return allTeams.filter(team => {
    const r = checkResults[team.id];
    const matchStatus = statusFilter === 'all' || (r && r.status === statusFilter) ||
      (statusFilter === 'missing' && (!r || r.status === 'missing' || r.status === 'no-repo'));
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

  // Reset to checking state
  allTeams.forEach(t => { checkResults[t.id] = { status: 'checking' }; });
  updateStats();
  render();

  // Check concurrently (max 4 at a time to avoid rate limit)
  const queue = [...allTeams];
  const concurrency = 4;

  async function worker() {
    while (queue.length) {
      const team = queue.shift();
      const result = await checkRepo(team.repo);
      checkResults[team.id] = result;
      updateStats();
      render();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, allTeams.length) }, worker);
  await Promise.all(workers);

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
    allTeams = teamsData.teams || [];
  } catch (e) {
    el('gridView').innerHTML = `<div class="col-12"><div class="alert alert-danger">
      <strong>Error loading teams.json:</strong> ${e.message}</div></div>`;
    return;
  }

  // Course info
  const c = teamsData.course || {};
  el('courseTitle').textContent = c.name || 'Database Course';
  el('courseMeta').textContent  = [c.code, c.semester, c.department].filter(Boolean).join(' · ');
  if (teamsData.deadline) {
    const d = new Date(teamsData.deadline);
    el('deadlineVal').textContent = d.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
    if (deadlinePassed()) el('deadlineVal').classList.add('text-danger');
  }

  // Token UI
  if (githubToken) {
    el('tokenInput').value = githubToken;
    el('tokenStatus').innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Token loaded</span>';
  }

  // Wire controls
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

  el('statusFilter').addEventListener('change', e => {
    statusFilter = e.target.value;
    render();
  });
  el('searchInput').addEventListener('input', e => {
    searchQuery = e.target.value;
    render();
  });
  el('exportBtn').addEventListener('click', exportCSV);

  updateStats();
  render();
  checkAll();
}

/* ── Export CSV ─────────────────────────────────────────── */
function exportCSV() {
  const rows = [['Team', 'Members', 'Student IDs', 'Repository', 'Status', 'File Size', 'Submitted At']];
  allTeams.forEach(team => {
    const r = checkResults[team.id] || {};
    rows.push([
      team.name,
      team.members.map(m => m.name).join('; '),
      team.members.map(m => m.studentId).join('; '),
      `https://github.com/${team.repo}`,
      r.status || 'unknown',
      fmtBytes(r.size),
      r.submittedAt || ''
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'db2026-submissions.csv'; a.click();
  URL.revokeObjectURL(url);
}

/* ── Util ───────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

document.addEventListener('DOMContentLoaded', init);
