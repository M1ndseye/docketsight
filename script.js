// Each visitor connects their own free CourtListener token. It's saved only in their browser.
// (For local testing you can also put one in config.js, which .gitignore keeps off GitHub.)
const TOKEN_KEY = "docketsight-courtlistener-token";
const CONTACT_EMAIL = "steve.mindseye@gmail.com";
const SAMPLE = window.DOCKETSIGHT_SAMPLE || { results: [] };

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function getToken() {
  const fromConfig = window.COURTLISTENER_TOKEN && window.COURTLISTENER_TOKEN !== "YOUR_COURTLISTENER_TOKEN"
    ? window.COURTLISTENER_TOKEN : "";
  return readStoredToken() || fromConfig;
}

function saveToken(token) {
  try {
    token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private window: token lasts until the page closes */
  }
  sessionToken = token;
}

let sessionToken = "";
const isLive = () => Boolean(sessionToken || getToken());
const API_URL = "https://www.courtlistener.com/api/rest/v4/search/";
const SITE_URL = "https://www.courtlistener.com";
const NEW_CASE_DAYS = 90; // "New & open" = filed in the last 90 days and not closed

// Every state and its courts, from courts.js
const COURTS_BY_STATE = window.DOCKETSIGHT_COURTS || {};
const FEDERAL = "Federal (nationwide)";

const LEVELS = {
  S: "State supreme court",
  SA: "State appeals & trial courts",
  FD: "Federal trial (district) courts",
  F: "Federal appeals & U.S. Supreme Court",
};
// Federal cases (RECAP dockets) only exist in federal courts
const LEVELS_FOR_SOURCE = { r: ["FD", "F"], o: ["S", "SA", "FD", "F"] };

// Common PACER "nature of suit" categories → the words CourtListener stores
const SUIT_TYPES = [
  ["Civil rights", "Civil Rights"],
  ["Employment discrimination", "Civil Rights: Jobs"],
  ["Disability (ADA)", "Americans with Disabilities"],
  ["Prisoner / prison conditions", "Prisoner"],
  ["Habeas corpus", "Habeas Corpus"],
  ["Contract", "Contract"],
  ["Insurance", "Insurance"],
  ["Personal injury", "Personal Injury"],
  ["Product liability", "Product Liability"],
  ["Labor & wages", "Labor"],
  ["Consumer credit", "Consumer Credit"],
  ["Securities", "Securities"],
  ["Patent", "Patent"],
  ["Copyright", "Copyright"],
  ["Trademark", "Trademark"],
  ["Immigration", "Immigration"],
  ["Real property", "Real Property"],
  ["Social Security", "Social Security"],
  ["Fraud", "Fraud"],
  ["Bankruptcy appeal", "Bankruptcy"],
];

// Common federal causes of action (the law the case is filed under)
const CAUSES = [
  ["42 U.S.C. 1983 · Civil rights", "42:1983"],
  ["42 U.S.C. 2000e · Job discrimination", "42:2000"],
  ["42 U.S.C. 12101 · Americans with Disabilities Act", "42:12101"],
  ["29 U.S.C. 201 · Fair Labor Standards Act (wages)", "29:201"],
  ["29 U.S.C. 1132 · ERISA (benefits)", "29:1132"],
  ["15 U.S.C. 1692 · Fair Debt Collection", "15:1692"],
  ["47 U.S.C. 227 · Robocalls (TCPA)", "47:227"],
  ["35 U.S.C. 271 · Patent infringement", "35:271"],
  ["17 U.S.C. 501 · Copyright infringement", "17:501"],
  ["15 U.S.C. 1125 · Trademark (Lanham Act)", "15:1125"],
  ["28 U.S.C. 1332 · Diversity (state-law claims)", "28:1332"],
  ["28 U.S.C. 1331 · Federal question", "28:1331"],
  ["28 U.S.C. 1441 · Removed from state court", "28:1441"],
  ["28 U.S.C. 2254 · State prisoner habeas", "28:2254"],
  ["28 U.S.C. 2241 · Federal habeas", "28:2241"],
  ["42 U.S.C. 405 · Social Security review", "42:405"],
];

// Look up a court's state from its ID (for the export)
const STATE_BY_COURT = {};
Object.entries(COURTS_BY_STATE).forEach(([state, courts]) => courts.forEach((c) => (STATE_BY_COURT[c.id] = state)));

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const form = $("search-form");
const searchInput = $("search-input");
const list = $("case-list");
const loadingEl = $("loading");
const statusEl = $("status");
const titleEl = $("results-title");
const countEl = $("results-count");
const noteEl = $("filters-note");
const loadMoreBtn = $("load-more");
const clearBtn = $("clear-filters");
const sourceInputs = document.querySelectorAll('input[name="source"]');
const firmOnly = $("firm-only");
const exportBtn = $("export-leads");

const stateSelect = $("state-filter");
const levelSelect = $("level-filter");
const courtSelect = $("court-filter");
const stageSelect = $("stage-filter");
const suitSelect = $("suit-filter");
const causeSelect = $("cause-filter");
const judgeSelect = $("judge-filter");
const sortSelect = $("sort-filter");
const filterSelects = [stateSelect, levelSelect, courtSelect, stageSelect, suitSelect, causeSelect, judgeSelect];
const docketOnlySelects = [stageSelect, suitSelect, causeSelect, judgeSelect];

let cases = [];       // every normalized result loaded for the current search
let nextUrl = null;   // CourtListener's link to the next page of results
let totalCount = 0;   // how many matches exist in total
let lastQuery = "";
let judgeCounts = {}; // judges seen in loaded results, for the Judge dropdown

// ---------- Helpers ----------
function getSource() {
  return document.querySelector('input[name="source"]:checked').value; // "r" federal cases, "o" opinions
}

function isDockets() {
  return getSource() === "r";
}

// Wrap a value in quotes for an exact-phrase search
function phrase(value) {
  return `"${String(value).replace(/"/g, "")}"`;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// ---------- Build the search ----------
// Court IDs allowed by State + Court level + Court (null = no court limit)
function selectedCourtIds() {
  if (courtSelect.value !== "all") return [courtSelect.value];

  const level = levelSelect.value !== "all" ? levelSelect.value : null;
  const state = stateSelect.value !== "all" ? stateSelect.value : null;
  if (!state && !level) return null; // search every court

  const pool = state ? COURTS_BY_STATE[state] || [] : Object.values(COURTS_BY_STATE).flat();
  return pool
    .filter((c) => LEVELS_FOR_SOURCE[getSource()].includes(c.level))
    .filter((c) => !level || c.level === level)
    .map((c) => c.id);
}

function buildSearchUrl(query) {
  const parts = [query ? `(${query})` : "*"];

  const ids = selectedCourtIds();
  if (ids) parts.push(`court_id:(${ids.length ? ids.join(" OR ") : "none"})`);

  if (isDockets()) {
    if (stageSelect.value === "new") {
      parts.push(`dateFiled:[${isoDaysAgo(NEW_CASE_DAYS)} TO *]`, "-dateTerminated:[* TO *]");
    } else if (stageSelect.value === "open") {
      parts.push("-dateTerminated:[* TO *]");
    } else if (stageSelect.value === "closed") {
      parts.push("dateTerminated:[* TO *]");
    }
    if (suitSelect.value !== "all") parts.push(`suitNature:${phrase(suitSelect.value)}`);
    if (causeSelect.value !== "all") parts.push(`cause:${phrase(causeSelect.value)}`);
    if (judgeSelect.value !== "all") parts.push(`assignedTo:${phrase(judgeSelect.value)}`);
    if (firmOnly.checked) parts.push("firm:*");
  }

  const params = new URLSearchParams({ q: parts.join(" AND "), type: getSource() });
  if (sortSelect.value === "NEWEST") params.set("order_by", "dateFiled desc");
  if (sortSelect.value === "OLDEST") params.set("order_by", "dateFiled asc");
  return `${API_URL}?${params}`;
}

// ---------- Fetch ----------
function authHeaders() {
  const token = sessionToken || getToken();
  return token ? { Authorization: `Token ${token}` } : {};
}

async function requestPage(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) {
    throw new Error("CourtListener didn't accept that token. Check it and connect again (top of the page).");
  }
  if (res.status === 429) {
    throw new Error("CourtListener allows 5 searches a minute. Wait about a minute, then try again.");
  }
  if (!res.ok) throw new Error(`The court database returned an error (${res.status}).`);
  return res.json();
}

function friendlyError(error) {
  return error.message === "Failed to fetch"
    ? "Couldn't reach CourtListener. Check your connection and API token, then try again."
    : error.message;
}

// Run a search from page 1. A brand-new search from the search bar resets the filters.
async function fetchCases(query, { reset = false } = {}) {
  lastQuery = query;
  if (reset) resetFilters();
  cases = [];
  nextUrl = null;
  if (judgeSelect.value === "all") judgeCounts = {};
  list.innerHTML = "";
  countEl.textContent = "";
  loadMoreBtn.hidden = true;
  updateFilterUI();
  updateSampleNotice();
  showLoading(true);

  try {
    const data = isLive() ? await requestPage(buildSearchUrl(query)) : sampleSearch(query);
    titleEl.textContent = query ? `Results for “${query}”` : isDockets() ? "Federal cases" : "Court opinions";
    addResults(data);
    if (!cases.length) {
      renderCases();
      showStatus("No cases match. Try different keywords or loosen a filter.");
      return;
    }
    renderCases();
  } catch (error) {
    showStatus(friendlyError(error));
  } finally {
    showLoading(false);
    loadMoreBtn.hidden = !nextUrl;
  }
}

// ---------- Sample mode (no token) ----------
// Filters the bundled snapshot of real dockets the same way the live search would
function sampleSearch(query) {
  updateSampleNotice();
  if (!isDockets()) return { count: 0, next: null, results: [] };

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ids = selectedCourtIds();
  const newSince = isoDaysAgo(NEW_CASE_DAYS);
  const has = (text, needle) => String(text || "").toLowerCase().includes(String(needle).toLowerCase());

  let results = SAMPLE.results.filter((x) => {
    const haystack = [x.caseName, x.court, x.assignedTo, x.suitNature, x.cause, ...(x.firm || []), ...(x.attorney || [])].join(" ");
    if (words.length && !words.every((w) => has(haystack, w))) return false;
    if (ids && !ids.includes(x.court_id)) return false;
    if (stageSelect.value === "new" && (x.dateTerminated || x.dateFiled < newSince)) return false;
    if (stageSelect.value === "open" && x.dateTerminated) return false;
    if (stageSelect.value === "closed" && !x.dateTerminated) return false;
    if (suitSelect.value !== "all" && !has(x.suitNature, suitSelect.value)) return false;
    if (causeSelect.value !== "all" && !has(x.cause, causeSelect.value)) return false;
    if (judgeSelect.value !== "all" && x.assignedTo !== judgeSelect.value) return false;
    if (firmOnly.checked && !(x.firm || []).length) return false;
    return true;
  });

  if (sortSelect.value === "NEWEST") results.sort((a, b) => b.dateFiled.localeCompare(a.dateFiled));
  if (sortSelect.value === "OLDEST") results.sort((a, b) => a.dateFiled.localeCompare(b.dateFiled));
  return { count: results.length, next: null, results };
}

function updateSampleNotice() {
  const notice = $("sample-notice");
  if (isLive()) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.textContent = isDockets()
    ? `Sample mode: ${SAMPLE.results.length} real federal cases captured ${formatDate(SAMPLE.capturedOn)}. Connect your free CourtListener token above to search millions of live cases.`
    : "Court opinions need a live connection. Connect your free CourtListener token above, or switch back to Federal cases.";
}

// ---------- Token panel ----------
function renderTokenPanel() {
  const live = isLive();
  $("token-status").innerHTML = live
    ? `<span class="token__dot"></span> Live search connected · <button type="button" class="token__change" id="token-change">change token</button>`
    : "You're viewing sample data. Connect a free CourtListener token for live search:";
  $("token-form").hidden = live;
  $("token-help").hidden = live;
  $("disconnect-token").hidden = !readStoredToken();
  const change = $("token-change");
  if (change) change.addEventListener("click", () => {
    $("token-form").hidden = false;
    $("token-help").hidden = false;
    $("token-input").focus();
  });
}

$("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("token-input").value.trim();
  if (!token) return;
  saveToken(token);
  $("token-input").value = "";
  renderTokenPanel();
  updateSampleNotice();
  rerun();
});

$("disconnect-token").addEventListener("click", (event) => {
  event.preventDefault();
  saveToken("");
  renderTokenPanel();
  rerun();
});

// "Load more": add the next page to what's already loaded
async function loadMore() {
  if (!nextUrl) return;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";
  try {
    addResults(await requestPage(nextUrl));
    renderCases();
  } catch (error) {
    showStatus(friendlyError(error));
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more results";
    loadMoreBtn.hidden = !nextUrl;
  }
}

function addResults(data) {
  const fresh = (data.results || []).map(normalize);
  cases = cases.concat(fresh);
  nextUrl = data.next || null;
  totalCount = data.count ?? cases.length;
  fresh.forEach((c) => {
    if (c.judge) judgeCounts[c.judge] = (judgeCounts[c.judge] || 0) + 1;
  });
  buildJudgeOptions();
}

// Opinions and dockets come back in slightly different shapes; make them one shape
function normalize(item) {
  const snippet = item.opinions?.[0]?.snippet || item.recap_documents?.[0]?.snippet || "";
  const link = item.absolute_url || item.docket_absolute_url || "";
  const filed = item.dateFiled || "";
  const closed = item.dateTerminated || "";
  const daysOld = filed ? (Date.now() - new Date(filed + "T00:00:00")) / 86400000 : Infinity;

  return {
    name: item.caseName || "Untitled case",
    court: item.court || item.court_citation_string || "Unknown court",
    state: STATE_BY_COURT[item.court_id] || "",
    firms: unique(item.firm),
    attorneys: unique(item.attorney),
    date: filed,
    closed,
    isNew: isDockets() && !closed && daysOld <= NEW_CASE_DAYS,
    judge: item.assignedTo || item.judge || "",
    suit: item.suitNature || "",
    cause: item.cause || "",
    jury: item.juryDemand && item.juryDemand !== "None" ? item.juryDemand : "",
    docket: item.docketNumber || "",
    citation: Array.isArray(item.citation) ? item.citation[0] : "",
    snippet: stripTags(snippet),
    url: link ? SITE_URL + link : SITE_URL,
  };
}

// Firm and attorney lists can repeat the same name; keep each once
function unique(list) {
  return Array.isArray(list) ? [...new Set(list.map((x) => String(x).trim()).filter(Boolean))] : [];
}

// Show up to 3 names, then "+N more"
function shortList(names, max = 3) {
  if (names.length <= max) return names.join("; ");
  return `${names.slice(0, max).join("; ")} +${names.length - max} more`;
}

// ---------- Dropdown options ----------
function optionsHTML(pairs) {
  return pairs.map(([label, value]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join("");
}

function buildStaticOptions() {
  const states = Object.keys(COURTS_BY_STATE).sort((a, b) => {
    if (a === FEDERAL) return 1; // keep "Federal" at the bottom
    if (b === FEDERAL) return -1;
    return a.localeCompare(b);
  });
  stateSelect.innerHTML = `<option value="all">All states</option>` + optionsHTML(states.map((s) => [s, s]));
  suitSelect.innerHTML = `<option value="all">Any type of case</option>` + optionsHTML(SUIT_TYPES);
  causeSelect.innerHTML = `<option value="all">Any cause</option>` + optionsHTML(CAUSES);
}

// Court level choices depend on what we're searching (federal cases have no state courts)
function buildLevelOptions() {
  const current = levelSelect.value;
  const levels = LEVELS_FOR_SOURCE[getSource()];
  levelSelect.innerHTML = `<option value="all">All levels</option>` + optionsHTML(levels.map((l) => [LEVELS[l], l]));
  levelSelect.value = levels.includes(current) ? current : "all";
}

// Court list = the chosen state's courts, narrowed by Court level
function buildCourtOptions() {
  if (stateSelect.value === "all") {
    courtSelect.innerHTML = `<option value="all">Pick a state first</option>`;
    courtSelect.disabled = true;
    return;
  }
  const current = courtSelect.value;
  const courts = (COURTS_BY_STATE[stateSelect.value] || [])
    .filter((c) => LEVELS_FOR_SOURCE[getSource()].includes(c.level))
    .filter((c) => levelSelect.value === "all" || c.level === levelSelect.value);

  courtSelect.disabled = !courts.length;
  courtSelect.innerHTML = courts.length
    ? `<option value="all">All ${courts.length} courts</option>` + optionsHTML(courts.map((c) => [c.name, c.id]))
    : `<option value="all">No courts at this level</option>`;
  courtSelect.value = courts.some((c) => c.id === current) ? current : "all";
}

// Judges come from the cases loaded so far; picking one searches all of that judge's cases
function buildJudgeOptions() {
  const current = judgeSelect.value;
  const judges = Object.keys(judgeCounts).sort((a, b) => judgeCounts[b] - judgeCounts[a] || a.localeCompare(b));
  if (current !== "all" && !judges.includes(current)) judges.unshift(current);
  judgeSelect.innerHTML =
    `<option value="all">${judges.length ? `Any judge (${judges.length} in results)` : "Any judge"}</option>` +
    optionsHTML(judges.map((j) => [judgeCounts[j] ? `${j} (${judgeCounts[j]})` : j, j]));
  judgeSelect.value = judges.includes(current) ? current : "all";
}

// Show docket-only filters only when searching federal cases
function updateFilterUI() {
  const dockets = isDockets();
  document.querySelectorAll("[data-dockets-only]").forEach((el) => (el.hidden = !dockets));
  noteEl.textContent = dockets
    ? "Case stage, nature of suit, cause and judge come from federal court dockets (PACER, via RECAP)."
    : "Court opinions don't record judge, nature of suit or cause. Switch to Federal cases for those filters.";
  const active = filterSelects.filter((s) => dockets || !docketOnlySelects.includes(s));
  clearBtn.hidden = !active.some((s) => s.value !== "all") && !(dockets && firmOnly.checked);
  exportBtn.hidden = !cases.length;
}

function resetFilters() {
  filterSelects.forEach((select) => (select.value = "all"));
  firmOnly.checked = false;
  sortSelect.value = "DEFAULT";
  judgeCounts = {};
  buildLevelOptions();
  buildCourtOptions();
  buildJudgeOptions();
}

// ---------- Render ----------
// Newest/Oldest are sorted by CourtListener; name sorts re-arrange what's loaded
function sortedCases() {
  const results = [...cases];
  if (sortSelect.value === "A_TO_Z") results.sort((a, b) => a.name.localeCompare(b.name));
  if (sortSelect.value === "Z_TO_A") results.sort((a, b) => b.name.localeCompare(a.name));
  return results;
}

function renderCases() {
  const results = sortedCases();

  updateFilterUI();
  const withFirms = cases.filter((c) => c.firms.length).length;
  countEl.textContent = cases.length
    ? `Showing ${cases.length.toLocaleString()} of ${totalCount.toLocaleString()} matches` +
      (isDockets() ? ` · ${withFirms} with a law firm listed` : "")
    : "";

  if (!results.length) {
    list.innerHTML = "";
    return;
  }
  hideStatus();
  list.innerHTML = results.map(caseHTML).join("");
}

function formatDate(date) {
  if (!date) return "";
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function caseHTML(c, index) {
  const docket = isDockets();
  const stage = !docket ? "" : c.isNew ? "New · Open" : c.closed ? `Closed ${formatDate(c.closed)}` : "Open";
  const stageClass = c.isNew ? "tag--new" : c.closed ? "tag--closed" : "tag--open";

  return `
    <article class="case" style="animation-delay:${index * 30}ms">
      <div class="case__top">
        <span class="case__court">${escapeHTML(c.court)}</span>
        <span class="case__date">${c.date ? `Filed ${formatDate(c.date)}` : "Filing date unknown"}</span>
      </div>
      <h3 class="case__name"><a href="${c.url}" target="_blank" rel="noopener">${escapeHTML(c.name)}</a></h3>
      ${c.judge ? `<p class="case__judge">Judge ${escapeHTML(c.judge)}</p>` : ""}
      ${c.firms.length
        ? `<p class="case__lead"><span>Firms</span> ${escapeHTML(shortList(c.firms))}</p>`
        : docket ? `<p class="case__lead case__lead--empty"><span>Firms</span> No firm listed yet</p>` : ""}
      ${c.attorneys.length ? `<p class="case__lead"><span>Attorneys</span> ${escapeHTML(shortList(c.attorneys))}</p>` : ""}
      ${c.suit || c.cause ? `<p class="case__detail">${escapeHTML([c.suit, c.cause].filter(Boolean).join(" · "))}</p>` : ""}
      ${c.snippet ? `<p class="case__snippet">${escapeHTML(c.snippet)}</p>` : ""}
      <div class="case__meta">
        ${stage ? `<span class="tag ${stageClass}">${stage}</span>` : ""}
        ${c.firms.length ? `<span class="tag tag--firm">Firm listed</span>` : ""}
        ${c.jury ? `<span class="tag">Jury demand: ${escapeHTML(c.jury)}</span>` : ""}
        ${c.citation ? `<span class="tag">${escapeHTML(c.citation)}</span>` : ""}
        ${c.docket ? `<span class="tag">No. ${escapeHTML(c.docket)}</span>` : ""}
      </div>
      <div class="case__actions">
        ${needsVisuals(c) ? `<a class="case__visualize" href="${visualizeLink(c)}">Visualize this case in 3D</a>` : ""}
        <a class="case__link" href="${c.url}" target="_blank" rel="noopener">View on CourtListener →</a>
      </div>
    </article>`;
}

// Cases where 3D animation usually helps a jury: injuries, products, crashes, patents
function needsVisuals(c) {
  return /personal inj|product liab|medical|motor vehicle|airplane|marine|patent|wrongful death|health care/i.test(c.suit + " " + c.cause);
}

function visualizeLink(c) {
  const subject = `3D visuals for ${c.name}${c.docket ? ` (No. ${c.docket})` : ""}`;
  const body = `Hi Steve,\n\nI found this case on DocketSight and I'm interested in trial visuals:\n\n${c.name}\n${c.court}${c.docket ? `, No. ${c.docket}` : ""}\n${c.url}\n\nWhat I need:\n\n`;
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------- Export leads ----------
// One row per loaded case, in the order shown, as a CSV that opens in Excel or Google Sheets
function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportLeads() {
  const rows = sortedCases();
  const header = [
    "Law firms", "Attorneys", "Case name", "Court", "State", "Judge", "Nature of suit",
    "Cause", "Jury demand", "Filed", "Status", "Docket number", "CourtListener link",
  ];
  const lines = rows.map((c) => [
    c.firms.join("; "), c.attorneys.join("; "), c.name, c.court, c.state, c.judge, c.suit,
    c.cause, c.jury, c.date, c.closed ? `Closed ${c.closed}` : "Open", c.docket, c.url,
  ]);
  const csv = [header, ...lines].map((row) => row.map(csvCell).join(",")).join("\r\n");

  // Byte-order mark so Excel reads accented names correctly
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `docketsight-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// ---------- UI helpers ----------
function showLoading(isLoading) {
  loadingEl.hidden = !isLoading;
  if (isLoading) hideStatus();
}

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

function stripTags(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function escapeHTML(str = "") {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// ---------- Events ----------
const rerun = () => fetchCases(lastQuery);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  fetchCases(searchInput.value.trim(), { reset: true });
  $("results").scrollIntoView({ behavior: "smooth" });
});

sourceInputs.forEach((input) =>
  input.addEventListener("change", () => {
    buildLevelOptions();
    buildCourtOptions();
    rerun();
  })
);

stateSelect.addEventListener("change", () => {
  buildCourtOptions();
  rerun();
});
levelSelect.addEventListener("change", () => {
  buildCourtOptions();
  rerun();
});
[courtSelect, stageSelect, suitSelect, causeSelect, judgeSelect].forEach((s) => s.addEventListener("change", rerun));

// Relevance/Newest/Oldest ask CourtListener to sort; name sorts just re-arrange what's loaded
sortSelect.addEventListener("change", () => {
  ["NEWEST", "OLDEST", "DEFAULT"].includes(sortSelect.value) ? rerun() : renderCases();
});

clearBtn.addEventListener("click", () => {
  const sort = sortSelect.value;
  resetFilters();
  sortSelect.value = sort;
  rerun();
});

firmOnly.addEventListener("change", rerun);
exportBtn.addEventListener("click", exportLeads);
loadMoreBtn.addEventListener("click", loadMore);

// First load: the newest federal cases (sample mode until a token is connected)
renderTokenPanel();
buildStaticOptions();
buildLevelOptions();
buildCourtOptions();
sortSelect.value = "NEWEST";
fetchCases("");
