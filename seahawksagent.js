import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import http from "http";

// ============================================================================
// CONFIGURATION
// ============================================================================
//
// Adapted from the Blue Jays / MLB version of this agent. Same architecture
// (poll loop -> parse game state -> detect key moments -> ask Claude for a
// post -> hold for approval on the dashboard -> post to Bluesky), swapped
// onto the NFL / Seattle Seahawks, using ESPN's public (unofficial, no key
// required) NFL scoreboard + summary endpoints in place of the MLB Stats API.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLUESKY_USERNAME = process.env.BLUESKY_USERNAME;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE || "likeablechelsey.com";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "gohawks";
const PORT = parseInt(process.env.PORT || "3000");

// Model that writes the post text. Override with ANTHROPIC_MODEL if needed.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const TEAM_NAME = "Seattle Seahawks";
const TEAM_CITY = "Seattle";
const TEAM_HASHTAG = "#GoHawks";
const SENTIMENT_QUERY = "Seattle Seahawks";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MAX_POSTS = 7;
const POLL_INTERVALS = {
  waiting: 5 * 60 * 1000,
  preview: 60 * 1000,
  live: 30 * 1000,
  final: 5 * 60 * 1000,
};

// ============================================================================
// SHARED STATE
// ============================================================================

const state = {
  phase: "waiting",       // waiting | preview | live | final | no-game
  game: null,             // raw scoreboard event for this week's Seahawks game
  gameState: null,        // parsed { scores, quarter, clock, down/distance, ... }
  pendingPost: null,      // { text, generatedAt }
  recentPosts: [],        // last 5 approved posts
  vibe: "",
  fanSentiment: [],
  postCount: 0,
  lastPlayIndex: 0,
  lastQuarterPosted: 0,
  lastUpdated: null,
  error: null,
};

// ============================================================================
// BLUESKY API
// ============================================================================

let blueskySession = null;

async function blueskyLogin() {
  const res = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: BLUESKY_USERNAME, password: BLUESKY_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bluesky login failed (${res.status}): ${body || res.statusText}`);
  }
  blueskySession = await res.json();
  console.log("Logged into Bluesky as", blueskySession.handle || BLUESKY_USERNAME);
}

async function blueskyRefreshSession() {
  if (!blueskySession?.refreshJwt) {
    await blueskyLogin();
    return;
  }
  try {
    const res = await fetch("https://bsky.social/xrpc/com.atproto.server.refreshSession", {
      method: "POST",
      headers: { Authorization: `Bearer ${blueskySession.refreshJwt}` },
    });
    if (!res.ok) throw new Error("refresh failed");
    const data = await res.json();
    blueskySession = { ...blueskySession, ...data };
    console.log("Refreshed Bluesky session token");
  } catch {
    console.log("Token refresh failed — re-logging in");
    await blueskyLogin();
  }
}

function detectHashtagsAndCreateFacets(text) {
  const facets = [];
  const encoder = new TextEncoder();
  const regex = /#[a-zA-Z][a-zA-Z0-9_]*/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const tag = match[0].slice(1);
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return facets;
}

async function postToBluesky(text) {
  if (!blueskySession) await blueskyLogin();

  if (text.length > 300) text = text.slice(0, 297) + "...";

  const facets = detectHashtagsAndCreateFacets(text);
  const record = {
    text,
    createdAt: new Date().toISOString(),
    ...(facets.length > 0 ? { facets } : {}),
  };

  const res = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${blueskySession.accessJwt}`,
    },
    body: JSON.stringify({ repo: blueskySession.did, collection: "app.bsky.feed.post", record }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const isExpired = res.status === 401 || body.includes("ExpiredToken");
    if (isExpired) {
      await blueskyRefreshSession();
      return postToBluesky(text);
    }
    throw new Error(`Failed to post: ${body}`);
  }
  return await res.json();
}

async function fetchMyPosts() {
  if (!blueskySession) return [];
  try {
    const res = await fetch(
      `https://bsky.social/xrpc/app.bsky.feed.getAuthorFeed?actor=${BLUESKY_HANDLE}&limit=8&filter=posts_no_replies`,
      { headers: { Authorization: `Bearer ${blueskySession.accessJwt}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || body.includes("ExpiredToken")) await blueskyRefreshSession();
      return [];
    }
    const data = await res.json();
    return (data.feed || [])
      .map((item) => ({
        text: item.post?.record?.text || "",
        postedAt: item.post?.record?.createdAt || item.post?.indexedAt || new Date().toISOString(),
        uri: item.post?.uri || "",
      }))
      .filter((p) => p.text.length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function fetchFanSentiment() {
  if (!blueskySession) return [];
  try {
    const res = await fetch(
      `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(SENTIMENT_QUERY)}&limit=15&sort=latest`,
      { headers: { Authorization: `Bearer ${blueskySession.accessJwt}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || body.includes("ExpiredToken")) {
        await blueskyRefreshSession();
      }
      return [];
    }
    const data = await res.json();
    return (data.posts || [])
      .map((p) => p.record?.text || "")
      .filter((t) => t.length > 0 && t.length < 200)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ============================================================================
// ESPN NFL API
// (public, unofficial, no key required — same one used by espn.com/nfl)
// ============================================================================

const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_SUMMARY_URL = (eventId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`;

// ESPN's edge (Akamai) rejects bare programmatic user agents with a 403, so
// every request goes out looking like a browser hitting espn.com.
const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.espn.com/nfl/scoreboard",
  Origin: "https://www.espn.com",
};

// Mirrors of the same data. If the primary host blocks us, fall through.
const SCOREBOARD_HOSTS = [
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
];
const SUMMARY_HOSTS = [
  (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`,
  (id) => `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`,
];

// GET with browser headers, retrying transient failures. Logs a snippet of the
// response body on failure so a block is diagnosable from the Railway logs
// rather than just a bare status code.
async function espnFetch(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: ESPN_HEADERS });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      lastErr = new Error(
        `${res.status} ${res.statusText} — ${body.slice(0, 160).replace(/\s+/g, " ")}`
      );
      // Retry rate limits and server errors; a hard 4xx won't fix itself.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw lastErr;
}

// Try each mirror in turn; only give up when every one has failed.
async function espnFetchAny(urls, label) {
  const errors = [];
  for (const url of urls) {
    try {
      return await espnFetch(url);
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error(`${label} failed — ${errors.join(" | ")}`);
}

// Calling this with no date params returns the *current NFL week's* games,
// which is exactly what we want for a once-a-week team like the Seahawks
// (there's no "today's game" the way there is for a daily MLB schedule).
async function fetchScoreboard() {
  const res = await espnFetchAny(SCOREBOARD_HOSTS, "ESPN scoreboard fetch");
  return await res.json();
}

async function findSeahawksGameThisWeek() {
  const data = await fetchScoreboard();
  const events = data.events || [];
  return (
    events.find((e) => {
      const comp = e.competitions?.[0];
      return comp?.competitors?.some((c) => c.team?.displayName === TEAM_NAME);
    }) || null
  );
}

// Re-fetch the scoreboard each poll and pull out just our game's competition
// object — cheap, and gives us live score/quarter/clock without touching the
// much heavier play-by-play summary endpoint more than necessary.
async function refreshCompetitionFromScoreboard(gameId) {
  const data = await fetchScoreboard();
  const event = (data.events || []).find((e) => e.id === gameId);
  return event?.competitions?.[0] || null;
}

async function fetchGameSummary(gameId) {
  let res;
  try {
    res = await espnFetchAny(SUMMARY_HOSTS.map((f) => f(gameId)), "ESPN summary fetch");
  } catch (err) {
    console.error("Summary fetch failed:", err.message);
    return null;
  }
  const data = await res.json();
  return data.boxscore || null;
}

// Flatten every play out of every drive (previous + current, if present) and
// sort by ESPN's own sequenceNumber so we get true chronological order
// regardless of how the API happens to order the drives array.
function extractPlays(boxscore) {
  if (!boxscore?.drives) return [];
  const drives = [...(boxscore.drives.previous || [])];
  if (boxscore.drives.current) drives.push(boxscore.drives.current);
  const plays = drives.flatMap((d) => d.plays || []);
  plays.sort((a, b) => Number(a.sequenceNumber || 0) - Number(b.sequenceNumber || 0));
  return plays;
}

// ============================================================================
// GAME STATE PARSING
// ============================================================================

function ordinalPeriod(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  if (n === 4) return "4th";
  return n > 4 ? "OT" : `${n}th`;
}

function parseGameState(competition, plays) {
  const competitors = competition.competitors || [];
  const seahawksC = competitors.find((c) => c.team?.displayName === TEAM_NAME);
  const opponentC = competitors.find((c) => c.team?.displayName !== TEAM_NAME);
  if (!seahawksC || !opponentC) return null;

  const seahawksTeamId = seahawksC.id;
  const opponentTeamId = opponentC.id;
  const isAway = seahawksC.homeAway === "away";

  const status = competition.status || {};
  const quarter = status.period || 0;
  const clock = status.displayClock || "";
  const abstractState = status.type?.state || "pre"; // pre | in | post
  const statusDetail = status.type?.shortDetail || status.type?.detail || "";

  const latestPlay = plays.length > 0 ? plays[plays.length - 1] : null;
  const end = latestPlay?.end;

  const downDistanceText = end?.downDistanceText || end?.shortDownDistanceText || "";
  const possessionText = end?.possessionText || "";
  const yardsToEndzone = typeof end?.yardsToEndzone === "number" ? end.yardsToEndzone : null;
  const possessionTeamId = end?.team?.id || null;
  const isRedZone = yardsToEndzone !== null && yardsToEndzone > 0 && yardsToEndzone <= 20;
  const isSeahawksPossession = possessionTeamId === seahawksTeamId;

  const recentPlays = plays
    .slice(-5)
    .reverse()
    .map((p) => p.text || "")
    .filter(Boolean);

  return {
    abstractState,
    statusDetail,
    seahawksScore: parseInt(seahawksC.score || "0", 10),
    opponentScore: parseInt(opponentC.score || "0", 10),
    opponent: opponentC.team?.displayName || "Opponent",
    quarter,
    clock,
    downDistanceText,
    possessionText,
    isRedZone,
    isSeahawksPossession,
    recentPlays,
    isAway,
    seahawksTeamId,
    opponentTeamId,
  };
}

// ============================================================================
// MOMENTUM ANALYSIS
// ============================================================================

let previousSeahawksScore = null;
let previousOpponentScore = null;
let firstLivePoll = true;

// Id of the most recently finished game. Kept so the agent doesn't re-arm on a
// game it has already wrapped up, while still rolling over to next week's game.
let completedGameId = null;

// Clear per-game counters so the next game starts from a clean slate.
function resetForNextGame(finishedId) {
  completedGameId = finishedId ?? completedGameId;
  state.game = null;
  state.gameState = null;
  state.pendingPost = null;
  state.postCount = 0;
  state.lastPlayIndex = 0;
  state.lastQuarterPosted = 0;
  state.vibe = "";
  state.fanSentiment = [];
  state.phase = "waiting";
  previousSeahawksScore = null;
  previousOpponentScore = null;
  firstLivePoll = true;
}

function analyzeMomentum(gameState) {
  let momentum = "";

  if (previousSeahawksScore !== null) {
    const seaDelta = gameState.seahawksScore - previousSeahawksScore;
    const oppDelta = gameState.opponentScore - previousOpponentScore;

    if (seaDelta > 0)
      momentum = `${TEAM_CITY} scores! (+${seaDelta})`;
    else if (oppDelta > 0)
      momentum = "Opponent scores...";
  }

  previousSeahawksScore = gameState.seahawksScore;
  previousOpponentScore = gameState.opponentScore;

  return {
    momentum,
    differential: gameState.seahawksScore - gameState.opponentScore,
  };
}

// ============================================================================
// KEY PLAY DETECTION
// ============================================================================

// Priority order — lower index = more exciting
const KEY_PLAY_PRIORITY = [
  "Touchdown",
  "Interception",
  "Fumble",
  "Blocked Kick",
  "Field Goal",
  "Safety",
  "Sack",
  "Big Play",
];

const BIG_PLAY_YARDS = 20;

function classifyPlay(play, seahawksTeamId) {
  const typeText = (play.type?.text || "").toLowerCase();
  const bodyText = (play.text || "").toUpperCase();
  const isScoring = !!play.scoringPlay;
  const isTurnover = !!play.isTurnover;
  const yards = typeof play.statYardage === "number" ? play.statYardage : 0;

  const offenseTeamId = play.start?.team?.id || null; // team that had the ball entering the play
  const newPossessionTeamId = play.end?.team?.id || null; // team with the ball after the play

  let category = null;
  let favorable = null; // true = good for Seattle, false = bad for Seattle

  if (isScoring) {
    if (bodyText.includes("TOUCHDOWN") || typeText.includes("touchdown")) {
      category = "Touchdown";
    } else if (typeText.includes("field goal")) {
      category = "Field Goal";
    } else if (bodyText.includes("SAFETY")) {
      category = "Safety";
    } else {
      category = "Touchdown"; // 2pt conversions, etc. — treat as a scoring headline
    }
    // Whoever the play's own team context credits gets it; approximate via
    // possession after the play (covers pick-sixes / fumble return TDs too).
    favorable = (newPossessionTeamId || offenseTeamId) === seahawksTeamId;
  } else if (isTurnover) {
    category = typeText.includes("fumble") ? "Fumble" : "Interception";
    // Turnover flips possession — whoever HAS it now is the team that just won the play.
    favorable = newPossessionTeamId === seahawksTeamId;
  } else if (typeText.includes("blocked")) {
    category = "Blocked Kick";
    favorable = offenseTeamId !== seahawksTeamId; // blocking the OTHER team's kick is good
  } else if (typeText === "sack") {
    category = "Sack";
    favorable = offenseTeamId !== seahawksTeamId; // sacking the other team's QB is good
  } else if (yards >= BIG_PLAY_YARDS) {
    category = "Big Play";
    favorable = offenseTeamId === seahawksTeamId; // Seattle's offense broke off a big gain
  }

  return category ? { category, favorable, play } : null;
}

function findKeyPlay(plays, fromIndex, seahawksTeamId) {
  const newPlays = plays.slice(fromIndex);
  if (newPlays.length === 0) return null;

  const classified = newPlays
    .map((p) => classifyPlay(p, seahawksTeamId))
    .filter(Boolean);
  if (classified.length === 0) return null;

  classified.sort(
    (a, b) => KEY_PLAY_PRIORITY.indexOf(a.category) - KEY_PLAY_PRIORITY.indexOf(b.category)
  );
  const top = classified[0];

  return {
    category: top.category,
    favorable: top.favorable,
    description: top.play.text || "",
    yards: top.play.statYardage || 0,
  };
}

// ============================================================================
// CLAUDE AI POST GENERATION
// ============================================================================

async function generateFanReactionPost(gameState, momentum, fanSentiment, keyPlay = null, vibe = "") {
  const diff = momentum.differential;
  const situation =
    diff > 0 ? `up by ${diff}` : diff < 0 ? `down by ${Math.abs(diff)}` : "tied";
  const isCheckIn = !momentum.momentum && !keyPlay;

  let eventContext = "";
  if (keyPlay) {
    const tone = keyPlay.favorable ? "GOOD FOR SEATTLE" : "BAD FOR SEATTLE";
    eventContext = `KEY PLAY [${keyPlay.category} — ${tone}]: ${keyPlay.description}`;
  } else if (momentum.momentum) {
    eventContext = `JUST HAPPENED: ${momentum.momentum}`;
  } else {
    eventContext = "CONTEXT: Just tuned in mid-game — write a check-in post about the current situation";
  }

  const situationLine = gameState.downDistanceText
    ? `SITUATION: ${gameState.downDistanceText}${gameState.isRedZone ? " (red zone!)" : ""}, ${
        gameState.isSeahawksPossession ? "Seattle has the ball" : `${gameState.opponent} has the ball`
      }`
    : "";

  const prompt = `You are a witty, sarcastic female Seahawks fan from Seattle posting live game updates to Bluesky. Authentic, Pacific Northwest, family-friendly.

GAME: Seattle vs ${gameState.opponent}
SCORE: Seattle ${gameState.seahawksScore} - ${gameState.opponent} ${gameState.opponentScore} (${situation})
QUARTER: ${ordinalPeriod(gameState.quarter)} | ${gameState.clock}${gameState.statusDetail ? ` (${gameState.statusDetail})` : ""}
${situationLine}
${eventContext}
RECENT PLAYS:
${gameState.recentPlays
  .slice(0, 3)
  .map((p) => `- ${p}`)
  .join("\n")}
${vibe ? `\nGAME VIBE (use this to set the tone and emotional colour of your post):\n${vibe}` : ""}${
  fanSentiment.length > 0
    ? `\nFAN VIBES:\n${fanSentiment
        .slice(0, 2)
        .map((s) => `- ${s}`)
        .join("\n")}`
    : ""
}

Write a single Bluesky post. 1-2 sentences, under 260 characters (you need room for ${TEAM_HASHTAG}). Use "Seattle" rather than nicknames when referring to the team. Use emojis freely — lean on 💚💙🏈 especially. Always end with ${TEAM_HASHTAG}.${isCheckIn ? " Sound like you just turned on the game and are catching up." : ""}

Reply with ONLY the post text.`;

  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
}

// ============================================================================
// VIBE ANALYSIS
// ============================================================================

function updateVibe(gameState, plays) {
  const playTexts = plays
    .slice(-20)
    .map((p) => p.text || "")
    .join(" ")
    .toLowerCase();

  const vibes = [];
  if (playTexts.includes("touchdown")) vibes.push("Touchdown energy in the air");
  if (playTexts.includes("sack")) vibes.push("Pass rush is getting home");
  if (playTexts.includes("intercept")) vibes.push("Turnovers swinging the game");
  if (playTexts.includes("fumble")) vibes.push("Ball security is an adventure today");
  if (playTexts.includes("punt")) vibes.push("Both offenses are stuck in the mud");
  if (gameState.isRedZone) vibes.push(`${gameState.isSeahawksPossession ? "Seattle" : gameState.opponent} in the red zone`);

  const diff = gameState.seahawksScore - gameState.opponentScore;
  if (diff >= 10) vibes.push("Seattle pulling away");
  else if (diff <= -10) vibes.push("Seattle in comeback mode");
  else vibes.push("Tight game, anything can happen");

  state.vibe = vibes.slice(0, 2).join(". ");
}

// ============================================================================
// DASHBOARD HTML
// ============================================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDashboard() {
  const gs = state.gameState;

  const phaseLabel = {
    waiting: "WAITING",
    preview: "PREVIEW",
    live: "LIVE",
    final: "FINAL",
    "no-game": "NO GAME",
  }[state.phase] || state.phase.toUpperCase();

  const phaseClass = `phase-${state.phase.replace("-", "")}`;

  function fieldHtml(gs) {
    // Ball position as % of a 100-yard field, measured from Seattle's own
    // goal line, computed from yardsToEndzone of whichever team has it.
    // We don't have that raw number on gameState (only in the latest play),
    // so this reads possessionText/downDistanceText directly instead of
    // trying to re-derive an exact yard marker — simpler and always correct
    // even when the API omits a field we'd need to compute a precise %.
    return `
      <div class="situation-wrap">
        <div class="situation-main">${escapeHtml(gs.downDistanceText || "—")}</div>
        <div class="situation-sub">
          <span class="poss-dot ${gs.isSeahawksPossession ? "poss-sea" : "poss-opp"}"></span>
          ${gs.isSeahawksPossession ? "Seattle" : escapeHtml(gs.opponent)} ball
          ${gs.possessionText ? ` · ${escapeHtml(gs.possessionText)}` : ""}
          ${gs.isRedZone ? `<span class="redzone-badge">RED ZONE</span>` : ""}
        </div>
      </div>`;
  }

  const scoreHtml = gs
    ? `<div class="score-board">
        <div class="team">
          <div class="team-name">Seattle</div>
          <div class="score">${gs.seahawksScore}</div>
        </div>
        <div class="vs">vs</div>
        <div class="team">
          <div class="team-name">${escapeHtml(gs.opponent)}</div>
          <div class="score">${gs.opponentScore}</div>
        </div>
      </div>
      <div class="inning">${ordinalPeriod(gs.quarter)} quarter | ${escapeHtml(gs.clock)}${gs.statusDetail ? ` · ${escapeHtml(gs.statusDetail)}` : ""}</div>
      ${state.phase === "live" ? fieldHtml(gs) : ""}`
    : `<div class="empty-msg">${state.phase === "no-game" ? "No Seahawks game this week" : "Waiting for game data..."}</div>`;

  const pendingHtml = state.pendingPost
    ? `<div class="pending-post">
        <div class="pending-label">PENDING POST</div>
        <textarea id="post-edit" class="post-edit" maxlength="300" oninput="updateCharCount(this)">${escapeHtml(state.pendingPost.text)}</textarea>
        <div class="char-count"><span id="char-count">${state.pendingPost.text.length}</span> / 300</div>
        <div class="post-actions">
          <button class="btn-approve" onclick="approvePost()">Approve + Post</button>
          <button class="btn-reject" onclick="rejectPost()">Reject</button>
        </div>
      </div>`
    : `<div class="empty-msg">No pending posts</div>`;

  const recentHtml =
    state.recentPosts.length > 0
      ? state.recentPosts
          .map((p) => {
            const bskyUrl = p.uri
              ? (() => {
                  const parts = p.uri.replace("at://", "").split("/");
                  const rkey = parts[2];
                  return `https://bsky.app/profile/${BLUESKY_HANDLE}/post/${rkey}`;
                })()
              : null;
            const time = new Date(p.postedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            return `<div class="recent-post">
              <span class="recent-text">${escapeHtml(p.text)}</span>
              <span class="post-time">${bskyUrl ? `<a href="${bskyUrl}" target="_blank" rel="noopener" style="color:#69be28;text-decoration:none;">${time} ↗</a>` : time}</span>
            </div>`;
          })
          .join("")
      : `<div class="empty-msg">No posts yet this game</div>`;

  const sentimentHtml =
    state.fanSentiment.length > 0
      ? state.fanSentiment
          .map((t) => `<div class="sentiment-item">${escapeHtml(t)}</div>`)
          .join("")
      : `<div class="empty-msg">No fan posts found</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Seahawks Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0e14; color: #e0e6f0; font-family: 'Inter', sans-serif; min-height: 100vh; }

    header {
      background: #002244;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      border-bottom: 1px solid #0a3a66;
    }
    header h1 { font-family: 'Bebas Neue', sans-serif; font-size: 26px; letter-spacing: 2px; color: #fff; }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

    .phase-live       { background: #0a3a1a; color: #7dfc9e; border: 1px solid #2fa84f; }
    .phase-live .dot  { background: #69be28; animation: blink 1.2s ease-in-out infinite; }
    .phase-preview       { background: #2a1e00; color: #f0c040; border: 1px solid #c08800; }
    .phase-preview .dot  { background: #f0a500; }
    .phase-waiting       { background: #141c28; color: #88a0bb; border: 1px solid #33506a; }
    .phase-waiting .dot  { background: #556f88; }
    .phase-final       { background: #0a1830; color: #88aaff; border: 1px solid #3366cc; }
    .phase-final .dot  { background: #4488ff; }
    .phase-nogame       { background: #111; color: #666; border: 1px solid #333; }
    .phase-nogame .dot  { background: #444; }

    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

    .last-updated { margin-left: auto; font-size: 11px; color: #fff; }

    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .full-width { grid-column: 1 / -1; }

    @media (max-width: 640px) {
      main {
        grid-template-columns: 1fr;
        padding: 12px;
        gap: 12px;
      }
      .full-width { grid-column: 1; }
      header {
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 14px;
      }
      header h1 { font-size: 20px; }
      .card { padding: 14px; }
    }

    .card {
      background: #111c27;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #1a2b40;
    }
    .card-title {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 17px;
      letter-spacing: 1.5px;
      color: #69be28;
      margin-bottom: 14px;
    }

    /* Score */
    .score-board { display: flex; align-items: center; justify-content: center; gap: 24px; margin-bottom: 10px; }
    .team { text-align: center; }
    .team-name { font-size: 12px; color: #7799aa; margin-bottom: 2px; }
    .score { font-family: 'Bebas Neue', sans-serif; font-size: 56px; color: #fff; line-height: 1; }
    .vs { font-size: 16px; color: #445; }
    .inning { text-align: center; font-size: 12px; color: #7799aa; margin-top: 2px; }
    .empty-msg { color: #445; font-size: 13px; padding: 12px 0; text-align: center; }

    /* Situation (down & distance / possession) */
    .situation-wrap {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid #1a2b40;
      text-align: center;
    }
    .situation-main {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 24px;
      letter-spacing: 1px;
      color: #e0e6f0;
    }
    .situation-sub {
      margin-top: 6px;
      font-size: 12px;
      color: #8899aa;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .poss-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .poss-sea { background: #69be28; }
    .poss-opp { background: #6a7a8a; }
    .redzone-badge {
      background: #3a0a0a; color: #ff7070; border: 1px solid #cc3333;
      font-size: 10px; letter-spacing: 1px; padding: 2px 8px; border-radius: 10px;
      margin-left: 4px;
    }

    /* Pending post */
    .pending-post { background: #0c2018; border-radius: 8px; padding: 16px; border: 1px solid #1a4a2c; }
    .pending-label { font-size: 10px; color: #69be28; letter-spacing: 1.5px; margin-bottom: 10px; }
    .post-actions { display: flex; gap: 10px; }
    .post-edit {
      width: 100%; background: #071410; color: #ddffdd; border: 1px solid #2a6a3a;
      border-radius: 6px; padding: 12px; font-size: 15px; font-family: 'Inter', sans-serif;
      line-height: 1.6; resize: vertical; min-height: 80px; margin-bottom: 6px;
      outline: none;
    }
    .post-edit:focus { border-color: #69be28; }
    .char-count { font-size: 11px; color: #445; text-align: right; margin-bottom: 10px; }
    .char-count.over { color: #dd5555; }

    .btn-approve {
      background: #14401e; color: #66dd88; border: 1px solid #226633;
      padding: 8px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;
    }
    .btn-approve:hover { background: #1a5228; }
    .btn-reject {
      background: #3a1010; color: #dd7070; border: 1px solid #882222;
      padding: 8px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;
    }
    .btn-reject:hover { background: #4a1818; }
    .posts-counter { font-size: 11px; color: #334; text-align: right; margin-top: 10px; }

    /* Recent posts */
    .recent-post {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 10px; padding: 9px 0; border-bottom: 1px solid #1a2b40; font-size: 13px;
    }
    .recent-post:last-child { border-bottom: none; }
    .recent-text { color: #c8d8e8; line-height: 1.4; }
    .post-time { font-size: 11px; color: #445; white-space: nowrap; flex-shrink: 0; padding-top: 2px; }

    /* Vibe */
    .vibe-text { font-size: 14px; line-height: 1.7; color: #b0d8c4; }

    /* Fan sentiment */
    .sentiment-item {
      font-size: 13px; color: #8899aa; line-height: 1.5;
      padding: 7px 0; border-bottom: 1px solid #1a2b40;
    }
    .sentiment-item:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <header>
    <h1>Seahawks Agent</h1>
    <span class="status-pill ${phaseClass}"><span class="dot"></span>${phaseLabel}</span>
    <span class="last-updated" id="ts">${state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString() : "--"}</span>
  </header>
  <main>
    <div class="card">
      <div class="card-title">Score</div>
      ${scoreHtml}
    </div>
    <div class="card">
      <div class="card-title">Game Vibe</div>
      ${state.vibe ? `<div class="vibe-text">${escapeHtml(state.vibe)}</div>` : `<div class="empty-msg">Analyzing...</div>`}
    </div>
    <div class="card full-width">
      <div class="card-title">Pending Post</div>
      ${pendingHtml}
      <div class="posts-counter">${state.postCount} / ${MAX_POSTS} posts used this game</div>
    </div>
    <div class="card">
      <div class="card-title">Recent Posts</div>
      ${recentHtml}
    </div>
    <div class="card">
      <div class="card-title">What Fans Are Saying</div>
      ${sentimentHtml}
    </div>
  </main>

  <script>
    const pw = sessionStorage.getItem("pw") || "";

    async function apiFetch(path, opts = {}) {
      return fetch(path, {
        ...opts,
        headers: { ...(opts.headers || {}), "X-Dashboard-Password": pw },
      });
    }

    async function checkAuth() {
      const r = await apiFetch("/api/state");
      if (r.status === 401) {
        const entered = prompt("Dashboard password:");
        if (entered) { sessionStorage.setItem("pw", entered); location.reload(); }
      }
    }

    function updateCharCount(el) {
      const counter = document.getElementById("char-count");
      if (!counter) return;
      counter.textContent = el.value.length;
      counter.parentElement.classList.toggle("over", el.value.length > 300);
    }

    async function approvePost() {
      const textarea = document.getElementById("post-edit");
      const text = textarea ? textarea.value.trim() : null;
      if (text !== null && text.length === 0) return;
      const btn = document.querySelector(".btn-approve");
      if (btn) { btn.disabled = true; btn.textContent = "Posting..."; }
      try {
        const r = await apiFetch("/api/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          alert("Post failed: " + (data.error || r.status));
          if (btn) { btn.disabled = false; btn.textContent = "Approve + Post"; }
          return;
        }
      } catch (e) {
        alert("Network error: " + e.message);
        if (btn) { btn.disabled = false; btn.textContent = "Approve + Post"; }
        return;
      }
      location.reload();
    }

    async function rejectPost() {
      await apiFetch("/api/reject", { method: "POST" });
      location.reload();
    }

    async function refreshTimestamp() {
      const r = await apiFetch("/api/state");
      if (!r.ok) return;
      const data = await r.json();
      if (data.lastUpdated) {
        document.getElementById("ts").textContent = new Date(data.lastUpdated).toLocaleTimeString();
      }
      const hasPending = !!data.pendingPost;
      const showingPending = document.querySelector(".pending-post") !== null;
      if (hasPending !== showingPending) location.reload();
    }

    setInterval(refreshTimestamp, 5000);
    checkAuth();
  </script>
</body>
</html>`;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

function checkDashboardAuth(req) {
  return (req.headers["x-dashboard-password"] || "") === DASHBOARD_PASSWORD;
}

function serveDashboard() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method;

    if (pathname === "/" || pathname === "") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard());
      return;
    }

    if (!checkDashboardAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (pathname === "/api/state" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (pathname === "/api/approve" && method === "POST") {
      if (!state.pendingPost) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No pending post" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const post = state.pendingPost;
        state.pendingPost = null;

        let text = post.text;
        try {
          const parsed = JSON.parse(body);
          if (parsed.text && typeof parsed.text === "string") text = parsed.text.trim();
        } catch {}

        postToBluesky(text)
          .then(() => {
            state.recentPosts.unshift({ text, postedAt: new Date().toISOString() });
            if (state.recentPosts.length > 5) state.recentPosts.pop();
            state.postCount++;
            state.error = null;
            console.log(`Posted (${state.postCount}/${MAX_POSTS}): "${text}"`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch((err) => {
            console.error("Post failed:", err.message);
            state.pendingPost = post;
            state.error = err.message;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          });
      });
      return;
    }

    if (pathname === "/api/reject" && method === "POST") {
      state.pendingPost = null;
      console.log("Post rejected");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
}

// ============================================================================
// MAIN POLL LOOP
// ============================================================================

async function poll() {
  try {
    state.lastUpdated = new Date().toISOString();

    if (!state.game) {
      state.game = await findSeahawksGameThisWeek();
      if (!state.game) {
        console.log("No Seahawks game found for the current NFL week");
        state.phase = "no-game";
        return;
      }
      if (state.game.id === completedGameId) {
        // Same game we already wrapped; wait for the schedule to roll forward.
        console.log("Current week's game already covered — waiting for the next one");
        state.game = null;
        state.phase = "waiting";
        return;
      }
      console.log(`Found game: ${state.game.name}`);
    }

    const gameId = state.game.id;
    const competition = await refreshCompetitionFromScoreboard(gameId);
    if (!competition) {
      state.phase = "preview";
      return;
    }

    const abstractState = competition.status?.type?.state || "pre";

    if (abstractState === "pre") {
      state.phase = "preview";
      return;
    }

    const boxscore = await fetchGameSummary(gameId);
    const plays = extractPlays(boxscore);
    const gs = parseGameState(competition, plays);
    if (!gs) {
      state.error = "Could not parse game state (team match failed)";
      return;
    }
    state.gameState = gs;

    if (abstractState === "post") {
      state.phase = "final";
      if (!state.pendingPost && state.postCount < MAX_POSTS) {
        const result =
          gs.seahawksScore > gs.opponentScore
            ? "Win!"
            : gs.seahawksScore < gs.opponentScore
            ? "Tough loss."
            : "A tie.";
        state.pendingPost = {
          text: `Final: Seattle ${gs.seahawksScore}, ${gs.opponent} ${gs.opponentScore}. ${result} ${TEAM_HASHTAG}`,
          generatedAt: new Date().toISOString(),
        };
      }
      return;
    }

    state.phase = "live";
    updateVibe(gs, plays);

    const joiningMidGame = firstLivePoll && (gs.seahawksScore + gs.opponentScore > 0);
    if (firstLivePoll) {
      firstLivePoll = false;
      [state.fanSentiment, state.recentPosts] = await Promise.all([
        fetchFanSentiment(),
        fetchMyPosts(),
      ]);
    } else if (Math.random() < 0.3) {
      state.fanSentiment = await fetchFanSentiment();
      state.recentPosts = await fetchMyPosts();
    }

    const momentum = analyzeMomentum(gs);
    const keyPlay = findKeyPlay(plays, state.lastPlayIndex, gs.seahawksTeamId);
    state.lastPlayIndex = plays.length;

    const newQuarter = gs.quarter > state.lastQuarterPosted;
    const shouldQueue =
      (momentum.momentum !== "" || joiningMidGame || keyPlay !== null || newQuarter) &&
      !state.pendingPost &&
      state.postCount < MAX_POSTS;

    if (shouldQueue) {
      state.lastQuarterPosted = gs.quarter;
      const reason = joiningMidGame
        ? "Joining mid-game"
        : keyPlay
        ? `Key play: ${keyPlay.category}`
        : newQuarter
        ? `${ordinalPeriod(gs.quarter)} quarter check-in`
        : momentum.momentum;
      console.log(`${reason} — generating post...`);
      const text = await generateFanReactionPost(gs, momentum, state.fanSentiment, keyPlay, state.vibe);
      if (text) {
        state.pendingPost = { text, generatedAt: new Date().toISOString() };
        console.log(`Queued for approval: "${text}"`);
      }
    }
  } catch (err) {
    state.error = err.message;
    console.error("Poll error:", err.message);
  }
}

async function runPollLoop() {
  await poll();

  // Once a game is final and its wrap-up post has been dealt with, stand down
  // and start watching for next week's game rather than exiting the loop.
  if (state.phase === "final" && !state.pendingPost) {
    const finishedId = state.game?.id ?? null;
    console.log("Game wrapped — standing by for next week's matchup");
    resetForNextGame(finishedId);
  }

  const interval = POLL_INTERVALS[state.phase] || POLL_INTERVALS.waiting;
  setTimeout(runPollLoop, interval);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  console.log("Seattle Seahawks Bluesky Agent v1.0 (NFL / ESPN)");

  try {
    await blueskyLogin();
  } catch (err) {
    console.error("FATAL: Bluesky login failed at startup —", err.message);
    console.error("Check BLUESKY_USERNAME and BLUESKY_PASSWORD environment variables.");
    process.exit(1);
  }

  serveDashboard();
  await runPollLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});